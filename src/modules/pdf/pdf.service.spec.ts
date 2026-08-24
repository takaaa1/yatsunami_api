import { PdfService } from './pdf.service';
import { PdfSale, PdfSaleItem } from './pdf.types';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * As linhas do recibo contra o total impresso.
 *
 * O TOTAL do recibo vem de `sale.total`, o valor que o servidor gravou. As
 * linhas acima dele — subtotal, descontos, taxa — eram recalculadas aqui, com
 * `Number` e regras próprias. Discordavam em três pontos, e o cliente via um
 * documento que se contradizia.
 *
 * Este arquivo não testa layout. Ele intercepta a definição do documento antes
 * da renderização e confere **uma coisa só**: que as linhas fecham com o total.
 */

const item = (extra: Partial<PdfSaleItem> = {}): PdfSaleItem => ({
  quantidade: 1,
  precoUnitario: 10,
  produto: { nome: { 'pt-BR': 'Bento' } },
  ...extra,
});

const venda = (extra: Partial<PdfSale> = {}): PdfSale => ({
  id: 1,
  data: '2026-08-21T12:00:00.000Z',
  total: 10,
  itens: [item()],
  ...extra,
});

/** Todo texto da definição, em ordem, sem se importar com a estrutura. */
function textos(no: unknown, saida: string[] = []): string[] {
  if (Array.isArray(no)) {
    no.forEach((filho) => textos(filho, saida));
  } else if (no !== null && typeof no === 'object') {
    const obj = no as Record<string, unknown>;
    if (typeof obj.text === 'string') saida.push(obj.text);
    Object.entries(obj).forEach(([chave, valor]) => {
      if (chave !== 'text') textos(valor, saida);
    });
  }
  return saida;
}

/** `R$ 1.234,56` → `1234.56`; devolve `null` se não for um valor. */
function valor(texto: string): number | null {
  const m = /^-?R\$\s([\d.]+,\d{2})$/.exec(texto);
  if (!m) return null;
  return Number(m[1].replace(/\./g, '').replace(',', '.'));
}

describe('PdfService — o recibo fecha', () => {
  let service: PdfService;
  let definicao: TDocumentDefinitions;

  beforeEach(async () => {
    service = new PdfService();
    jest
      .spyOn(service, 'generatePdf')
      .mockImplementation((doc: TDocumentDefinitions) => {
        definicao = doc;
        return Promise.resolve(Buffer.from(''));
      });
  });

  /**
   * Lê o bloco de totais: pares (rótulo, valor) na ordem em que aparecem, a
   * partir de "Subtotal:".
   */
  const totais = () => {
    const todos = textos(definicao.content);
    const inicio = todos.lastIndexOf('Subtotal:');
    const linhas: { rotulo: string; valor: number }[] = [];
    for (let i = inicio; i < todos.length - 1; i += 1) {
      const v = valor(todos[i + 1]);
      if (v !== null && !todos[i].startsWith('R$')) {
        linhas.push({ rotulo: todos[i], valor: v });
      }
    }
    return linhas;
  };

  const somaDasLinhas = () =>
    totais()
      .filter((l) => l.rotulo !== 'TOTAL:')
      .reduce(
        (acc, l) =>
          l.rotulo.startsWith('Desc.') ? acc - l.valor : acc + l.valor,
        0,
      );

  const totalImpresso = () =>
    totais().find((l) => l.rotulo === 'TOTAL:')?.valor ?? NaN;

  it('venda simples: as linhas somam o total', async () => {
    await service.generateSaleReceipt(
      venda({ itens: [item({ quantidade: 2, precoUnitario: 35 })], total: 70 }),
    );

    expect(somaDasLinhas()).toBeCloseTo(totalImpresso(), 2);
  });

  /**
   * Terceira divergência: `taxaEntrega` não existia neste arquivo nem no tipo,
   * mas entra no total gravado. **Falhava antes da correção** — faltava R$ 8
   * para as linhas fecharem.
   */
  it('venda com entrega mostra a taxa, e as linhas fecham', async () => {
    await service.generateSaleReceipt(
      venda({
        itens: [item({ precoUnitario: 40 })],
        taxaEntrega: 8,
        total: 48,
      }),
    );

    expect(totais().map((l) => l.rotulo)).toContain('Taxa de Entrega:');
    expect(somaDasLinhas()).toBeCloseTo(48, 2);
    expect(totalImpresso()).toBe(48);
  });

  it('venda sem entrega não inventa uma linha de taxa', async () => {
    await service.generateSaleReceipt(venda());

    expect(totais().map((l) => l.rotulo)).not.toContain('Taxa de Entrega:');
  });

  /**
   * Primeira divergência: o corte em zero é **por item**. O servidor grava 40;
   * o recibo antigo somava R$ 50 de desconto contra R$ 50 de subtotal e
   * insinuava zero, com um TOTAL de R$ 40 logo abaixo.
   */
  it('item zerado ao lado de um normal: o desconto sai efetivo', async () => {
    await service.generateSaleReceipt(
      venda({
        itens: [
          item({ precoUnitario: 10, tipoDesconto: 'fixed', valorDesconto: 50 }),
          item({ precoUnitario: 40 }),
        ],
        total: 40,
      }),
    );

    const desconto = totais().find((l) => l.rotulo === 'Desc. Itens:');
    expect(desconto?.valor).toBe(10);
    expect(somaDasLinhas()).toBeCloseTo(40, 2);
  });

  /** Segunda divergência: o corte em zero do total. */
  it('desconto geral maior que a venda não passa do total', async () => {
    await service.generateSaleReceipt(
      venda({
        itens: [item({ precoUnitario: 10 })],
        descontoGeralTipo: 'fixed',
        descontoGeralValor: 500,
        taxaEntrega: 8,
        total: 8,
      }),
    );

    const geral = totais().find((l) => l.rotulo === 'Desc. Geral:');
    expect(geral?.valor).toBe(10);
    expect(somaDasLinhas()).toBeCloseTo(8, 2);
  });
});

/**
 * O gerador de verdade, sem substituto no meio.
 *
 * Os casos acima interceptam `generatePdf` para ler a definição do documento —
 * e por isso **não exercitam o pdfmake**. Foi essa a lacuna que deixou passar o
 * `pdfDoc.on is not a function`: no pdfmake 0.3, `createPdfKitDocument` devolve
 * uma **Promise**, não o stream, e o `.on` era chamado na promessa.
 *
 * Nenhum teste de unidade pegaria isso enquanto o printer estivesse dublado. A
 * lição: quando a costura que se dubla é justamente a fronteira com a
 * biblioteca, **um caso tem de atravessá-la**.
 */
describe('PdfService.generatePdf — atravessa o pdfmake', () => {
  it('produz um PDF de verdade', async () => {
    const service = new PdfService();

    const buffer = await service.generatePdf({ content: ['teste'] });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // Todo PDF começa com esta assinatura.
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  }, 20000);

  it('o recibo de venda chega a virar arquivo', async () => {
    const service = new PdfService();

    const buffer = await service.generateSaleReceipt(
      venda({
        itens: [item({ precoUnitario: 40 })],
        taxaEntrega: 8,
        total: 48,
      }),
    );

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  }, 20000);

  /** Outro documento, outra definição — e o mesmo caminho até o pdfmake. */
  it('o resumo de encomendas também vira arquivo', async () => {
    const service = new PdfService();

    const buffer = await service.generateOrderSummary({
      date: '2026-08-21T12:00:00.000Z',
      orders: [
        {
          usuario: { nome: 'Fulano' },
          itens: [item({ quantidade: 2 }), item({ precoUnitario: 25 })],
        },
      ],
    });

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  }, 20000);
});

/**
 * A data de entrega do resumo — dia de calendário, não instante.
 *
 * `dataEntrega` é `DATE` no banco e chega como meia-noite UTC. Formatá-la sem
 * fixar o fuso lê o instante no fuso do **processo**: hoje o contêiner roda em
 * UTC e por isso o resultado sai certo por acidente. Bastaria alguém pôr
 * `TZ=America/Sao_Paulo` no compose para o resumo passar a imprimir o dia
 * anterior — que foi exatamente o defeito que apareceu no gerador do app, onde
 * o fuso é o do aparelho.
 *
 * O caso abaixo trava isso independentemente do fuso em que a suíte roda.
 */
describe('PdfService.generateOrderSummary — data de entrega', () => {
  let service: PdfService;
  let definicao: TDocumentDefinitions;

  beforeEach(() => {
    service = new PdfService();
    jest
      .spyOn(service, 'generatePdf')
      .mockImplementation((doc: TDocumentDefinitions) => {
        definicao = doc;
        return Promise.resolve(Buffer.from(''));
      });
  });

  const gerar = (date: string) =>
    service.generateOrderSummary({ date, orders: [{ itens: [item()] }] });

  it('imprime o dia do calendário, não o instante no fuso do processo', async () => {
    await gerar('2026-08-27T00:00:00.000Z');

    const linha = textos(definicao.content).find((t) =>
      t.startsWith('Data de Entrega:'),
    );
    expect(linha).toBe('Data de Entrega: 27/08/2026');
  });

  it('primeiro dia do mês não vira o mês anterior', async () => {
    await gerar('2026-09-01T00:00:00.000Z');

    const linha = textos(definicao.content).find((t) =>
      t.startsWith('Data de Entrega:'),
    );
    expect(linha).toBe('Data de Entrega: 01/09/2026');
  });
});

/**
 * O horário impresso no recibo.
 *
 * O contêiner roda em UTC. Sem fixar o fuso, uma venda das 18h em São Paulo
 * saía impressa como **21h** — e uma das 21h30 pulava para a data do dia
 * seguinte, porque `toISOString()` dá o dia em UTC.
 *
 * O negócio opera só no Brasil; ja-JP é preferência de leitura, não outro fuso.
 */
describe('PdfService.generateSaleReceipt — data e hora', () => {
  let service: PdfService;
  let definicao: TDocumentDefinitions;

  beforeEach(() => {
    service = new PdfService();
    jest
      .spyOn(service, 'generatePdf')
      .mockImplementation((doc: TDocumentDefinitions) => {
        definicao = doc;
        return Promise.resolve(Buffer.from(''));
      });
  });

  const linhaQueComeca = (prefixo: string) =>
    textos(definicao.content).find((t) => t.startsWith(prefixo));

  it('imprime a hora do Brasil, não a do processo', async () => {
    // 21h UTC = 18h em São Paulo.
    await service.generateSaleReceipt(
      venda({ data: '2026-08-27T21:00:00.000Z' }),
    );

    expect(linhaQueComeca('Data e Hora:')).toBe(
      'Data e Hora: 27/08/2026, 18:00:00',
    );
  });

  /**
   * O caso que mais dói: 21h30 no Brasil é 00h30 UTC do **dia seguinte**. As
   * duas linhas do recibo têm de concordar entre si.
   */
  it('venda da noite não pula para o dia seguinte', async () => {
    await service.generateSaleReceipt(
      venda({ data: '2026-08-28T00:30:00.000Z' }),
    );

    expect(linhaQueComeca('Data e Hora:')).toBe(
      'Data e Hora: 27/08/2026, 21:30:00',
    );
    expect(linhaQueComeca('Data:')).toBe('Data: 2026-08-27');
  });
});

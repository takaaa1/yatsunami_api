import { Prisma } from '@prisma/client';
import { resumirVenda, conferirDescontos, LinhaDeVenda } from './sale-totals';
import { DiscountType } from './dto/create-sale.dto';

/**
 * A regra de dinheiro da venda, num lugar só.
 *
 * Ela existia em duas cópias: `sales.service.ts`, que grava o total, e
 * `pdf.service.ts`, que desenhava as linhas do recibo. As duas discordavam em
 * três pontos, e o recibo era o lado errado — ele imprimia linhas que não
 * fechavam com o próprio total impresso, que vem do banco.
 *
 * O que este módulo garante, e o que nenhuma das duas cópias garantia:
 *
 *     subtotal − descontoItens − descontoGeral + taxaEntrega === total
 *
 * O corte em zero é o motivo de os descontos serem devolvidos **já efetivos**:
 * um desconto de R$ 50 num item de R$ 10 tira R$ 10, não R$ 50. Devolver o
 * valor nominal é o que fazia as contas do recibo não fecharem.
 */

const item = (extra: Partial<LinhaDeVenda> = {}): LinhaDeVenda => ({
  quantidade: 1,
  precoUnitario: 10,
  ...extra,
});

const txt = (d: Prisma.Decimal) => d.toString();

describe('resumirVenda', () => {
  describe('soma dos itens', () => {
    it('multiplica preço por quantidade', () => {
      const r = resumirVenda([item({ quantidade: 3, precoUnitario: 10 })]);

      expect(txt(r.subtotal)).toBe('30');
      expect(txt(r.total)).toBe('30');
    });

    /** `Decimal` existe para isto: `0.1 * 3` em ponto flutuante dá `0.30000000000000004`. */
    it('não acumula erro de ponto flutuante', () => {
      const r = resumirVenda([item({ quantidade: 3, precoUnitario: 0.1 })]);

      expect(txt(r.total)).toBe('0.3');
    });

    it('item sem preço não quebra a conta', () => {
      const r = resumirVenda([item({ precoUnitario: null })]);

      expect(txt(r.total)).toBe('0');
    });
  });

  describe('desconto por item', () => {
    it('percentual desconta de cada unidade', () => {
      const r = resumirVenda([
        item({
          quantidade: 2,
          precoUnitario: 100,
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: 10,
        }),
      ]);

      expect(txt(r.descontoItens)).toBe('20');
      expect(txt(r.total)).toBe('180');
    });

    it('fixo desconta por unidade, não do item inteiro', () => {
      const r = resumirVenda([
        item({
          quantidade: 3,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 5,
        }),
      ]);

      expect(txt(r.total)).toBe('15');
    });

    /**
     * O corte por item, sozinho. Este caso vivia em `sales.service.spec.ts`;
     * mudou de casa quando o serviço passou a **recusar** o desconto exagerado
     * em vez de cortá-lo. O corte segue existindo como defesa para dado que
     * chegue por outro caminho, e é aqui que ele fica guardado.
     */
    it('desconto maior que o item zera o item, não fica negativo', () => {
      const r = resumirVenda([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
      ]);

      expect(txt(r.total)).toBe('0');
      expect(txt(r.descontoItens)).toBe('10');
    });

    /**
     * Primeira divergência do recibo. O servidor corta **cada item** em zero e
     * só então soma; o PDF somava um desconto global e subtraía uma vez. Com um
     * item exagerado ao lado de um normal, o recibo comia o valor do outro.
     */
    it('item zerado não come o valor dos outros', () => {
      const r = resumirVenda([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
        item({ precoUnitario: 40 }),
      ]);

      expect(txt(r.total)).toBe('40');
      // O desconto efetivo é R$ 10 — o que o item tinha —, não os R$ 50 pedidos.
      expect(txt(r.descontoItens)).toBe('10');
      expect(txt(r.subtotal)).toBe('50');
    });
  });

  describe('desconto geral', () => {
    it('percentual incide sobre a soma já descontada', () => {
      const r = resumirVenda([item({ precoUnitario: 100 })], {
        descontoGeralTipo: DiscountType.PERCENTAGE,
        descontoGeralValor: 10,
      });

      expect(txt(r.descontoGeral)).toBe('10');
      expect(txt(r.total)).toBe('90');
    });

    it('fixo sai do total, uma vez só', () => {
      const r = resumirVenda(
        [
          item({ quantidade: 2, precoUnitario: 50 }),
          item({ precoUnitario: 20 }),
        ],
        { descontoGeralTipo: DiscountType.FIXED, descontoGeralValor: 20 },
      );

      expect(txt(r.total)).toBe('100');
    });

    it('valor zero não é tratado como desconto', () => {
      const r = resumirVenda([item()], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 0,
      });

      expect(txt(r.descontoGeral)).toBe('0');
      expect(txt(r.total)).toBe('10');
    });

    /** Segunda divergência: o corte em zero do total, que o PDF não tinha. */
    it('desconto maior que a venda zera o total, e o desconto sai efetivo', () => {
      const r = resumirVenda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
      });

      expect(txt(r.total)).toBe('0');
      expect(txt(r.descontoGeral)).toBe('10');
    });
  });

  describe('taxa de entrega', () => {
    it('é somada ao total', () => {
      const r = resumirVenda([item({ precoUnitario: 40 })], { taxaEntrega: 8 });

      expect(txt(r.total)).toBe('48');
    });

    /**
     * A taxa entra **depois** do corte em zero: se entrasse antes, um desconto
     * grande engoliria o frete e o estabelecimento pagaria a entrega do bolso.
     */
    it('sobrevive a um desconto que zera a venda', () => {
      const r = resumirVenda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
        taxaEntrega: 8,
      });

      expect(txt(r.total)).toBe('8');
    });

    /** Terceira divergência: o PDF não conhecia a taxa — nem no tipo. */
    it('aparece no resumo para o recibo poder mostrá-la', () => {
      const r = resumirVenda([item()], { taxaEntrega: 8 });

      expect(txt(r.taxaEntrega)).toBe('8');
    });
  });

  /**
   * A invariante que existe para o recibo fechar. Sem ela, o cliente vê linhas
   * que não somam o total impresso logo abaixo delas.
   */
  describe('as linhas fecham com o total', () => {
    const conferir = (r: ReturnType<typeof resumirVenda>) =>
      txt(
        r.subtotal.sub(r.descontoItens).sub(r.descontoGeral).add(r.taxaEntrega),
      );

    it('na venda simples', () => {
      const r = resumirVenda([item({ quantidade: 2, precoUnitario: 35 })]);
      expect(conferir(r)).toBe(txt(r.total));
    });

    it('com item zerado ao lado de um normal', () => {
      const r = resumirVenda([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
        item({ precoUnitario: 40 }),
      ]);
      expect(conferir(r)).toBe(txt(r.total));
    });

    it('com desconto geral que zera a venda e taxa de entrega', () => {
      const r = resumirVenda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
        taxaEntrega: 8,
      });
      expect(conferir(r)).toBe(txt(r.total));
    });

    it('com os dois descontos e taxa juntos', () => {
      const r = resumirVenda(
        [
          item({
            quantidade: 2,
            precoUnitario: 100,
            tipoDesconto: DiscountType.PERCENTAGE,
            valorDesconto: 10,
          }),
          item({ precoUnitario: 40 }),
        ],
        {
          descontoGeralTipo: DiscountType.PERCENTAGE,
          descontoGeralValor: 10,
          taxaEntrega: 7.5,
        },
      );
      expect(conferir(r)).toBe(txt(r.total));
    });
  });
});

/**
 * Desconto fixo não pode passar do que está sendo descontado.
 *
 * Antes, um desconto exagerado era **cortado em zero, em silêncio**: o operador
 * digitava R$ 50 num item de R$ 10, e a venda saía com o item zerado sem que
 * nada dissesse que os outros R$ 40 sumiram. O corte continua existindo como
 * defesa, mas agora ele é inalcançável pelo caminho normal — o pedido é
 * recusado antes.
 */
describe('conferirDescontos', () => {
  describe('desconto por item', () => {
    it('aceita desconto igual ao preço da unidade', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 10,
        }),
      ]);

      expect(p).toEqual([]);
    });

    /** O limite é o preço **da unidade**, porque o desconto fixo é por unidade. */
    it('recusa desconto maior que o preço da unidade', () => {
      const p = conferirDescontos([
        item({
          quantidade: 3,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 12,
        }),
      ]);

      expect(p).toEqual([
        { escopo: 'item', tipo: 'fixed', indice: 0, valor: '12', limite: '10' },
      ]);
    });

    it('aponta qual item está errado', () => {
      const p = conferirDescontos([
        item({ precoUnitario: 40 }),
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
      ]);

      expect(p).toEqual([
        { escopo: 'item', tipo: 'fixed', indice: 1, valor: '50', limite: '10' },
      ]);
    });

    /** Percentual tem outro limite — cem por cento — e ele também vale. */
    it('aceita percentual até cem', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: 100,
        }),
      ]);

      expect(p).toEqual([]);
    });

    it('recusa percentual acima de cem', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: 120,
        }),
      ]);

      expect(p).toEqual([
        {
          escopo: 'item',
          tipo: 'percentage',
          indice: 0,
          valor: '120',
          limite: '100',
        },
      ]);
    });

    /**
     * O limite do percentual **não** depende do preço: 120% de um item de R$ 1
     * é tão inválido quanto de um item de R$ 1.000.
     */
    it('o limite do percentual não olha o preço do item', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 1000,
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: 101,
        }),
      ]);

      expect(p).toEqual([
        {
          escopo: 'item',
          tipo: 'percentage',
          indice: 0,
          valor: '101',
          limite: '100',
        },
      ]);
    });
  });

  describe('desconto geral', () => {
    it('aceita desconto igual ao total dos itens', () => {
      const p = conferirDescontos([item({ precoUnitario: 100 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 100,
      });

      expect(p).toEqual([]);
    });

    it('recusa desconto maior que o total dos itens', () => {
      const p = conferirDescontos([item({ precoUnitario: 100 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 150,
      });

      expect(p).toEqual([
        { escopo: 'geral', tipo: 'fixed', valor: '150', limite: '100' },
      ]);
    });

    /**
     * O limite é o total **já descontado item a item** — é sobre ele que o
     * desconto geral incide. Usar o preço cheio deixaria passar um desconto que
     * ainda assim zeraria a venda.
     */
    it('o limite é o total depois dos descontos de item', () => {
      const p = conferirDescontos(
        [
          item({
            quantidade: 2,
            precoUnitario: 100,
            tipoDesconto: DiscountType.PERCENTAGE,
            valorDesconto: 10,
          }),
        ],
        { descontoGeralTipo: DiscountType.FIXED, descontoGeralValor: 190 },
      );

      // 2 × 90 = 180, então 190 não cabe — mesmo sendo menor que os 200 cheios.
      expect(p).toEqual([
        { escopo: 'geral', tipo: 'fixed', valor: '190', limite: '180' },
      ]);
    });

    it('a taxa de entrega não aumenta o limite', () => {
      const p = conferirDescontos([item({ precoUnitario: 100 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 105,
        taxaEntrega: 20,
      });

      expect(p).toEqual([
        { escopo: 'geral', tipo: 'fixed', valor: '105', limite: '100' },
      ]);
    });

    it('aceita percentual até cem', () => {
      const p = conferirDescontos([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.PERCENTAGE,
        descontoGeralValor: 100,
      });

      expect(p).toEqual([]);
    });

    it('recusa percentual acima de cem', () => {
      const p = conferirDescontos([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.PERCENTAGE,
        descontoGeralValor: 150,
      });

      expect(p).toEqual([
        { escopo: 'geral', tipo: 'percentage', valor: '150', limite: '100' },
      ]);
    });

    /** Venda vazia: cem por cento de nada continua sendo cem por cento. */
    it('percentual válido não depende de haver item', () => {
      const p = conferirDescontos([], {
        descontoGeralTipo: DiscountType.PERCENTAGE,
        descontoGeralValor: 50,
      });

      expect(p).toEqual([]);
    });
  });

  it('venda sem desconto nenhum não tem o que recusar', () => {
    expect(conferirDescontos([item()])).toEqual([]);
  });

  /**
   * Desconto negativo é acréscimo disfarçado.
   *
   * `resumirVenda` somaria: subtrair um número negativo aumenta o total. Como o
   * corte em zero só olha o piso, nada nunca acusaria — a venda sairia mais cara
   * do que os itens, com um campo chamado "desconto" explicando por quê.
   */
  describe('desconto negativo', () => {
    it('recusa valor negativo no item', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: -5,
        }),
      ]);

      expect(p).toEqual([
        { escopo: 'item', tipo: 'fixed', indice: 0, valor: '-5', limite: '0' },
      ]);
    });

    it('recusa percentual negativo no item', () => {
      const p = conferirDescontos([
        item({
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: -10,
        }),
      ]);

      expect(p).toEqual([
        {
          escopo: 'item',
          tipo: 'percentage',
          indice: 0,
          valor: '-10',
          limite: '0',
        },
      ]);
    });

    it('recusa valor negativo no desconto geral', () => {
      const p = conferirDescontos([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: -20,
      });

      expect(p).toEqual([
        { escopo: 'geral', tipo: 'fixed', valor: '-20', limite: '0' },
      ]);
    });

    it('zero continua valendo como ausência de desconto', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 0,
        }),
      ]);

      expect(p).toEqual([]);
    });

    /** Um problema por desconto: negativo não é "acima do limite" também. */
    it('acusa uma vez só', () => {
      const p = conferirDescontos([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: -5,
        }),
      ]);

      expect(p).toHaveLength(1);
    });
  });

  it('acusa os dois escopos de uma vez', () => {
    const p = conferirDescontos(
      [
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
      ],
      { descontoGeralTipo: DiscountType.FIXED, descontoGeralValor: 5 },
    );

    // O item some inteiro, então sobra zero para o desconto geral incidir.
    expect(p).toEqual([
      { escopo: 'item', tipo: 'fixed', indice: 0, valor: '50', limite: '10' },
      { escopo: 'geral', tipo: 'fixed', valor: '5', limite: '0' },
    ]);
  });
});

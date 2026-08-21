import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { QrParserService } from './qr-parser.service';

jest.mock('axios');

/**
 * Leitura do QR Code de nota fiscal.
 *
 * 215 linhas sem teste, e o que entra aqui é **HTML de terceiro**: página da
 * SEFAZ, fora do nosso controle, com formatação brasileira de número e campos
 * que às vezes faltam. É o lugar do código onde a entrada é menos confiável.
 *
 * O caso mais sutil está no fim: quando a nota traz no campo de preço unitário
 * o valor **total** do item, o serviço divide pela quantidade. É heurística
 * corrigindo dado ruim na origem — o tipo de coisa que alguém remove por achar
 * que é sobra, e o prejuízo aparece só na conferência de despesa.
 */

const mockAxios = axios as jest.Mocked<typeof axios>;

const URL_QR = 'https://sefaz.exemplo.gov.br/nfce?p=123';

/** Página de consulta com os seletores que o serviço procura. */
const paginaHtml = (opcoes: {
  estabelecimento?: string;
  emissao?: string;
  totais?: { rotulo: string; valor: string }[];
  itens?: {
    descricao: string;
    qtd?: string;
    unitario?: string;
    total?: string;
  }[];
}) => {
  const totais = (opcoes.totais ?? [])
    .map(
      (t) =>
        `<div id="linhaTotal"><label>${t.rotulo}</label><span class="totalNumb">${t.valor}</span></div>`,
    )
    .join('');

  const itens = (opcoes.itens ?? [])
    .map(
      (i) => `<tr>
        <td><span class="txtTit2">${i.descricao}</span></td>
        <td><span class="Rqtd">Qtde.: ${i.qtd ?? ''}</span></td>
        <td><span class="RvlUnit">Vl. Unit.: ${i.unitario ?? ''}</span></td>
        <td><span class="valor">${i.total ?? ''}</span></td>
      </tr>`,
    )
    .join('');

  return `<html><body>
    ${opcoes.estabelecimento ? `<div class="txtTopo">${opcoes.estabelecimento}</div>` : ''}
    ${opcoes.emissao ? `<div><strong>Emissão</strong>: ${opcoes.emissao}</div>` : ''}
    <div id="totalNota">${totais}</div>
    <table id="tabResult">${itens}</table>
  </body></html>`;
};

const xmlDeNota = (raiz: 'nfeProc' | 'NFe', detXml: string) => {
  const infNfe = `<infNFe>
      <ide><dhEmi>2026-02-05T10:32:16-03:00</dhEmi></ide>
      <emit><xNome>MERCADO FICTICIO LTDA</xNome></emit>
      ${detXml}
      <total><ICMSTot><vNF>90.00</vNF><vProd>100.00</vProd><vDesc>10.00</vDesc></ICMSTot></total>
    </infNFe>`;
  const nfe = `<NFe>${infNfe}</NFe>`;
  return `<?xml version="1.0" encoding="UTF-8"?>${
    raiz === 'nfeProc' ? `<nfeProc>${nfe}</nfeProc>` : nfe
  }`;
};

/**
 * Escapa o XML para caber num `<pre>`, como a página real faz.
 *
 * Sem isto o cheerio interpreta as tags do XML como HTML e `.text()` devolve só
 * o conteúdo textual — o `startsWith('<?xml')` do serviço nunca casaria. Foi
 * exatamente esse o erro da primeira versão deste arquivo: a fixture mentia
 * sobre o formato da página.
 */
const emPre = (xml: string) =>
  `<html><body><pre>${xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;

const det = (xProd: string, qCom: string, vUnCom: string, vProd: string) =>
  `<det><prod><xProd>${xProd}</xProd><qCom>${qCom}</qCom><vUnCom>${vUnCom}</vUnCom><vProd>${vProd}</vProd></prod></det>`;

describe('QrParserService', () => {
  let service: QrParserService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [QrParserService],
    }).compile();
    service = module.get<QrParserService>(QrParserService);
  });

  describe('de onde os dados vêm', () => {
    it('prefere o XML quando a página oferece o link', async () => {
      mockAxios.get
        .mockResolvedValueOnce({
          data: '<html><body><a href="/nota.xml">Baixar XML</a></body></html>',
        })
        .mockResolvedValueOnce({
          data: xmlDeNota('nfeProc', det('ARROZ', '2', '5.00', '10.00')),
        });

      const r = await service.parseQrCode(URL_QR);

      expect(r.nomeEstabelecimento).toBe('MERCADO FICTICIO LTDA');
      expect(mockAxios.get).toHaveBeenCalledTimes(2);
      // O link relativo é resolvido contra a URL do QR.
      expect(String(mockAxios.get.mock.calls[1][0])).toContain('/nota.xml');
    });

    it('usa o XML embutido em <pre> quando não há link', async () => {
      const xml = xmlDeNota('NFe', det('FEIJAO', '1', '8.00', '8.00'));
      mockAxios.get.mockResolvedValueOnce({
        data: emPre(xml),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens[0].descricao).toBe('FEIJAO');
      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    it('cai para o HTML quando não há XML em lugar nenhum', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({ estabelecimento: 'PADARIA FICTICIA' }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.nomeEstabelecimento).toBe('PADARIA FICTICIA');
    });

    it('propaga a falha de rede em vez de devolver nota vazia', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      await expect(service.parseQrCode(URL_QR)).rejects.toThrow('ETIMEDOUT');
    });
  });

  describe('XML', () => {
    it('lê as duas raízes possíveis', async () => {
      for (const raiz of ['nfeProc', 'NFe'] as const) {
        mockAxios.get.mockResolvedValueOnce({
          data: emPre(xmlDeNota(raiz, det('X', '1', '1.00', '1.00'))),
        });

        const r = await service.parseQrCode(URL_QR);
        expect(r.nomeEstabelecimento).toBe('MERCADO FICTICIO LTDA');
      }
    });

    it('trata item único como lista de um', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: emPre(xmlDeNota('nfeProc', det('ARROZ', '2', '5.00', '10.00'))),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens).toHaveLength(1);
      expect(r.itens[0]).toEqual({
        descricao: 'ARROZ',
        quantidade: 2,
        valorUnitario: 5,
        valor: 10,
      });
    });

    it('lê vários itens', async () => {
      const dois =
        det('ARROZ', '2', '5.00', '10.00') + det('FEIJAO', '1', '8.00', '8.00');
      mockAxios.get.mockResolvedValueOnce({
        data: emPre(xmlDeNota('nfeProc', dois)),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens.map((i) => i.descricao)).toEqual(['ARROZ', 'FEIJAO']);
    });

    it('separa total, bruto e desconto', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: emPre(xmlDeNota('nfeProc', det('X', '1', '1.00', '1.00'))),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.valorTotal).toBe(90);
      expect(r.valorTotalSemDesconto).toBe(100);
      expect(r.valorDesconto).toBe(10);
    });

    it('guarda o XML cru para conferência posterior', async () => {
      const xml = xmlDeNota('nfeProc', det('X', '1', '1.00', '1.00'));
      mockAxios.get.mockResolvedValueOnce({
        data: emPre(xml),
      });

      const r = await service.parseQrCode(URL_QR);

      // O retorno é união: `xmlRaw` só existe no ramo do XML, e o `tsc` cobra o
      // estreitamento. O teste documenta isso em vez de escondê-lo num cast.
      expect('xmlRaw' in r ? r.xmlRaw : null).toContain(
        '<xNome>MERCADO FICTICIO LTDA</xNome>',
      );
    });

    it('nota sem emitente não quebra: vira Desconhecido', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: emPre('<?xml version="1.0"?><NFe><infNFe></infNFe></NFe>'),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.nomeEstabelecimento).toBe('Desconhecido');
      expect(r.valorTotal).toBe(0);
      expect(r.itens).toEqual([]);
    });
  });

  describe('HTML', () => {
    it('lê data e hora de emissão', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({ emissao: '05/02/2026 10:32:16' }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.dataCompra).toBe('2026-02-05T10:32:16');
    });

    it('só com a data, assume meia-noite', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({ emissao: '05/02/2026' }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.dataCompra).toBe('2026-02-05T00:00:00');
    });

    /** `1.234,56` é o formato da página; ponto é milhar, vírgula é decimal. */
    it('entende número em formato brasileiro', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          totais: [{ rotulo: 'Valor a pagar', valor: '1.234,56' }],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.valorTotal).toBe(1234.56);
    });

    it('"Valor a pagar" tem precedência sobre "Valor total"', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          totais: [
            { rotulo: 'Valor total', valor: '100,00' },
            { rotulo: 'Valor a pagar', valor: '90,00' },
          ],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.valorTotal).toBe(90);
    });

    it('sem quantidade declarada, assume uma unidade', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          itens: [{ descricao: 'PAO', unitario: '5,00', total: '5,00' }],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens[0].quantidade).toBe(1);
    });

    it('ignora linha de tabela sem descrição', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          itens: [
            { descricao: '', qtd: '1', unitario: '5,00', total: '5,00' },
            { descricao: 'PAO', qtd: '1', unitario: '5,00', total: '5,00' },
          ],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens).toHaveLength(1);
    });

    /**
     * O caso mais sutil do arquivo.
     *
     * Algumas notas repetem o valor **total** do item no campo de preço
     * unitário. Sem a correção, uma compra de 3 unidades a R$ 10 apareceria
     * como 3 × R$ 30 na conferência de despesa — e a soma bateria com a nota,
     * porque o total do item está certo. O erro só aparece no unitário.
     */
    it('corrige o unitário quando a nota repete o total nele', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          itens: [
            {
              descricao: 'REFRIGERANTE',
              qtd: '3',
              unitario: '30,00',
              total: '30,00',
            },
          ],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens[0].valor).toBe(30);
      expect(r.itens[0].valorUnitario).toBe(10);
    });

    it('não mexe no unitário quando ele já está certo', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          itens: [
            {
              descricao: 'REFRIGERANTE',
              qtd: '3',
              unitario: '10,00',
              total: '30,00',
            },
          ],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens[0].valorUnitario).toBe(10);
    });

    /** Com uma unidade, unitário e total coincidem legitimamente. */
    it('uma unidade não dispara a correção', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          itens: [
            { descricao: 'PAO', qtd: '1', unitario: '7,50', total: '7,50' },
          ],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens[0].valorUnitario).toBe(7.5);
    });

    it('sem valor total do item, calcula por quantidade vezes unitário', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: paginaHtml({
          itens: [{ descricao: 'PAO', qtd: '4', unitario: '2,50', total: '' }],
        }),
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.itens[0].valor).toBe(10);
    });

    it('página vazia devolve nota vazia, sem lançar', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: '<html><body></body></html>',
      });

      const r = await service.parseQrCode(URL_QR);

      expect(r.success).toBe(true);
      expect(r.nomeEstabelecimento).toBe('Desconhecido');
      expect(r.valorTotal).toBe(0);
      expect(r.itens).toEqual([]);
      expect(r.urlQrcode).toBe(URL_QR);
    });
  });
});

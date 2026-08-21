import { Injectable, Logger } from '@nestjs/common';
import { resumirVenda } from '../sales/sale-totals';
import * as path from 'path';
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces';
import type {
  ConsolidatedItem,
  LocalizedField,
  PdfOrder,
  PdfOrderSummary,
  PdfSale,
  PdfSaleItem,
} from './pdf.types';

/** Recorte do `Printer` do pdfmake — @types/pdfmake só cobre a API de browser. */
interface PdfPrinterLike {
  createPdfKitDocument(doc: TDocumentDefinitions): NodeJS.ReadableStream & {
    end(): void;
  };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfmake não expõe tipos/ESM para este caminho interno
const PdfPrinter = (require('pdfmake/js/Printer') as { default: unknown })
  .default as new (fonts: TFontDictionary) => PdfPrinterLike;

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private printer: PdfPrinterLike;

  constructor() {
    const fonts: TFontDictionary = {
      Roboto: {
        normal: path.join(
          process.cwd(),
          'node_modules/pdfmake/fonts/Roboto/Roboto-Regular.ttf',
        ),
        bold: path.join(
          process.cwd(),
          'node_modules/pdfmake/fonts/Roboto/Roboto-Medium.ttf',
        ),
        italics: path.join(
          process.cwd(),
          'node_modules/pdfmake/fonts/Roboto/Roboto-Italic.ttf',
        ),
        bolditalics: path.join(
          process.cwd(),
          'node_modules/pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf',
        ),
      },
    };
    this.printer = new PdfPrinter(fonts);
  }

  async generatePdf(docDefinition: TDocumentDefinitions): Promise<Buffer> {
    try {
      const pdfDoc = this.printer.createPdfKitDocument(docDefinition);
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', (err) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
        pdfDoc.end();
      });
    } catch (error) {
      this.logger.error(
        `Error generating PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private getLocalizedText(field: LocalizedField): string {
    if (!field) return '';
    if (typeof field === 'string') return field;
    if (typeof field !== 'object') return '';
    const map = field as Record<string, unknown>;
    const value = map['pt-BR'] ?? map['ja-JP'] ?? Object.values(map)[0];
    return typeof value === 'string' ? value : '';
  }

  async generateSaleReceipt(sale: PdfSale): Promise<Buffer> {
    const companyInfo = {
      nome: process.env.EMPRESA_NOME || 'YATSUNAMI',
      cnpj: process.env.EMPRESA_CNPJ || '',
      endereco: process.env.EMPRESA_ENDERECO || '',
      cidade: process.env.EMPRESA_CIDADE || '',
      cep: process.env.EMPRESA_CEP || '',
      telefone: process.env.EMPRESA_TELEFONE || '',
      email: process.env.EMPRESA_EMAIL || '',
      inscricaoMunicipal: process.env.EMPRESA_INSCRICAO_MUNICIPAL || '',
      regimeTributario:
        process.env.EMPRESA_REGIME_TRIBUTARIO ||
        'MEI - Microempreendedor Individual',
    };

    // A conta é a mesma que gravou o total no banco (`sale-totals.ts`). Antes
    // este bloco tinha a própria versão, em `Number`, e discordava em três
    // pontos — o recibo imprimia linhas que não fechavam com o próprio TOTAL.
    const resumo = resumirVenda(sale.itens, {
      descontoGeralTipo: sale.descontoGeralTipo,
      descontoGeralValor: sale.descontoGeralValor,
      taxaEntrega: sale.taxaEntrega,
    });
    const subtotal = Number(resumo.subtotal);
    const totalItemsDiscount = Number(resumo.descontoItens);
    const globalDiscountValue = Number(resumo.descontoGeral);
    const taxaEntrega = Number(resumo.taxaEntrega);
    // Build totals section
    const totalsStack: Content[] = [];

    // Always show subtotal
    totalsStack.push({
      columns: [
        {
          text: 'Subtotal:',
          style: 'totalLabel',
          alignment: 'right',
          margin: [0, 0, 10, 0],
        },
        {
          text: `R$ ${subtotal.toFixed(2).replace('.', ',')}`,
          style: 'totalValue',
          alignment: 'right',
        },
      ],
    });

    // Show item discounts if any
    if (totalItemsDiscount > 0) {
      totalsStack.push({
        columns: [
          {
            text: 'Desc. Itens:',
            style: 'discountLabel',
            alignment: 'right',
            margin: [0, 0, 10, 0],
          },
          {
            text: `-R$ ${totalItemsDiscount.toFixed(2).replace('.', ',')}`,
            style: 'discountValue',
            alignment: 'right',
          },
        ],
      });
    }

    // Show global discount if any
    if (globalDiscountValue > 0) {
      const globalDiscountText =
        sale.descontoGeralTipo === 'percentage'
          ? `Desc. Geral (${Number(sale.descontoGeralValor)}%):`
          : 'Desc. Geral:';
      totalsStack.push({
        columns: [
          {
            text: globalDiscountText,
            style: 'discountLabel',
            alignment: 'right',
            margin: [0, 0, 10, 0],
          },
          {
            text: `-R$ ${globalDiscountValue.toFixed(2).replace('.', ',')}`,
            style: 'discountValue',
            alignment: 'right',
          },
        ],
      });
    }

    // Taxa de entrega. Ela não existia aqui — nem no tipo —, mas entra no total
    // gravado, então toda venda com entrega imprimia um recibo cujas linhas não
    // somavam o TOTAL logo abaixo delas.
    if (taxaEntrega > 0) {
      totalsStack.push({
        columns: [
          {
            text: 'Taxa de Entrega:',
            style: 'totalLabel',
            alignment: 'right',
            margin: [0, 0, 10, 0],
          },
          {
            text: `R$ ${taxaEntrega.toFixed(2).replace('.', ',')}`,
            style: 'totalValue',
            alignment: 'right',
          },
        ],
      });
    }

    // Final total
    totalsStack.push({
      columns: [
        {
          text: 'TOTAL:',
          style: 'totalHeaderLabel',
          alignment: 'right',
          margin: [0, 0, 10, 0],
        },
        {
          text: `R$ ${Number(sale.total).toFixed(2).replace('.', ',')}`,
          style: 'totalHeaderValue',
          alignment: 'right',
        },
      ],
    });

    const docDefinition: TDocumentDefinitions = {
      pageSize: { width: 226.77, height: 'auto' }, // 80mm
      pageMargins: [10, 10, 10, 10],
      content: [
        { text: 'NOTA DO CONSUMIDOR', style: 'header', alignment: 'center' },

        { text: 'INFORMAÇÕES DO EMITENTE', style: 'sectionHeader' },
        { text: `Nome: ${companyInfo.nome}`, style: 'companyInfo' },
        { text: `CNPJ: ${companyInfo.cnpj}`, style: 'companyInfo' },
        { text: `Endereço: ${companyInfo.endereco}`, style: 'companyInfo' },
        { text: `Cidade: ${companyInfo.cidade}`, style: 'companyInfo' },
        { text: `CEP: ${companyInfo.cep}`, style: 'companyInfo' },
        { text: `Telefone: ${companyInfo.telefone}`, style: 'companyInfo' },
        { text: `Email: ${companyInfo.email}`, style: 'companyInfo' },
        {
          text: `Inscrição Municipal: ${companyInfo.inscricaoMunicipal}`,
          style: 'companyInfo',
        },
        {
          text: `Regime Tributário: ${companyInfo.regimeTributario}`,
          style: 'companyInfo',
        },

        {
          canvas: [
            { type: 'line', x1: 0, y1: 5, x2: 206.77, y2: 5, lineWidth: 1 },
          ],
        },
        { text: '\n' },

        { text: 'INFORMAÇÕES DA VENDA', style: 'sectionHeader' },
        {
          text: `Número da Venda: ${String(sale.id).padStart(6, '0')}`,
          style: 'label',
        },
        {
          text: `Data e Hora: ${new Date(sale.data).toLocaleString('pt-BR')}`,
          style: 'companyInfo',
        },
        {
          text: `Data: ${new Date(sale.data).toISOString().split('T')[0]}`,
          style: 'companyInfo',
        },

        {
          canvas: [
            { type: 'line', x1: 0, y1: 5, x2: 206.77, y2: 5, lineWidth: 1 },
          ],
        },
        { text: '\n' },

        { text: 'PRODUTOS E SERVIÇOS', style: 'sectionHeader' },
        {
          table: {
            headerRows: 1,
            widths: [15, '*', 'auto', 'auto'],
            body: [
              [
                { text: 'Qtd', style: 'tableHeader' },
                { text: 'Descrição', style: 'tableHeader' },
                {
                  text: 'Preço Unit.',
                  style: 'tableHeader',
                  alignment: 'right',
                },
                { text: 'Subtotal', style: 'tableHeader', alignment: 'right' },
              ],
              ...sale.itens.map((item: PdfSaleItem): TableCell[] => {
                const productName = this.getLocalizedText(item.produto?.nome);
                const varietyName = item.variedade
                  ? ` - ${this.getLocalizedText(item.variedade?.nome)}`
                  : '';
                const itemSubtotal =
                  Number(item.quantidade) * Number(item.precoUnitario);

                // Calculate item discount
                let itemDiscount = 0;
                let discountText = '';
                if (item.tipoDesconto && item.valorDesconto) {
                  if (item.tipoDesconto === 'percentage') {
                    itemDiscount =
                      ((Number(item.precoUnitario) *
                        Number(item.valorDesconto)) /
                        100) *
                      Number(item.quantidade);
                    discountText = ` (-${Number(item.valorDesconto)}%)`;
                  } else if (item.tipoDesconto === 'fixed') {
                    itemDiscount =
                      Number(item.valorDesconto) * Number(item.quantidade);
                    discountText = ` (-R$${Number(item.valorDesconto).toFixed(2).replace('.', ',')}/un)`;
                  }
                }

                const finalSubtotal = itemSubtotal - itemDiscount;

                return [
                  {
                    // String(): `quantidade` chega como Decimal do Prisma; passar o
                    // objeto direto ao pdfmake renderizaria "[object Object]".
                    text: String(item.quantidade ?? ''),
                    alignment: 'center',
                    style: 'tableBody',
                  },
                  {
                    text:
                      `${productName}${varietyName}`.toUpperCase() +
                      discountText,
                    style: 'tableBody',
                  },
                  {
                    text: Number(item.precoUnitario)
                      .toFixed(2)
                      .replace('.', ','),
                    alignment: 'right',
                    style: 'tableBody',
                  },
                  {
                    text:
                      itemDiscount > 0
                        ? finalSubtotal.toFixed(2).replace('.', ',')
                        : itemSubtotal.toFixed(2).replace('.', ','),
                    alignment: 'right',
                    style: 'tableBody',
                  },
                ];
              }),
            ],
          },
          layout: 'headerLineOnly',
        },
        { text: '\n' },
        {
          columns: [
            { text: '', width: '*' },
            {
              stack: totalsStack,
              width: 'auto',
            },
          ],
        },

        {
          canvas: [
            { type: 'line', x1: 0, y1: 10, x2: 206.77, y2: 10, lineWidth: 1 },
          ],
        },
        { text: '\n' },

        { text: sale.observacoes ? 'OBS' : '', style: 'sectionHeader' },
        { text: sale.observacoes || '', style: 'small' },
        { text: '\n' },

        {
          text: 'INFORMAÇÕES LEGAIS',
          style: 'legalHeader',
          alignment: 'center',
        },
        {
          text: 'Esta nota do consumidor é um documento fiscal simplificado destinado ao Microempreendedor Individual (MEI), conforme disposto na Lei Complementar nº 123/2006 e alterações.\n\nO MEI está dispensado da emissão de nota fiscal eletrônica para vendas a consumidor final, podendo emitir este documento simplificado.\n\nEm caso de dúvidas ou reclamações, entre em contato conosco através dos dados de contato informados acima.\n\nDocumento gerado automaticamente pelo sistema.',
          style: 'legalText',
          alignment: 'center',
        },

        { text: '\n' },
        {
          canvas: [
            { type: 'line', x1: 0, y1: 5, x2: 206.77, y2: 5, lineWidth: 1 },
          ],
        },
        { text: '\n' },
        {
          text: 'Obrigado pela preferência!',
          style: 'subheader',
          alignment: 'center',
        },
      ],
      styles: {
        header: { fontSize: 14, bold: true, margin: [0, 0, 0, 10] },
        subheader: { fontSize: 12, bold: true, margin: [0, 0, 0, 5] },
        sectionHeader: { fontSize: 11, bold: true, margin: [0, 5, 0, 2] },
        companyInfo: { fontSize: 8, margin: [0, 0, 0, 1] },
        label: { fontSize: 9, bold: true },
        tableHeader: { bold: true, fontSize: 8, color: 'black' },
        tableBody: { fontSize: 8 },
        totalLabel: { fontSize: 10, bold: false },
        totalValue: { fontSize: 10, bold: false },
        discountLabel: { fontSize: 9, bold: false, color: '#006400' },
        discountValue: { fontSize: 9, bold: false, color: '#006400' },
        totalHeaderLabel: { fontSize: 11, bold: true },
        totalHeaderValue: { fontSize: 11, bold: true },
        small: { fontSize: 8, italics: true },
        legalHeader: { fontSize: 10, bold: true, margin: [0, 10, 0, 5] },
        legalText: { fontSize: 7, margin: [0, 0, 0, 10] },
      },
    };

    return this.generatePdf(docDefinition);
  }

  async generateOrderSummary(data: PdfOrderSummary): Promise<Buffer> {
    const { date, orders } = data;

    // Consolidate products
    const consolidated: Record<string, ConsolidatedItem> = {};
    orders.forEach((order: PdfOrder) => {
      order.itens.forEach((item: PdfSaleItem) => {
        const key = `${item.produtoId}-${item.variedadeId || 0}`;
        if (!consolidated[key]) {
          consolidated[key] = {
            nome: this.getLocalizedText(item.produto?.nome),
            variedade: item.variedade
              ? this.getLocalizedText(item.variedade?.nome)
              : '-',
            quantidade: 0,
          };
        }
        consolidated[key].quantidade += Number(item.quantidade);
      });
    });

    const docDefinition: TDocumentDefinitions = {
      content: [
        { text: 'RESUMO DE PEDIDOS', style: 'header', alignment: 'center' },
        {
          text: `Data de Entrega: ${new Date(date).toLocaleDateString('pt-BR')}`,
          style: 'subheader',
          alignment: 'center',
        },
        { text: '\n' },
        {
          table: {
            headerRows: 1,
            widths: ['*', '*', 'auto'],
            body: [
              [
                { text: 'Produto', style: 'tableHeader' },
                { text: 'Variedade', style: 'tableHeader' },
                { text: 'Total Qtd', style: 'tableHeader' },
              ],
              ...Object.values(consolidated).map(
                (item: ConsolidatedItem): TableCell[] => [
                  item.nome,
                  item.variedade,
                  { text: item.quantidade.toString(), alignment: 'center' },
                ],
              ),
            ],
          },
          layout: 'lightHorizontalLines',
        },
        { text: '\n\n' },
        { text: 'Lista Detalhada por Cliente', style: 'subheader' },
        ...orders.map(
          (order: PdfOrder): Content => ({
            stack: [
              {
                text: `Cliente: ${order.usuario?.nome}`,
                bold: true,
                margin: [0, 10, 0, 5],
              },
              {
                ul: order.itens.map(
                  (item: PdfSaleItem) =>
                    `${String(item.quantidade)}x ${this.getLocalizedText(item.produto?.nome)} (${item.variedade ? this.getLocalizedText(item.variedade?.nome) : '-'})`,
                ),
              },
            ],
          }),
        ),
      ],
      styles: {
        header: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
        subheader: { fontSize: 14, bold: true, margin: [0, 10, 0, 5] },
        tableHeader: { bold: true, fontSize: 12, color: 'black' },
      },
    };

    return this.generatePdf(docDefinition);
  }
}

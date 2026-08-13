import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfmake não expõe tipos/ESM para este caminho interno
const PdfPrinter = require('pdfmake/js/Printer').default;

@Injectable()
export class PdfService {
    private readonly logger = new Logger(PdfService.name);
    private printer: any;

    constructor() {
        const fonts = {
            Roboto: {
                normal: path.join(process.cwd(), 'node_modules/pdfmake/fonts/Roboto/Roboto-Regular.ttf'),
                bold: path.join(process.cwd(), 'node_modules/pdfmake/fonts/Roboto/Roboto-Medium.ttf'),
                italics: path.join(process.cwd(), 'node_modules/pdfmake/fonts/Roboto/Roboto-Italic.ttf'),
                bolditalics: path.join(process.cwd(), 'node_modules/pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf'),
            },
        };
        this.printer = new PdfPrinter(fonts);
    }

    async generatePdf(docDefinition: any): Promise<Buffer> {
        try {
            const pdfDoc = await this.printer.createPdfKitDocument(docDefinition);
            return new Promise((resolve, reject) => {
                const chunks: Buffer[] = [];
                pdfDoc.on('data', (chunk) => chunks.push(chunk));
                pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
                pdfDoc.on('error', (err) =>
                    reject(err instanceof Error ? err : new Error(String(err))),
                );
                pdfDoc.end();
            });
        } catch (error) {
            this.logger.error(`Error generating PDF: ${error.message}`);
            throw error;
        }
    }

    private getLocalizedText(field: any): string {
        if (!field) return '';
        if (typeof field === 'string') return field;
        return field['pt-BR'] || field['ja-JP'] || Object.values(field)[0] || '';
    }

    async generateSaleReceipt(sale: any): Promise<Buffer> {
        const companyInfo = {
            nome: process.env.EMPRESA_NOME || 'YATSUNAMI',
            cnpj: process.env.EMPRESA_CNPJ || '',
            endereco: process.env.EMPRESA_ENDERECO || '',
            cidade: process.env.EMPRESA_CIDADE || '',
            cep: process.env.EMPRESA_CEP || '',
            telefone: process.env.EMPRESA_TELEFONE || '',
            email: process.env.EMPRESA_EMAIL || '',
            inscricaoMunicipal: process.env.EMPRESA_INSCRICAO_MUNICIPAL || '',
            regimeTributario: process.env.EMPRESA_REGIME_TRIBUTARIO || 'MEI - Microempreendedor Individual',
        };

        // Calculate totals
        let subtotal = 0;
        let totalItemsDiscount = 0;

        sale.itens.forEach((item: any) => {
            const itemSubtotal = Number(item.quantidade) * Number(item.precoUnitario);
            subtotal += itemSubtotal;

            // Calculate per-unit discount * quantity
            if (item.tipoDesconto && item.valorDesconto) {
                if (item.tipoDesconto === 'percentage') {
                    totalItemsDiscount += (Number(item.precoUnitario) * Number(item.valorDesconto) / 100) * Number(item.quantidade);
                } else if (item.tipoDesconto === 'fixed') {
                    totalItemsDiscount += Number(item.valorDesconto) * Number(item.quantidade);
                }
            }
        });

        // Calculate global discount
        let globalDiscountValue = 0;
        const subtotalAfterItemDiscounts = subtotal - totalItemsDiscount;
        if (sale.descontoGeralTipo && sale.descontoGeralValor && Number(sale.descontoGeralValor) > 0) {
            if (sale.descontoGeralTipo === 'percentage') {
                globalDiscountValue = subtotalAfterItemDiscounts * Number(sale.descontoGeralValor) / 100;
            } else if (sale.descontoGeralTipo === 'fixed') {
                globalDiscountValue = Number(sale.descontoGeralValor);
            }
        }


        // Build totals section
        const totalsStack: any[] = [];

        // Always show subtotal
        totalsStack.push({
            columns: [
                { text: 'Subtotal:', style: 'totalLabel', alignment: 'right', margin: [0, 0, 10, 0] },
                { text: `R$ ${subtotal.toFixed(2).replace('.', ',')}`, style: 'totalValue', alignment: 'right' },
            ],
        });

        // Show item discounts if any
        if (totalItemsDiscount > 0) {
            totalsStack.push({
                columns: [
                    { text: 'Desc. Itens:', style: 'discountLabel', alignment: 'right', margin: [0, 0, 10, 0] },
                    { text: `-R$ ${totalItemsDiscount.toFixed(2).replace('.', ',')}`, style: 'discountValue', alignment: 'right' },
                ],
            });
        }

        // Show global discount if any
        if (globalDiscountValue > 0) {
            const globalDiscountText = sale.descontoGeralTipo === 'percentage'
                ? `Desc. Geral (${Number(sale.descontoGeralValor)}%):`
                : 'Desc. Geral:';
            totalsStack.push({
                columns: [
                    { text: globalDiscountText, style: 'discountLabel', alignment: 'right', margin: [0, 0, 10, 0] },
                    { text: `-R$ ${globalDiscountValue.toFixed(2).replace('.', ',')}`, style: 'discountValue', alignment: 'right' },
                ],
            });
        }

        // Final total
        totalsStack.push({
            columns: [
                { text: 'TOTAL:', style: 'totalHeaderLabel', alignment: 'right', margin: [0, 0, 10, 0] },
                { text: `R$ ${Number(sale.total).toFixed(2).replace('.', ',')}`, style: 'totalHeaderValue', alignment: 'right' },
            ],
        });

        const docDefinition: any = {
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
                { text: `Inscrição Municipal: ${companyInfo.inscricaoMunicipal}`, style: 'companyInfo' },
                { text: `Regime Tributário: ${companyInfo.regimeTributario}`, style: 'companyInfo' },

                { canvas: [{ type: 'line', x1: 0, y1: 5, x2: 206.77, y2: 5, lineWidth: 1 }] },
                { text: '\n' },

                { text: 'INFORMAÇÕES DA VENDA', style: 'sectionHeader' },
                { text: `Número da Venda: ${String(sale.id).padStart(6, '0')}`, style: 'label' },
                { text: `Data e Hora: ${new Date(sale.data).toLocaleString('pt-BR')}`, style: 'companyInfo' },
                { text: `Data: ${new Date(sale.data).toISOString().split('T')[0]}`, style: 'companyInfo' },

                { canvas: [{ type: 'line', x1: 0, y1: 5, x2: 206.77, y2: 5, lineWidth: 1 }] },
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
                                { text: 'Preço Unit.', style: 'tableHeader', alignment: 'right' },
                                { text: 'Subtotal', style: 'tableHeader', alignment: 'right' },
                            ],
                            ...sale.itens.map((item: any) => {
                                const productName = this.getLocalizedText(item.produto.nome);
                                const varietyName = item.variedade ? ` - ${this.getLocalizedText(item.variedade.nome)}` : '';
                                const itemSubtotal = Number(item.quantidade) * Number(item.precoUnitario);

                                // Calculate item discount
                                let itemDiscount = 0;
                                let discountText = '';
                                if (item.tipoDesconto && item.valorDesconto) {
                                    if (item.tipoDesconto === 'percentage') {
                                        itemDiscount = (Number(item.precoUnitario) * Number(item.valorDesconto) / 100) * Number(item.quantidade);
                                        discountText = ` (-${Number(item.valorDesconto)}%)`;
                                    } else if (item.tipoDesconto === 'fixed') {
                                        itemDiscount = Number(item.valorDesconto) * Number(item.quantidade);
                                        discountText = ` (-R$${Number(item.valorDesconto).toFixed(2).replace('.', ',')}/un)`;
                                    }
                                }

                                const finalSubtotal = itemSubtotal - itemDiscount;

                                return [
                                    { text: item.quantidade, alignment: 'center', style: 'tableBody' },
                                    {
                                        text: `${productName}${varietyName}`.toUpperCase() + discountText,
                                        style: 'tableBody'
                                    },
                                    { text: Number(item.precoUnitario).toFixed(2).replace('.', ','), alignment: 'right', style: 'tableBody' },
                                    {
                                        text: itemDiscount > 0
                                            ? finalSubtotal.toFixed(2).replace('.', ',')
                                            : itemSubtotal.toFixed(2).replace('.', ','),
                                        alignment: 'right',
                                        style: 'tableBody'
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

                { canvas: [{ type: 'line', x1: 0, y1: 10, x2: 206.77, y2: 10, lineWidth: 1 }] },
                { text: '\n' },

                { text: sale.observacoes ? 'OBS' : '', style: 'sectionHeader' },
                { text: sale.observacoes || '', style: 'small' },
                { text: '\n' },

                { text: 'INFORMAÇÕES LEGAIS', style: 'legalHeader', alignment: 'center' },
                {
                    text: 'Esta nota do consumidor é um documento fiscal simplificado destinado ao Microempreendedor Individual (MEI), conforme disposto na Lei Complementar nº 123/2006 e alterações.\n\nO MEI está dispensado da emissão de nota fiscal eletrônica para vendas a consumidor final, podendo emitir este documento simplificado.\n\nEm caso de dúvidas ou reclamações, entre em contato conosco através dos dados de contato informados acima.\n\nDocumento gerado automaticamente pelo sistema.',
                    style: 'legalText',
                    alignment: 'center'
                },

                { text: '\n' },
                { canvas: [{ type: 'line', x1: 0, y1: 5, x2: 206.77, y2: 5, lineWidth: 1 }] },
                { text: '\n' },
                { text: 'Obrigado pela preferência!', style: 'subheader', alignment: 'center' },
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

    async generateOrderSummary(data: any): Promise<Buffer> {
        const { date, orders } = data;

        // Consolidate products
        const consolidated: any = {};
        orders.forEach((order: any) => {
            order.itens.forEach((item: any) => {
                const key = `${item.produtoId}-${item.variedadeId || 0}`;
                if (!consolidated[key]) {
                    consolidated[key] = {
                        nome: this.getLocalizedText(item.produto.nome),
                        variedade: item.variedade ? this.getLocalizedText(item.variedade.nome) : '-',
                        quantidade: 0,
                    };
                }
                consolidated[key].quantidade += Number(item.quantidade);
            });
        });

        const docDefinition: any = {
            content: [
                { text: 'RESUMO DE PEDIDOS', style: 'header', alignment: 'center' },
                { text: `Data de Entrega: ${new Date(date).toLocaleDateString('pt-BR')}`, style: 'subheader', alignment: 'center' },
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
                            ...Object.values(consolidated).map((item: any) => [
                                item.nome,
                                item.variedade,
                                { text: item.quantidade.toString(), alignment: 'center' },
                            ]),
                        ],
                    },
                    layout: 'lightHorizontalLines',
                },
                { text: '\n\n' },
                { text: 'Lista Detalhada por Cliente', style: 'subheader' },
                ...orders.map((order: any) => ({
                    stack: [
                        { text: `Cliente: ${order.usuario.nome}`, bold: true, margin: [0, 10, 0, 5] },
                        {
                            ul: order.itens.map((item: any) =>
                                `${item.quantidade}x ${this.getLocalizedText(item.produto.nome)} (${item.variedade ? this.getLocalizedText(item.variedade.nome) : '-'})`
                            ),
                        },
                    ],
                })),
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

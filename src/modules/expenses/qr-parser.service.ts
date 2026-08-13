import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

@Injectable()
export class QrParserService {
    private readonly logger = new Logger(QrParserService.name);
    private readonly xmlParser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
    });

    async parseQrCode(url: string) {
        try {
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            };

            const response = await axios.get(url, { headers, timeout: 10000 });
            const html = response.data;
            const $ = load(html);

            // Try to find XML link first
            let xmlContent: string | null = null;
            const xmlLink = $('a').filter((_, el) => {
                const href = $(el).attr('href') || '';
                const text = $(el).text().toLowerCase();
                return text.includes('xml') || href.toLowerCase().endsWith('.xml');
            }).attr('href');

            if (xmlLink) {
                const xmlUrl = new URL(xmlLink, url).href;
                const xmlResponse = await axios.get(xmlUrl, { headers, timeout: 10000 });
                xmlContent = xmlResponse.data;
            } else {
                const preText = $('pre').text().trim();
                if (preText.startsWith('<?xml')) {
                    xmlContent = preText;
                }
            }

            if (xmlContent) {
                return this.parseXml(xmlContent, url);
            }

            return this.parseHtml($, url);
        } catch (error) {
            this.logger.error(`Error parsing QR Code: ${error.message}`);
            throw error;
        }
    }

    private parseXml(xml: string, url: string) {
        const jsonObj = this.xmlParser.parse(xml);
        // Simplified parsing based on legacy logic
        const nfe = jsonObj['nfeProc']?.['NFe'] || jsonObj['NFe'];
        const infNfe = nfe?.['infNFe'];
        const emit = infNfe?.['emit'];
        const det = Array.isArray(infNfe?.['det']) ? infNfe['det'] : [infNfe?.['det']].filter(Boolean);

        const itens = det.map((d: any) => ({
            descricao: d['prod']?.['xProd'] || '',
            quantidade: parseFloat(d['prod']?.['qCom'] || '0'),
            valorUnitario: parseFloat(d['prod']?.['vUnCom'] || '0'),
            valor: parseFloat(d['prod']?.['vProd'] || '0'),
        }));

        const dhEmi = infNfe?.['ide']?.['dhEmi'] || new Date().toISOString();
        const dataCompra = dhEmi; // Store full ISO string with time

        return {
            success: true,
            nomeEstabelecimento: emit?.['xNome'] || 'Desconhecido',
            dataCompra,
            valorTotal: parseFloat(infNfe?.['total']?.['ICMSTot']?.['vNF'] || '0'),
            valorTotalSemDesconto: parseFloat(infNfe?.['total']?.['ICMSTot']?.['vProd'] || '0'),
            valorDesconto: parseFloat(infNfe?.['total']?.['ICMSTot']?.['vDesc'] || '0'),
            urlQrcode: url,
            itens,
            xmlRaw: xml,
        };
    }

    private parseHtml($: CheerioAPI, url: string) {
        const nomeEstabelecimento = $('.txtTopo').first().text().trim() || 'Desconhecido';

        let dataCompra = new Date().toISOString();
        const emissaoStrong = $('strong').filter((_, el) => !!$(el).text().match(/Emissão/i));
        if (emissaoStrong.length > 0) {
            const text = emissaoStrong.parent().text();
            // Try to match date and time: 05/02/2026 10:32:16
            const matchDateTime = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
            if (matchDateTime) {
                const [d, m, y] = matchDateTime[1].split('/');
                const time = matchDateTime[2];
                dataCompra = `${y}-${m}-${d}T${time}`;
            } else {
                const matchDate = text.match(/(\d{2}\/\d{2}\/\d{4})/);
                if (matchDate) {
                    const [d, m, y] = matchDate[1].split('/');
                    dataCompra = `${y}-${m}-${d}T00:00:00`;
                }
            }
        }

        const extrairValor = (label: string) => {
            let valor = 0;
            $('#totalNota #linhaTotal, #totalNota #linhaForma').each((_, el) => {
                const lbl = $(el).find('label').text().toLowerCase();
                if (lbl.includes(label.toLowerCase())) {
                    const valText = $(el).find('.totalNumb').text().trim();
                    // Handle numbers like 1.234,56 or 1234,56 or 1234.56
                    valor = parseFloat(valText.replace(/\./g, '').replace(',', '.')) || 0;
                }
            });
            return valor;
        };

        const valorTotal = extrairValor('Valor a pagar') || extrairValor('Valor total');
        const valorDesconto = extrairValor('Descontos');
        const valorTotalSemDesconto = extrairValor('Total bruto') || extrairValor('Valor total') || valorTotal;

        const itens: any[] = [];
        $('table#tabResult tr').each((_, el) => {
            const descricao = $(el).find('span.txtTit2').text().trim();
            if (descricao) {
                const extractNum = (selector: string, labelRegex: RegExp) => {
                    const text = $(el).find(selector).text().trim();
                    const cleanText = text.replace(/\s/g, ' '); // Replace NBSP and other whitespace with normal space
                    const match = cleanText.match(labelRegex);
                    if (match) {
                        return parseFloat(match[1].replace(/\./g, '').replace(',', '.')) || 0;
                    }
                    // Fallback to just finding any number-like sequence
                    const anyNum = cleanText.match(/(\d+([.,]\d+)*([.,]\d+)?)/);
                    if (anyNum) {
                        const numStr = anyNum[1];
                        // If it looks like 1.234,56 (typical Brazilian format)
                        if (numStr.includes('.') && numStr.includes(',')) {
                            return parseFloat(numStr.replace(/\./g, '').replace(',', '.')) || 0;
                        }
                        // Just a single separator or no separator
                        return parseFloat(numStr.replace(',', '.')) || 0;
                    }
                    return 0;
                };

                const quantidade = extractNum('span.Rqtd', /Qtde\.:\s*([\d,.]+)/i) || 1;

                // Unit price usually in span.RvlUnit. Label might be "Vl. Unit." or similar.
                let valorUnitario = extractNum('span.RvlUnit', /Vl\.\s*Unit\.:\s*([\d,.]+)/i);

                const vtotalText = $(el).find('span.valor').text().trim();
                const valor = parseFloat(vtotalText.replace(/\./g, '').replace(',', '.')) || (quantidade * valorUnitario);

                // Validation fix: if unit price seems to be the total, divide by qty
                if (quantidade > 1 && Math.abs(valorUnitario - valor) < 0.01) {
                    valorUnitario = valor / quantidade;
                }

                itens.push({ descricao, quantidade, valorUnitario, valor });
            }
        });

        return {
            success: true,
            nomeEstabelecimento,
            dataCompra,
            valorTotal,
            valorTotalSemDesconto,
            valorDesconto,
            urlQrcode: url,
            itens,
        };
    }
}

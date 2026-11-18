import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QrParserService } from './qr-parser.service';
import { CreateExpenseDto } from './dto';
import { Prisma } from '@prisma/client';
import { instanteDeHorarioLocal, limitesDoDia } from '../../common/utils/datas';

/**
 * Data da compra no fuso do negócio (GMT-3): valor sem fuso — da nota fiscal
 * ou de clientes antigos — é horário de Brasília; só a data vira meio-dia.
 */
const dataDaCompra = (valor?: string) => (valor ? instanteDeHorarioLocal(valor) : null);

@Injectable()
export class ExpensesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly qrParserService: QrParserService,
    ) { }

    /**
     * Limites do **dia de Brasília** (params `yyyy-MM-dd` do app). Antes eram
     * os do dia em UTC, e uma nota das 21h–23h59 caía no dia seguinte.
     */
    private diaDoFiltro(value: string) {
        try {
            return limitesDoDia(value);
        } catch {
            throw new BadRequestException(`Data inválida: ${value}`);
        }
    }

    private inicioDoDia(value: string): Date {
        return this.diaDoFiltro(value).inicio;
    }

    private fimDoDia(value: string): Date {
        return this.diaDoFiltro(value).fim;
    }

    async parseQrCode(url: string) {
        return this.qrParserService.parseQrCode(url);
    }

    async create(createExpenseDto: CreateExpenseDto) {
        const { itens, ...notaData } = createExpenseDto;

        return this.prisma.$transaction(async (tx) => {
            const nota = await tx.notaDespesa.create({
                data: {
                    nomeEstabelecimento: notaData.nomeEstabelecimento,
                    dataCompra: dataDaCompra(notaData.dataCompra),
                    valorTotal: notaData.valorTotal,
                    valorTotalSemDesconto: notaData.valorTotalSemDesconto,
                    valorDesconto: notaData.valorDesconto || 0,
                    foiEditada: notaData.foiEditada || false,
                    urlQrcode: notaData.urlQrcode,
                    xmlRaw: notaData.xmlRaw,
                },
            });

            if (itens && itens.length > 0) {
                await tx.itemDespesa.createMany({
                    data: itens.map(item => ({
                        notaId: nota.id,
                        descricao: item.descricao,
                        quantidade: item.quantidade,
                        valorUnitario: item.valorUnitario,
                        valor: item.valor,
                    })),
                });
            }

            return tx.notaDespesa.findUnique({
                where: { id: nota.id },
                include: { itens: true },
            });
        });
    }

    async findAll(query: { limit?: number; offset?: number; search?: string; dateFrom?: string; dateTo?: string }) {
        const { limit = 20, offset = 0, search, dateFrom, dateTo } = query;

        const where: Prisma.NotaDespesaWhereInput = {};
        if (search) {
            where.OR = [
                { nomeEstabelecimento: { contains: search, mode: 'insensitive' } },
            ];
        }
        if (dateFrom || dateTo) {
            where.dataCompra = {
                ...(dateFrom && { gte: this.inicioDoDia(dateFrom) }),
                ...(dateTo && { lte: this.fimDoDia(dateTo) }),
            };
        }

        const [items, total] = await Promise.all([
            this.prisma.notaDespesa.findMany({
                where,
                include: { itens: true },
                orderBy: [{ dataCompra: 'desc' }, { id: 'desc' }],
                take: limit,
                skip: offset,
            }),
            this.prisma.notaDespesa.count({ where }),
        ]);

        return { items, total };
    }

    async findOne(id: number) {
        const nota = await this.prisma.notaDespesa.findUnique({
            where: { id },
            include: { itens: true },
        });

        if (!nota) {
            throw new NotFoundException(`Despesa com ID ${id} não encontrada`);
        }

        return nota;
    }

    async update(id: number, updateExpenseDto: CreateExpenseDto) {
        const { itens, ...notaData } = updateExpenseDto;

        return this.prisma.$transaction(async (tx) => {
            await tx.notaDespesa.update({
                where: { id },
                data: {
                    nomeEstabelecimento: notaData.nomeEstabelecimento,
                    dataCompra: dataDaCompra(notaData.dataCompra),
                    valorTotal: notaData.valorTotal,
                    valorTotalSemDesconto: notaData.valorTotalSemDesconto,
                    valorDesconto: notaData.valorDesconto || 0,
                    foiEditada: notaData.foiEditada !== undefined ? notaData.foiEditada : true,
                    urlQrcode: notaData.urlQrcode,
                    xmlRaw: notaData.xmlRaw,
                },
            });

            if (itens) {
                // Easiest way is to delete and recreate items for a simple expense note
                await tx.itemDespesa.deleteMany({ where: { notaId: id } });
                await tx.itemDespesa.createMany({
                    data: itens.map(item => ({
                        notaId: id,
                        descricao: item.descricao,
                        quantidade: item.quantidade,
                        valorUnitario: item.valorUnitario,
                        valor: item.valor,
                    })),
                });
            }

            return tx.notaDespesa.findUnique({
                where: { id },
                include: { itens: true },
            });
        });
    }

    async delete(id: number) {
        const nota = await this.prisma.notaDespesa.findUnique({ where: { id } });
        if (!nota) {
            throw new NotFoundException(`Despesa com ID ${id} não encontrada`);
        }

        return this.prisma.notaDespesa.delete({ where: { id } });
    }
}

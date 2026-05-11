import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSaleDto, DiscountType } from './dto/create-sale.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class SalesService {
    constructor(private readonly prisma: PrismaService) { }

    async create(creatorId: string | null, createSaleDto: CreateSaleDto) {
        const { usuarioId, observacoes, descontoGeralTipo, descontoGeralValor, itens, taxaEntrega, data } = createSaleDto;

        return this.prisma.$transaction(async (tx) => {
            let totalVenda = new Prisma.Decimal(0);

            // Create the Sale record first to get an ID
            const venda = await tx.venda.create({
                data: {
                    usuarioId: usuarioId || null,
                    observacoes,
                    descontoGeralTipo: descontoGeralTipo || null,
                    descontoGeralValor: descontoGeralValor || 0,
                    taxaEntrega: taxaEntrega || 0,
                    criadoPor: creatorId,
                    total: 0, // Will update later
                    ...(data && { data }),
                },
            });

            for (const item of itens) {
                const produto = await tx.produto.findUnique({
                    where: { id: item.produtoId },
                    include: { variedades: true },
                });

                if (!produto) {
                    throw new NotFoundException(`Produto com ID ${item.produtoId} não encontrado`);
                }

                let precoUnitario = new Prisma.Decimal(item.precoUnitario);
                let variedadeId = item.variedadeId || null;

                if (variedadeId) {
                    const variedade = produto.variedades.find(v => v.id === variedadeId);
                    if (!variedade) {
                        throw new NotFoundException(`Variedade com ID ${variedadeId} não encontrada para o produto ${item.produtoId}`);
                    }
                }

                const quantidade = new Prisma.Decimal(item.quantidade);
                let valorDesconto = new Prisma.Decimal(item.valorDesconto || 0);
                let subtotal = precoUnitario.mul(quantidade);

                // Apply per-unit discount * quantity
                if (item.tipoDesconto === DiscountType.PERCENTAGE) {
                    const discountPerUnit = precoUnitario.mul(valorDesconto).div(100);
                    subtotal = subtotal.sub(discountPerUnit.mul(quantidade));
                } else if (item.tipoDesconto === DiscountType.FIXED) {
                    subtotal = subtotal.sub(valorDesconto.mul(quantidade));
                }

                if (subtotal.lt(0)) subtotal = new Prisma.Decimal(0);

                await tx.itemVenda.create({
                    data: {
                        vendaId: venda.id,
                        produtoId: item.produtoId,
                        variedadeId,
                        quantidade: item.quantidade,
                        precoUnitario: item.precoUnitario,
                        tipoDesconto: item.tipoDesconto || null,
                        valorDesconto: item.valorDesconto || 0,
                    },
                });

                totalVenda = totalVenda.add(subtotal);
            }

            // Apply global discount
            if (descontoGeralTipo && descontoGeralValor && descontoGeralValor > 0) {
                if (descontoGeralTipo === DiscountType.PERCENTAGE) {
                    const globalDiscountValue = totalVenda.mul(new Prisma.Decimal(descontoGeralValor)).div(100);
                    totalVenda = totalVenda.sub(globalDiscountValue);
                } else if (descontoGeralTipo === DiscountType.FIXED) {
                    totalVenda = totalVenda.sub(new Prisma.Decimal(descontoGeralValor));
                }
            }

            if (totalVenda.lt(0)) totalVenda = new Prisma.Decimal(0);

            // Add delivery fee
            if (taxaEntrega && taxaEntrega > 0) {
                totalVenda = totalVenda.add(new Prisma.Decimal(taxaEntrega));
            }

            // Update the sale with final total
            return tx.venda.update({
                where: { id: venda.id },
                data: { total: totalVenda },
                include: {
                    itens: {
                        include: {
                            produto: true,
                            variedade: true,
                        },
                    },
                    usuario: true,
                },
            });
        });
    }

    async findAll(query: { limit?: number; offset?: number; search?: string }) {
        const { limit = 20, offset = 0, search } = query;

        const where: Prisma.VendaWhereInput = {};
        if (search) {
            where.OR = [
                { observacoes: { contains: search, mode: 'insensitive' } },
                { usuario: { nome: { contains: search, mode: 'insensitive' } } },
            ];
        }

        const [items, total] = await Promise.all([
            this.prisma.venda.findMany({
                where,
                include: {
                    itens: {
                        include: {
                            produto: true,
                        },
                    },
                    usuario: true,
                },
                orderBy: { data: 'desc' },
                take: limit,
                skip: offset,
            }),
            this.prisma.venda.count({ where }),
        ]);

        return { items, total };
    }

    async findOne(id: number) {
        const venda = await this.prisma.venda.findUnique({
            where: { id },
            include: {
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    },
                },
                usuario: true,
                criador: true,
            },
        });

        if (!venda) {
            throw new NotFoundException(`Venda com ID ${id} não encontrada`);
        }

        return venda;
    }

    async delete(id: number) {
        const venda = await this.prisma.venda.findUnique({ where: { id } });
        if (!venda) {
            throw new NotFoundException(`Venda com ID ${id} não encontrada`);
        }

        return this.prisma.venda.delete({ where: { id } });
    }
}

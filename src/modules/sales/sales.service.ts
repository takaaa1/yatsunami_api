import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { resumirVenda } from './sale-totals';
import { CreateSaleDto } from './dto/create-sale.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(creatorId: string | null, createSaleDto: CreateSaleDto) {
    const {
      usuarioId,
      observacoes,
      descontoGeralTipo,
      descontoGeralValor,
      itens,
      taxaEntrega,
      data,
    } = createSaleDto;

    return this.prisma.$transaction(async (tx) => {
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
          throw new NotFoundException(
            `Produto com ID ${item.produtoId} não encontrado`,
          );
        }

        const variedadeId = item.variedadeId || null;

        if (variedadeId) {
          const variedade = produto.variedades.find(
            (v) => v.id === variedadeId,
          );
          if (!variedade) {
            throw new NotFoundException(
              `Variedade com ID ${variedadeId} não encontrada para o produto ${item.produtoId}`,
            );
          }
        }

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
      }

      // A conta de dinheiro mora em `sale-totals.ts`, e o recibo em PDF usa a
      // mesma. Duas cópias já discordaram em três pontos.
      const { total: totalVenda } = resumirVenda(itens, {
        descontoGeralTipo,
        descontoGeralValor,
        taxaEntrega,
      });

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

  async findAll(query: {
    limit?: number;
    offset?: number;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const { limit = 20, offset = 0, search, dateFrom, dateTo } = query;

    const where: Prisma.VendaWhereInput = {};
    if (search) {
      where.OR = [
        { observacoes: { contains: search, mode: 'insensitive' } },
        { usuario: { nome: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (dateFrom || dateTo) {
      where.data = {
        ...(dateFrom && { gte: new Date(dateFrom) }),
        ...(dateTo && {
          lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)),
        }),
      };
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
        orderBy: [{ data: 'desc' }, { id: 'desc' }],
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

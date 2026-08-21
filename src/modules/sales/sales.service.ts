import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { resumirVenda, conferirDescontos } from './sale-totals';
import { CreateSaleDto } from './dto/create-sale.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Desconto fixo não pode passar do que ele desconta.
   *
   * Recusar aqui, antes da transação, é o que impede uma venda meio-criada. O
   * corte em zero de `resumirVenda` continua existindo como defesa, mas deixa
   * de ser alcançável pelo caminho normal — e era ele que apagava o excesso em
   * silêncio, sem ninguém saber que o troco tinha sumido.
   */
  private validarDescontos(dto: CreateSaleDto) {
    const problemas = conferirDescontos(dto.itens, {
      descontoGeralTipo: dto.descontoGeralTipo,
      descontoGeralValor: dto.descontoGeralValor,
    });
    if (problemas.length === 0) return;

    const reais = (v: string) => `R$ ${Number(v).toFixed(2)}`;
    const mensagens = problemas.map((p) =>
      p.escopo === 'item'
        ? `Desconto do item ${(p.indice ?? 0) + 1} (${reais(p.valor)}) maior que o preço unitário (${reais(p.limite)})`
        : `Desconto geral (${reais(p.valor)}) maior que o total dos itens (${reais(p.limite)})`,
    );
    throw new BadRequestException(mensagens.join('; '));
  }

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

    this.validarDescontos(createSaleDto);

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

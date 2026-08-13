import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateExpressOrderDto } from './dto/create-express-order.dto';
import { generateOrderCode } from '../../common/utils/string-utils';
import { readLocalizedText } from '../../common/utils/localized-text';
import { Prisma, VariedadePedidoDireto } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ExpressOrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) { }

  async checkStatus(userId: string) {
    const client = await this.prisma.clientePedidoDireto.findUnique({
      where: { usuarioId: userId },
    });
    return { enabled: !!client?.habilitado };
  }

  async create(userId: string, dto: CreateExpressOrderDto) {
    // Check if user is enabled
    const client = await this.prisma.clientePedidoDireto.findUnique({
      where: { usuarioId: userId },
    });

    if (!client || !client.habilitado) {
      throw new ForbiddenException('User is not enabled for express orders');
    }

    // Calculate totals and validate products (batch — evita N+1)
    let totalValor = 0;
    const itemsData: {
      produtoId: number;
      variedadeId: number | null | undefined;
      quantidade: number;
      precoUnitario: number;
      subtotal: number;
    }[] = [];

    const productIds = [...new Set(dto.itens.map((item) => item.produtoId))];
    const varietyIds = [
      ...new Set(
        dto.itens
          .filter((item) => item.variedadeId)
          .map((item) => item.variedadeId as number),
      ),
    ];

    const [products, enabledProducts, enabledVarieties] = await Promise.all([
      this.prisma.produto.findMany({
        where: { id: { in: productIds } },
        include: { variedades: true },
      }),
      this.prisma.produtoPedidoDireto.findMany({
        where: { produtoId: { in: productIds }, habilitado: true },
      }),
      varietyIds.length > 0
        ? this.prisma.variedadePedidoDireto.findMany({
            where: { variedadeId: { in: varietyIds }, habilitado: true },
          })
        : Promise.resolve<VariedadePedidoDireto[]>([]),
    ]);

    const productMap = new Map(products.map((product) => [product.id, product]));
    const enabledProductIds = new Set(enabledProducts.map((entry) => entry.produtoId));
    const enabledVarietyIds = new Set(enabledVarieties.map((entry) => entry.variedadeId));

    for (const item of dto.itens) {
      const product = productMap.get(item.produtoId);

      if (!product) {
        throw new NotFoundException(`Product ${item.produtoId} not found`);
      }

      let price = Number(product.preco);
      let variety: typeof product.variedades[0] | null | undefined = null;

      if (item.variedadeId) {
        variety = product.variedades.find((v) => v.id === item.variedadeId);
        if (!variety) {
          throw new NotFoundException(`Variety ${item.variedadeId} not found`);
        }

        if (!enabledVarietyIds.has(item.variedadeId)) {
          const vName = readLocalizedText(variety.nome, 'Variety');
          throw new BadRequestException(`Variety ${vName} is not available for express orders`);
        }
        price = Number(variety.preco);
      } else if (!enabledProductIds.has(item.produtoId)) {
        const name = readLocalizedText(product.nome, 'Product');
        throw new BadRequestException(`Product ${name} is not available for express orders`);
      }

      const subtotal = price * item.quantidade;
      totalValor += subtotal;

      itemsData.push({
        produtoId: item.produtoId,
        variedadeId: item.variedadeId,
        quantidade: item.quantidade,
        precoUnitario: price,
        subtotal: subtotal,
      });
    }

    if (totalValor < 60) {
      throw new BadRequestException('Minimum order value is R$ 60,00');
    }

    // Generate unique random code
    let codigo = '';
    let isUnique = false;
    while (!isUnique) {
      codigo = generateOrderCode(6);
      const existingCode = await this.prisma.pedidoDireto.findUnique({
        where: { codigo },
      });
      if (!existingCode) isUnique = true;
    }

    // Create order
    const order = await this.prisma.pedidoDireto.create({
      data: {
        usuarioId: userId,
        codigo: codigo,
        observacoes: dto.observacoes,
        totalValor: totalValor,
        status: 'pendente',
        dataEntrega: dto.dataEntrega ? new Date(dto.dataEntrega) : new Date(),
        itens: {
          create: itemsData,
        },
      },
      include: {
        usuario: { select: { id: true, nome: true } },
        itens: true,
      },
    });

    // Notificar administradores sobre o novo pedido expresso
    try {
      const admins = await this.prisma.usuario.findMany({
        where: { role: 'admin' },
        select: { id: true }
      });

      const targetAdmins = admins.map(a => a.id).filter(adminId => adminId !== userId);

      if (targetAdmins.length > 0) {
        await this.notificationsService.broadcastNotification({
          usuarioIds: targetAdmins,
          chave: 'notification.expressOrderCreated',
          parametros: { userName: order.usuario.nome, orderCode: order.codigo ?? '' },
          pedidoDiretoId: order.id,
          tipo: 'admin',
        });
      }
    } catch (error) {
      console.error('Erro ao notificar admins sobre pedido expresso:', error);
    }

    return order;
  }

  async findAll(status?: string, skip = 0, take = 10) {
    const where = status ? { status } : {};
    return this.prisma.pedidoDireto.findMany({
      where,
      include: {
        usuario: { select: { id: true, nome: true, email: true } },
        itens: {
          include: {
            produto: { select: { nome: true } },
            variedade: { select: { nome: true } },
          },
        },
      },
      orderBy: [{ dataPedido: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
  }

  async findMyOrders(userId: string, skip = 0, take = 10) {
    return this.prisma.pedidoDireto.findMany({
      where: { usuarioId: userId },
      include: {
        itens: {
          include: {
            produto: { select: { nome: true } },
            variedade: { select: { nome: true } },
          },
        },
      },
      orderBy: [{ dataPedido: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
  }

  /** `Produto.categoria` é coluna JSON; sem `ordem` numérica, vai para o fim. */
  private readCategoriaOrdem(categoria: unknown): number {
    if (categoria && typeof categoria === 'object' && !Array.isArray(categoria)) {
      const ordem = (categoria as { ordem?: unknown }).ordem;
      if (typeof ordem === 'number') return ordem;
    }
    return 999;
  }

  async findOne(id: number, user: { id: string; role?: string }) {
    const order = await this.prisma.pedidoDireto.findUnique({
      where: { id },
      include: {
        usuario: { select: { id: true, nome: true, email: true, telefone: true, endereco: true } },
        itens: {
          include: {
            produto: { select: { nome: true } },
            variedade: { select: { nome: true } },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (user.role !== 'admin' && order.usuarioId !== user.id) {
      throw new ForbiddenException('Access denied');
    }

    return order;
  }

  async updateStatus(id: number, status: string, adminUserId: string, observacoes?: string) {
    if (status === 'entregue') {
      let wasAlreadyDelivered = false;

      const updatedOrder = await this.prisma.$transaction(async (tx) => {
        const order = await tx.pedidoDireto.findUnique({
          where: { id },
          include: { itens: true },
        });

        if (!order) {
          throw new NotFoundException('Order not found');
        }

        if (order.status === 'entregue' && order.vendaId) {
          wasAlreadyDelivered = true;
          return tx.pedidoDireto.findUnique({
            where: { id },
            include: { usuario: { select: { id: true, nome: true } } },
          });
        }

        const data: Record<string, unknown> = {
          status: 'entregue',
          entregueEm: new Date(),
          entreguePor: adminUserId,
        };

        if (observacoes !== undefined) {
          data.observacoes = observacoes;
        }

        if (!order.vendaId) {
          let total = new Prisma.Decimal(0);
          for (const item of order.itens) {
            total = total.add(new Prisma.Decimal(item.precoUnitario).mul(item.quantidade));
          }

          const venda = await tx.venda.create({
            data: {
              usuarioId: order.usuarioId,
              observacoes: `Pedido Express #${order.codigo || order.id}`,
              total,
              criadoPor: adminUserId,
              itens: {
                create: order.itens.map(item => ({
                  produtoId: item.produtoId,
                  variedadeId: item.variedadeId ?? null,
                  quantidade: item.quantidade,
                  precoUnitario: item.precoUnitario,
                  tipoDesconto: null,
                  valorDesconto: 0,
                })),
              },
            },
          });
          data.vendaId = venda.id;
        }

        return tx.pedidoDireto.update({
          where: { id },
          data,
          include: {
            usuario: { select: { id: true, nome: true } },
          },
        });
      });

      if (!updatedOrder) {
        throw new NotFoundException('Order not found');
      }

      if (!wasAlreadyDelivered) {
        try {
          await this.notificationsService.createAndSendNotification({
            usuarioId: updatedOrder.usuarioId,
            chave: 'notification.expressOrderDelivered',
            parametros: { orderCode: updatedOrder.codigo ?? '' },
            pedidoDiretoId: updatedOrder.id,
            tipo: 'user',
          });
        } catch (error) {
          console.error('Erro ao notificar usuário sobre status do pedido express:', error);
        }
      }

      return updatedOrder;
    }

    const data: Prisma.PedidoDiretoUpdateInput = { status };

    if (observacoes !== undefined) {
      data.observacoes = observacoes;
    }

    if (status === 'confirmado') {
      data.confirmadoEm = new Date();
      data.confirmadoPor = adminUserId;
      data.entregueEm = null;
    } else if (status === 'pendente') {
      data.confirmadoEm = null;
      data.confirmadoPor = null;
      data.entregueEm = null;
      data.entreguePor = null;
    }

    const updatedOrder = await this.prisma.pedidoDireto.update({
      where: { id },
      data,
      include: {
        usuario: { select: { id: true, nome: true } }
      }
    });

    // Notificar o usuário sobre a mudança de status
    try {
      const chave = 'notification.expressOrderConfirmed';

      await this.notificationsService.createAndSendNotification({
        usuarioId: updatedOrder.usuarioId,
        chave,
        parametros: { orderCode: updatedOrder.codigo ?? '' },
        pedidoDiretoId: updatedOrder.id,
        tipo: 'user',
      });
    } catch (error) {
      console.error('Erro ao notificar usuário sobre status do pedido express:', error);
    }

    return updatedOrder;
  }

  async cancelOrder(id: number, userId: string) {
    const order = await this.prisma.pedidoDireto.findUnique({
      where: { id },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.usuarioId !== userId) {
      throw new ForbiddenException('You can only cancel your own orders');
    }

    if (order.status !== 'pendente') {
      throw new BadRequestException('Only pending orders can be cancelled');
    }

    const cancelledOrder = await this.prisma.pedidoDireto.update({
      where: { id },
      data: { status: 'cancelado' },
    });

    // Notificar admins sobre o cancelamento pelo usuário
    try {
      const admins = await this.prisma.usuario.findMany({ where: { role: 'admin' }, select: { id: true } });
      const targetAdmins = admins.map(a => a.id).filter(adminId => adminId !== userId);
      if (targetAdmins.length > 0) {
        await this.notificationsService.broadcastNotification({
          usuarioIds: targetAdmins,
          chave: 'notification.expressOrderCancelled',
          parametros: { orderCode: order.codigo ?? '' },
          pedidoDiretoId: order.id,
          tipo: 'admin',
        });
      }
    } catch (error) {
      console.error('Erro ao notificar admins sobre cancelamento de pedido expresso:', error);
    }

    return cancelledOrder;
  }

  async findAllClients() {
    return this.prisma.usuario.findMany({
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
        clientePedidoDireto: {
          select: { habilitado: true },
        },
      },
      orderBy: [{ nome: 'asc' }, { id: 'asc' }],
    });
  }

  async toggleClient(userId: string, habilitado: boolean) {
    return this.prisma.clientePedidoDireto.upsert({
      where: { usuarioId: userId },
      update: { habilitado },
      create: {
        usuarioId: userId,
        habilitado,
      },
    });
  }

  async findAllProducts() {
    const products = await this.prisma.produto.findMany({
      where: { ativo: true },
      include: {
        produtosPedidoDireto: {
          select: { habilitado: true },
        },
        variedades: {
          include: {
            variedadesPedidoDireto: {
              select: { habilitado: true }
            }
          },
          orderBy: { id: 'asc' }
        },
      },
    });

    return products.sort((a, b) => {
      const catOrderA = this.readCategoriaOrdem(a.categoria);
      const catOrderB = this.readCategoriaOrdem(b.categoria);

      if (catOrderA !== catOrderB) {
        return catOrderA - catOrderB;
      }

      const nameA = readLocalizedText(a.nome);
      const nameB = readLocalizedText(b.nome);
      return nameA.localeCompare(nameB);
    });
  }

  async toggleProduct(produtoId: number, habilitado: boolean) {
    // Check if relation exists first
    const existing = await this.prisma.produtoPedidoDireto.findFirst({
      where: { produtoId }
    });

    if (existing) {
      return this.prisma.produtoPedidoDireto.update({
        where: { id: existing.id },
        data: { habilitado }
      });
    } else {
      return this.prisma.produtoPedidoDireto.create({
        data: {
          produtoId,
          habilitado
        }
      });
    }
  }
  async toggleVariety(variedadeId: number, habilitado: boolean) {
    // Check if relation exists first
    const existing = await this.prisma.variedadePedidoDireto.findUnique({
      where: { variedadeId }
    });

    if (existing) {
      return this.prisma.variedadePedidoDireto.update({
        where: { id: existing.id },
        data: { habilitado }
      });
    } else {
      return this.prisma.variedadePedidoDireto.create({
        data: {
          variedadeId,
          habilitado
        }
      });
    }
  }
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto } from './dto';
import {
  comprovanteNovo,
  pagamentoJaCobre,
  reembolsoNaConfirmacao,
  situacaoDoPagamento,
  valorPagoNoRevert,
  type EscolhaDoCliente,
} from './pagamento-diferenca';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { QrCodePix } from 'qrcode-pix';
import { StorageService } from '../../config/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CronLockService } from '../../common/cron/cron-lock.service';
import { CRON_LOCK_KEYS } from '../../common/runtime/runtime.config';

import { generateOrderCode } from '../../common/utils/string-utils';
import { Prisma } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private configuracoesService: ConfiguracoesService,
    private storageService: StorageService,
    private notificationsService: NotificationsService,
    private cronLockService: CronLockService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  private formatAddress(
    address: Prisma.InputJsonValue | undefined,
  ): string | null {
    if (!address) return null;
    if (typeof address === 'string') return address.trim();

    if (typeof address !== 'object') return String(address);

    const { logradouro, numero, bairro, cidade, estado } = address as {
      logradouro?: string;
      numero?: string;
      bairro?: string;
      cidade?: string;
      estado?: string;
    };
    if (logradouro && numero && bairro && cidade && estado) {
      return `${logradouro}, ${numero}, ${bairro}, ${cidade} - ${estado}`;
    }

    // If it lacks some fields but has others, try to construct what's available
    if (logradouro && numero) {
      let addr = `${logradouro}, ${numero}`;
      if (bairro) addr += `, ${bairro}`;
      if (cidade && estado) addr += `, ${cidade} - ${estado}`;
      return addr;
    }

    return typeof address === 'object'
      ? JSON.stringify(address)
      : String(address);
  }

  private getPickupDateTime(
    dataEntrega: Date,
    horarioRetirada?: string,
  ): Date | null {
    if (!horarioRetirada) return null;
    const [hoursStr, minutesStr] = horarioRetirada.split(':');
    const hours = Number(hoursStr);
    const minutes = Number(minutesStr);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      throw new BadRequestException('Horário de retirada inválido');
    }
    if (hours < 8 || hours > 14 || minutes < 0 || minutes > 59) {
      throw new BadRequestException(
        'O horário de retirada deve estar entre 08:00 e 14:59',
      );
    }

    // Build the pickup instant explicitly in Sao Paulo timezone (-03:00),
    // independent of server timezone. This matches route ETA persistence behavior
    // (store an absolute instant in timestamptz).
    const deliveryDatePart = dataEntrega.toISOString().split('T')[0];
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    return new Date(`${deliveryDatePart}T${hh}:${mm}:00-03:00`);
  }

  private async notifyOrderUpdatedToAdmins(
    orderId: number,
    actorUserId: string,
    chave = 'notification.orderUpdated',
  ) {
    try {
      const [order, actor, admins] = await Promise.all([
        this.prisma.pedidoEncomenda.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            codigo: true,
            usuario: { select: { nome: true } },
          },
        }),
        this.prisma.usuario.findUnique({
          where: { id: actorUserId },
          select: { id: true, nome: true, role: true },
        }),
        this.prisma.usuario.findMany({
          where: { role: 'admin' },
          select: { id: true },
        }),
      ]);

      if (!order || admins.length === 0) return;

      const targetAdmins = admins
        .map((a) => a.id)
        .filter((adminId) => adminId !== actorUserId);

      if (targetAdmins.length === 0) return;

      await this.notificationsService.broadcastNotification({
        usuarioIds: targetAdmins,
        chave,
        parametros: {
          userName: order.usuario?.nome || actor?.nome || 'Usuário',
          orderCode: order.codigo ?? '',
        },
        pedidoEncomendaId: order.id,
        tipo: 'admin',
      });
    } catch (error) {
      console.error(
        'Erro ao notificar admins sobre atualização de pedido:',
        error,
      );
    }
  }

  private async calculateDeliveryFee(
    subtotal: number,
    tipoEntrega?: string,
    enderecoEspecialNome?: string,
  ) {
    if (tipoEntrega === 'retirada') return 0;

    const config = await this.configuracoesService.get();
    if (!config) return 12.0; // Fallback to default base fee

    // 1. Check Special Address (dynamic/divided fee)
    if (enderecoEspecialNome) {
      // These are blocked/divided fees, initially 0 or a placeholder.
      // The system handles them later after form closure.
      return 0;
    }

    // 2. Check thresholds for discount/exemption
    const subtotalNum = Number(subtotal);
    const valorMinimoIsencao = Number(config.valorMinimoIsencao);
    const valorMinimoTaxaReduzida = Number(config.valorMinimoTaxaReduzida);

    if (subtotalNum >= valorMinimoIsencao) {
      return 0;
    } else if (subtotalNum >= valorMinimoTaxaReduzida) {
      return Number(config.taxaEntregaReduzida);
    }

    return Number(config.taxaEntregaBase);
  }

  async create(userId: string, createOrderDto: CreateOrderDto) {
    const { dataEncomendaId, itens, horarioRetirada, ...orderData } =
      createOrderDto;

    // Check if order date exists and is active
    const dataEncomenda = await this.prisma.dataEncomenda.findUnique({
      where: { id: dataEncomendaId },
    });

    if (!dataEncomenda) {
      throw new NotFoundException(
        `Data de encomenda com ID ${dataEncomendaId} não encontrada`,
      );
    }

    if (!dataEncomenda.ativo) {
      throw new BadRequestException(
        'Esta data de encomenda não está mais ativa',
      );
    }

    // Check ordering window
    const now = new Date();
    const deadline = new Date(dataEncomenda.dataLimitePedido);
    if (now > deadline) {
      throw new BadRequestException(
        'O prazo para pedidos nesta data já encerrou',
      );
    }
    if (
      dataEncomenda.dataInicioPedido &&
      now < new Date(dataEncomenda.dataInicioPedido)
    ) {
      throw new BadRequestException(
        'Os pedidos para esta data ainda não estão abertos',
      );
    }

    // Check if user already has an order for this order form
    const existingOrder = await this.prisma.pedidoEncomenda.findFirst({
      where: {
        usuarioId: userId,
        dataEncomendaId: dataEncomendaId,
      },
    });

    if (existingOrder && existingOrder.statusPagamento !== 'cancelado') {
      throw new BadRequestException(
        'Você já possui um pedido para esta data de entrega. Edite o pedido existente ou cancele-o para criar um novo.',
      );
    }

    // Calculate total value
    let totalValor = 0;

    // Verify products and varieties, calculate prices
    const itemPromises = itens.map(async (item) => {
      const produto = await this.prisma.produto.findUnique({
        where: { id: item.produtoId },
        include: { variedades: true },
      });

      if (!produto) {
        throw new NotFoundException(
          `Produto com ID ${item.produtoId} não encontrado`,
        );
      }

      let precoUnitario = produto.preco ? Number(produto.preco) : 0;
      const variedadeId = item.variedadeId;

      if (variedadeId) {
        const variedade = produto.variedades.find((v) => v.id === variedadeId);
        if (!variedade) {
          throw new NotFoundException(
            `Variedade com ID ${variedadeId} não encontrada para o produto ${item.produtoId}`,
          );
        }
        // Some products keep the effective price only at product level.
        // In this case, fallback to base product price when variety price is missing/zero.
        const varietyPrice = Number(variedade.preco ?? 0);
        precoUnitario =
          varietyPrice > 0
            ? varietyPrice
            : produto.preco
              ? Number(produto.preco)
              : 0;
      }

      totalValor += precoUnitario * item.quantidade;

      return {
        produtoId: item.produtoId,
        variedadeId: item.variedadeId,
        quantidade: item.quantidade,
        precoUnitario: precoUnitario, // Store historical price
      };
    });

    const processedItens = await Promise.all(itemPromises);

    // Calculate delivery fee
    const taxaEntrega = await this.calculateDeliveryFee(
      totalValor,
      createOrderDto.tipoEntrega,
      createOrderDto.enderecoEspecialNome,
    );

    // Add fee to total
    totalValor += taxaEntrega;

    // Initial status
    let statusPagamento = 'pendente';
    if (orderData.enderecoEspecialNome) {
      statusPagamento = 'bloqueado';
    }

    // Defensive address formatting
    if (orderData.enderecoEntrega) {
      const formatted = this.formatAddress(orderData.enderecoEntrega);
      if (formatted !== null) orderData.enderecoEntrega = formatted;
    }

    const horarioRetiradaDate =
      orderData.tipoEntrega === 'retirada'
        ? this.getPickupDateTime(dataEncomenda.dataEntrega, horarioRetirada)
        : null;

    // Generate unique random code
    let codigo = '';
    let isUnique = false;
    while (!isUnique) {
      codigo = generateOrderCode(6);
      const existingCode = await this.prisma.pedidoEncomenda.findUnique({
        where: { codigo },
      });
      if (!existingCode) isUnique = true;
    }

    // Quem tinha notificação de cancelamento apagada na reciclagem abaixo. É
    // preciso ler antes de apagar: `deleteMany` só devolve a contagem, e os
    // donos não são um só — o cancelamento feito pelo cliente notifica os
    // admins, e o feito pelo admin notifica o cliente.
    let donosDeNotificacaoLimpa: string[] = [];

    // Create or reuse cancelled order with transaction to ensure integrity
    const order = await this.prisma.$transaction(async (tx) => {
      if (existingOrder && existingOrder.statusPagamento === 'cancelado') {
        await tx.itemPedidoEncomenda.deleteMany({
          where: { pedidoId: existingOrder.id },
        });
        // Cleanup stale cancellation notifications tied to this recycled order.
        const filtroObsoletas = {
          pedidoEncomendaId: existingOrder.id,
          titulo: {
            in: [
              'notification.orderCancelledByUser.title',
              'notification.orderCancelledByAdmin.title',
            ],
          },
        };

        const obsoletas = await tx.notificacao.findMany({
          where: filtroObsoletas,
          select: { usuarioId: true },
        });
        donosDeNotificacaoLimpa = [
          ...new Set(obsoletas.map((n) => n.usuarioId)),
        ];

        await tx.notificacao.deleteMany({ where: filtroObsoletas });

        const recycledOrder = await tx.pedidoEncomenda.update({
          where: { id: existingOrder.id },
          data: {
            codigo: codigo,
            dataPedido: new Date(),
            ...orderData,
            horarioEstimadoEntrega: horarioRetiradaDate,
            totalValor: totalValor,
            taxaEntrega: taxaEntrega,
            statusPagamento: statusPagamento,
            statusPagamentoAnterior: null,
            dataPagamento: null,
            confirmadoPor: null,
            comprovanteUrl: null,
            emEntrega: false,
            itens: {
              create: processedItens.map((item) => ({
                produtoId: item.produtoId,
                variedadeId: item.variedadeId,
                quantidade: item.quantidade,
                precoUnitario: item.precoUnitario,
              })),
            },
          },
          include: {
            usuario: { select: { id: true, nome: true } },
            itens: {
              include: {
                produto: true,
                variedade: true,
              },
            },
          },
        });

        return recycledOrder;
      }

      const newOrder = await tx.pedidoEncomenda.create({
        data: {
          usuarioId: userId,
          dataEncomendaId: dataEncomendaId,
          codigo: codigo,
          ...orderData,
          horarioEstimadoEntrega: horarioRetiradaDate,
          totalValor: totalValor,
          taxaEntrega: taxaEntrega,
          statusPagamento: statusPagamento,
          itens: {
            create: processedItens.map((item) => ({
              produtoId: item.produtoId,
              variedadeId: item.variedadeId,
              quantidade: item.quantidade,
              precoUnitario: item.precoUnitario,
            })),
          },
        },
        include: {
          usuario: { select: { id: true, nome: true } },
          itens: {
            include: {
              produto: true,
              variedade: true,
            },
          },
        },
      });

      return newOrder;
    });

    // Só depois do commit: se a transação voltasse atrás, as notificações
    // continuariam lá e o aviso teria mandado apagar da tela o que existe.
    for (const usuarioId of donosDeNotificacaoLimpa) {
      this.realtimeGateway.broadcastToUser(
        usuarioId,
        'notificacoes',
        'DELETE',
        {
          usuarioId,
          pedidoEncomendaId: order.id,
        },
      );
    }

    // Notificar administradores sobre o novo pedido
    try {
      const admins = await this.prisma.usuario.findMany({
        where: { role: 'admin' },
        select: { id: true },
      });

      const targetAdmins = admins
        .map((a) => a.id)
        .filter((adminId) => adminId !== userId);

      if (targetAdmins.length > 0) {
        await this.notificationsService.broadcastNotification({
          usuarioIds: targetAdmins,
          chave: 'notification.orderCreated',
          parametros: {
            userName: order.usuario.nome,
            orderCode: order.codigo ?? '',
          },
          dataEncomendaId: order.dataEncomendaId,
          pedidoEncomendaId: order.id,
          tipo: 'admin',
        });
      }
    } catch (error) {
      console.error('Erro ao notificar admins sobre novo pedido:', error);
    }

    // If it's a special address, recalculate fees for everyone there
    if (order.enderecoEspecialNome) {
      await this.recalculateSharedFees(
        order.dataEncomendaId,
        order.enderecoEspecialNome,
      );
      // Reload order after recalculation
      return this.findOne(order.id, userId);
    }

    return order;
  }

  async recalculateSharedFees(
    dataEncomendaId: number,
    specialAddressName: string,
  ) {
    // Find all orders for this form and special address that are not yet finalized (paid/cancelled)
    const orders = await this.prisma.pedidoEncomenda.findMany({
      where: {
        dataEncomendaId,
        enderecoEspecialNome: specialAddressName,
        statusPagamento: { in: ['bloqueado', 'pendente'] },
      },
    });

    if (orders.length === 0) return;

    // Calculate total subtotal
    let totalSubtotal = 0;
    orders.forEach((order) => {
      const subtotal = Number(order.totalValor) - Number(order.taxaEntrega);
      totalSubtotal += subtotal;
    });

    // Tiered Fee:
    // Total < 100: R$ 12
    // Total < 130: R$ 8
    // Total >= 130: Grátis
    let totalFee = 0;
    if (totalSubtotal < 100) {
      totalFee = 12;
    } else if (totalSubtotal < 130) {
      totalFee = 8;
    } else {
      totalFee = 0;
    }

    // Divide fee equally
    const sharedFee = totalFee / orders.length;

    // Update all orders
    await this.prisma.$transaction(
      orders.map((order) => {
        const subtotal = Number(order.totalValor) - Number(order.taxaEntrega);
        const newTotal = subtotal + sharedFee;
        return this.prisma.pedidoEncomenda.update({
          where: { id: order.id },
          data: {
            taxaEntrega: sharedFee,
            totalValor: newTotal,
          },
        });
      }),
    );

    // Avisa as telas de **todos** os pedidos afetados, não só o que originou a
    // mudança: entrar ou sair de um ponto de entrega comum altera a taxa e o
    // total de quem já estava lá. Sem isto, esses clientes veem um valor
    // desatualizado até recarregar a tela na mão.
    for (const order of orders) {
      this.realtimeGateway.broadcast('pedidos_encomenda', 'UPDATE', {
        id: order.id,
        dataEncomendaId,
        statusPagamento: order.statusPagamento,
      });
    }
  }

  async findByOrderForm(
    formId: number,
    search?: string,
    skip = 0,
    take?: number,
  ) {
    const where: Prisma.PedidoEncomendaWhereInput = {
      dataEncomendaId: formId,
    };

    if (search) {
      where.OR = [
        { codigo: { contains: search, mode: 'insensitive' } },
        { usuario: { nome: { contains: search, mode: 'insensitive' } } },
        { usuario: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const orders = await this.prisma.pedidoEncomenda.findMany({
      where,
      orderBy: [{ dataPedido: 'desc' }, { id: 'desc' }],
      skip,
      ...(take !== undefined ? { take } : {}),
      include: {
        usuario: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    return orders;
  }

  /** Status efetivo para leitura — sem writes no GET. */
  private withResolvedPaymentStatus<
    T extends {
      statusPagamento: string;
      enderecoEspecialNome: string | null;
      dataEncomenda: { dataLimitePedido: Date };
    },
  >(order: T, now = new Date()): T {
    const deadline = new Date(order.dataEncomenda.dataLimitePedido);
    let statusPagamento = order.statusPagamento;

    if (statusPagamento === 'bloqueado' && now > deadline) {
      statusPagamento = 'pendente';
    } else if (
      statusPagamento === 'pendente' &&
      order.enderecoEspecialNome &&
      now <= deadline
    ) {
      statusPagamento = 'bloqueado';
    }

    if (statusPagamento === order.statusPagamento) {
      return order;
    }

    return { ...order, statusPagamento };
  }

  async findAll(userId: string, skip = 0, take = 10) {
    const orders = await this.prisma.pedidoEncomenda.findMany({
      where: { usuarioId: userId },
      orderBy: [{ dataPedido: 'desc' }, { id: 'desc' }],
      skip,
      take,
      include: {
        dataEncomenda: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    const now = new Date();
    return orders.map((order) => this.withResolvedPaymentStatus(order, now));
  }

  /** Persiste lock/unlock de pagamento — antes executado em cada GET. */
  @Cron(CronExpression.EVERY_MINUTE)
  async syncPaymentLockStatuses() {
    await this.cronLockService.withLock(
      CRON_LOCK_KEYS.PAYMENT_LOCK_SYNC,
      'syncPaymentLockStatuses',
      async () => {
        const now = new Date();

        const unlocked = await this.prisma.pedidoEncomenda.updateMany({
          where: {
            statusPagamento: 'bloqueado',
            dataEncomenda: { dataLimitePedido: { lt: now } },
          },
          data: { statusPagamento: 'pendente' },
        });

        const toLock = await this.prisma.pedidoEncomenda.findMany({
          where: {
            statusPagamento: 'pendente',
            enderecoEspecialNome: { not: null },
            dataEncomenda: { dataLimitePedido: { gte: now } },
          },
          select: { id: true },
        });

        let locked = { count: 0 };
        if (toLock.length > 0) {
          locked = await this.prisma.pedidoEncomenda.updateMany({
            where: { id: { in: toLock.map((o) => o.id) } },
            data: { statusPagamento: 'bloqueado' },
          });
        }

        if (unlocked.count > 0 || locked.count > 0) {
          this.logger.debug(
            `Payment lock sync: unlocked=${unlocked.count}, locked=${locked.count}`,
          );
        }
      },
    );
  }

  async findOne(id: number, userId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: {
        comprovantes: { orderBy: { criadoEm: 'asc' } },
        dataEncomenda: true,
        usuario: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    // Ensure user owns the order or is an admin.
    if (order.usuarioId !== userId) {
      const user = await this.prisma.usuario.findUnique({
        where: { id: userId },
      });
      if (user?.role !== 'admin') {
        throw new NotFoundException(`Pedido com ID ${id} não encontrado`); // Don't leak existence
      }
    }

    // Automatic UNLOCK/LOCK Logic
    const now = new Date();
    const deadline = new Date(order.dataEncomenda.dataLimitePedido);

    // 1. UNLOCK: if blocked and deadline passed -> pendente
    if (order.statusPagamento === 'bloqueado' && now > deadline) {
      const updatedOrder = await this.prisma.pedidoEncomenda.update({
        where: { id: order.id },
        data: { statusPagamento: 'pendente' },
        include: {
          dataEncomenda: true,
          itens: {
            include: {
              produto: true,
              variedade: true,
            },
          },
        },
      });
      return updatedOrder;
    }

    // 2. LOCK: if pending, special address, and deadline NOT passed -> bloqueado
    // This ensures orders revert to blocked if deadline is extended
    if (
      order.statusPagamento === 'pendente' &&
      order.enderecoEspecialNome &&
      now <= deadline
    ) {
      const updatedOrder = await this.prisma.pedidoEncomenda.update({
        where: { id: order.id },
        data: { statusPagamento: 'bloqueado' },
        include: {
          dataEncomenda: true,
          itens: {
            include: {
              produto: true,
              variedade: true,
            },
          },
        },
      });
      return updatedOrder;
    }

    return order;
  }

  async update(id: number, userId: string, updateOrderDto: UpdateOrderDto) {
    const atualizado = await this.atualizarItensEDados(
      id,
      userId,
      updateOrderDto,
    );
    return (await this.moverParaAnaliseSeJaCoberto(id, userId)) ?? atualizado;
  }

  /**
   * Pedido já pago, revertido para o cliente editar, cujo novo total o valor
   * pago cobre: não há o que cobrar, então vai direto para análise, e os admins
   * são avisados — sem isso ele entraria na fila sem comprovante novo e sem
   * aviso. Devolve o pedido atualizado, ou `null` quando a regra não se aplica.
   *
   * Só vale para `pendente`: pedido de ponto especial fica `bloqueado` até o
   * prazo e, se saísse da divisão da taxa compartilhada agora, mudaria o total
   * dos vizinhos (`recalculateSharedFees` só considera pendente e bloqueado).
   */
  private async moverParaAnaliseSeJaCoberto(id: number, userId: string) {
    const pedido = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      select: { totalValor: true, valorPago: true, statusPagamento: true },
    });
    if (
      !pedido ||
      pedido.statusPagamento !== 'pendente' ||
      !pagamentoJaCobre(pedido)
    ) {
      return null;
    }

    const atualizado = await this.prisma.pedidoEncomenda.update({
      where: { id },
      data: {
        statusPagamento: 'aguardando_confirmacao',
        statusPagamentoAnterior: pedido.statusPagamento,
      },
      include: {
        comprovantes: { orderBy: { criadoEm: 'asc' } },
        dataEncomenda: true,
        itens: { include: { produto: true, variedade: true } },
      },
    });

    await this.notifyOrderUpdatedToAdmins(
      id,
      userId,
      'notification.paymentCoveredAwaiting',
    );
    return atualizado;
  }

  private async atualizarItensEDados(
    id: number,
    userId: string,
    updateOrderDto: UpdateOrderDto,
  ) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: {
        dataEncomenda: true,
        itens: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    // Check ownership
    if (order.usuarioId !== userId) {
      const user = await this.prisma.usuario.findUnique({
        where: { id: userId },
      });
      if (user?.role !== 'admin') {
        throw new ForbiddenException(
          'Você não tem permissão para editar este pedido',
        );
      }
    }

    // Check if order can be edited (only pending or blocked status)
    if (!['pendente', 'bloqueado'].includes(order.statusPagamento)) {
      throw new BadRequestException(
        'Apenas pedidos pendentes podem ser editados',
      );
    }

    // Check deadline
    const now = new Date();
    const deadline = new Date(order.dataEncomenda.dataLimitePedido);
    if (now > deadline) {
      throw new BadRequestException(
        'O prazo para edição deste pedido já expirou',
      );
    }

    const { itens, horarioRetirada, ...orderData } = updateOrderDto;

    let totalValor = 0;
    let processedItens: {
      produtoId: number;
      variedadeId: number | null | undefined;
      quantidade: number;
      precoUnitario: number;
    }[] = [];

    // If items are being updated, recalculate everything
    if (itens && itens.length > 0) {
      // Calculate new total and validate products
      const itemPromises = itens.map(async (item) => {
        const produto = await this.prisma.produto.findUnique({
          where: { id: item.produtoId },
          include: { variedades: true },
        });

        if (!produto) {
          throw new NotFoundException(
            `Produto com ID ${item.produtoId} não encontrado`,
          );
        }

        let precoUnitario = produto.preco ? Number(produto.preco) : 0;
        const variedadeId = item.variedadeId;

        if (variedadeId) {
          const variedade = produto.variedades.find(
            (v) => v.id === variedadeId,
          );
          if (!variedade) {
            throw new NotFoundException(
              `Variedade com ID ${variedadeId} não encontrada para o produto ${item.produtoId}`,
            );
          }
          const varietyPrice = Number(variedade.preco ?? 0);
          precoUnitario =
            varietyPrice > 0
              ? varietyPrice
              : produto.preco
                ? Number(produto.preco)
                : 0;
        }

        totalValor += precoUnitario * item.quantidade;

        return {
          produtoId: item.produtoId,
          variedadeId: item.variedadeId,
          quantidade: item.quantidade,
          precoUnitario: precoUnitario,
        };
      });

      processedItens = await Promise.all(itemPromises);

      // Update with new items using transaction
      const updatedOrder = await this.prisma.$transaction(async (tx) => {
        // Delete old items
        await tx.itemPedidoEncomenda.deleteMany({
          where: { pedidoId: id },
        });

        // Determine new status based on special address
        let statusPagamento = order.statusPagamento;
        if (
          orderData.enderecoEspecialNome &&
          (order.statusPagamento === 'pendente' ||
            order.statusPagamento === 'confirmado')
        ) {
          statusPagamento = 'bloqueado';
        } else if (
          !orderData.enderecoEspecialNome &&
          order.statusPagamento === 'bloqueado'
        ) {
          statusPagamento = 'pendente';
        }

        // Calculate delivery fee using unified method
        const taxaEntrega = await this.calculateDeliveryFee(
          totalValor,
          (orderData.tipoEntrega || order.tipoEntrega) ?? undefined,
          (orderData.enderecoEspecialNome || order.enderecoEspecialNome) ??
            undefined,
        );

        const finalTotal = totalValor + taxaEntrega;
        const nextTipoEntrega =
          (orderData.tipoEntrega || order.tipoEntrega) ?? undefined;
        const horarioRetiradaDate =
          nextTipoEntrega === 'retirada'
            ? horarioRetirada
              ? this.getPickupDateTime(
                  order.dataEncomenda.dataEntrega,
                  horarioRetirada,
                )
              : (order.horarioEstimadoEntrega ?? null)
            : null;

        // Update order
        const updated = await tx.pedidoEncomenda.update({
          where: { id },
          data: {
            ...orderData,
            horarioEstimadoEntrega: horarioRetiradaDate,
            totalValor: finalTotal,
            taxaEntrega,
            statusPagamento,
            itens: {
              create: processedItens.map((item) => ({
                produtoId: item.produtoId,
                variedadeId: item.variedadeId,
                quantidade: item.quantidade,
                precoUnitario: item.precoUnitario,
              })),
            },
          },
          include: {
            dataEncomenda: true,
            itens: {
              include: {
                produto: true,
                variedade: true,
              },
            },
          },
        });

        return updated;
      });

      // Recalculate shared fees if special address
      if (updatedOrder.enderecoEspecialNome) {
        await this.recalculateSharedFees(
          updatedOrder.dataEncomendaId,
          updatedOrder.enderecoEspecialNome,
        );
        const reloadedOrder = await this.findOne(updatedOrder.id, userId);
        await this.notifyOrderUpdatedToAdmins(updatedOrder.id, userId);
        return reloadedOrder;
      }

      // If was special address before but not now, recalculate old group
      if (order.enderecoEspecialNome && !updatedOrder.enderecoEspecialNome) {
        await this.recalculateSharedFees(
          order.dataEncomendaId,
          order.enderecoEspecialNome,
        );
      }

      await this.notifyOrderUpdatedToAdmins(updatedOrder.id, userId);
      return updatedOrder;
    } else {
      // Just update order data without changing items
      const currentSubtotal =
        Number(order.totalValor) - Number(order.taxaEntrega);

      // Handle status change based on special address
      let statusPagamento = order.statusPagamento;
      if (orderData.enderecoEspecialNome !== undefined) {
        if (
          orderData.enderecoEspecialNome &&
          (order.statusPagamento === 'pendente' ||
            order.statusPagamento === 'confirmado')
        ) {
          statusPagamento = 'bloqueado';
        } else if (
          !orderData.enderecoEspecialNome &&
          order.statusPagamento === 'bloqueado'
        ) {
          statusPagamento = 'pendente';
        }
      }

      // Recalculate fee if delivery options changed
      const taxaEntrega = await this.calculateDeliveryFee(
        currentSubtotal,
        (orderData.tipoEntrega || order.tipoEntrega) ?? undefined,
        (orderData.enderecoEspecialNome !== undefined
          ? orderData.enderecoEspecialNome
          : order.enderecoEspecialNome) ?? undefined,
      );

      const totalValor = currentSubtotal + taxaEntrega;
      const nextTipoEntrega =
        (orderData.tipoEntrega || order.tipoEntrega) ?? undefined;
      const horarioRetiradaDate =
        nextTipoEntrega === 'retirada'
          ? horarioRetirada
            ? this.getPickupDateTime(
                order.dataEncomenda.dataEntrega,
                horarioRetirada,
              )
            : (order.horarioEstimadoEntrega ?? null)
          : null;

      const updatedOrder = await this.prisma.pedidoEncomenda.update({
        where: { id },
        data: {
          ...orderData,
          horarioEstimadoEntrega: horarioRetiradaDate,
          taxaEntrega,
          totalValor,
          statusPagamento,
        },
        include: {
          dataEncomenda: true,
          itens: {
            include: {
              produto: true,
              variedade: true,
            },
          },
        },
      });

      // Handle special address fee recalculation
      if (orderData.enderecoEspecialNome !== undefined) {
        if (updatedOrder.enderecoEspecialNome) {
          await this.recalculateSharedFees(
            updatedOrder.dataEncomendaId,
            updatedOrder.enderecoEspecialNome,
          );
          const reloadedOrder = await this.findOne(updatedOrder.id, userId);
          await this.notifyOrderUpdatedToAdmins(updatedOrder.id, userId);
          return reloadedOrder;
        }
        if (order.enderecoEspecialNome && !updatedOrder.enderecoEspecialNome) {
          await this.recalculateSharedFees(
            order.dataEncomendaId,
            order.enderecoEspecialNome,
          );
        }
      }

      await this.notifyOrderUpdatedToAdmins(updatedOrder.id, userId);
      return updatedOrder;
    }
  }

  async updateReceipt(
    id: number,
    userId: string,
    file: Express.Multer.File,
    escolha?: EscolhaDoCliente,
  ) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: { dataEncomenda: true },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    if (order.usuarioId !== userId) {
      throw new ForbiddenException(
        'Você não tem permissão para atualizar este pedido',
      );
    }

    // Com pagamento anterior que já cobre o total não há o que pagar: o pedido
    // está em análise e não mostra QR. Só o total pode ser pago de novo.
    if (pagamentoJaCobre(order) && escolha !== 'total') {
      throw new BadRequestException(
        'O pagamento anterior já cobre este pedido',
      );
    }

    // O valor que o comprovante cobre sai da escolha do QR, nunca do app.
    const novo = comprovanteNovo(order, escolha);

    // Os comprovantes anteriores **não** são mais apagados: são a prova dos
    // pagamentos já feitos. Só um ainda em análise é substituído — é o cliente
    // trocando uma foto errada, e mantê-lo deixaria dois em análise.
    const substituidos = await this.prisma.comprovantePedido.findMany({
      where: { pedidoEncomendaId: id, status: 'em_analise' },
      select: { id: true, url: true },
    });

    const timestamp = Date.now();
    const contentType =
      file.mimetype === 'image/jpeg' ||
      file.mimetype === 'image/png' ||
      file.mimetype === 'image/webp'
        ? file.mimetype
        : 'image/png';
    const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
    const fileName = `formulario-${order.dataEncomendaId}-${timestamp}.${ext}`;
    const filePath = `${userId}/${fileName}`;

    await this.storageService.uploadFile(
      'comprovantes',
      filePath,
      file.buffer,
      contentType,
    );

    const comprovanteUrl = this.storageService.getPublicUrl(
      'comprovantes',
      filePath,
    );

    const [, , updatedOrder] = await this.prisma.$transaction([
      this.prisma.comprovantePedido.deleteMany({
        where: { id: { in: substituidos.map((c) => c.id) } },
      }),
      this.prisma.comprovantePedido.create({
        data: {
          pedidoEncomendaId: id,
          url: comprovanteUrl,
          valor: novo.valor,
          tipo: novo.tipo,
          status: 'em_analise',
        },
      }),
      this.prisma.pedidoEncomenda.update({
        where: { id },
        data: {
          // Continua sendo o último comprovante: é o que os apps antigos leem.
          comprovanteUrl,
          statusPagamento: 'aguardando_confirmacao',
          statusPagamentoAnterior: order.statusPagamento,
        },
        include: {
          comprovantes: { orderBy: { criadoEm: 'asc' } },
          dataEncomenda: true,
          usuario: true,
          itens: {
            include: {
              produto: true,
              variedade: true,
            },
          },
        },
      }),
    ]);

    await this.apagarArquivosDeComprovante(
      substituidos.map((c) => c.url),
      'substituído',
    );

    // Notificar administradores sobre o novo comprovante
    try {
      const admins = await this.prisma.usuario.findMany({
        where: { role: 'admin' },
        select: { id: true },
      });

      const targetAdmins = admins
        .map((a) => a.id)
        .filter((adminId) => adminId !== userId);

      if (targetAdmins.length > 0) {
        await this.notificationsService.broadcastNotification({
          usuarioIds: targetAdmins,
          chave: 'notification.receiptReceived',
          parametros: {
            userName: updatedOrder.usuario.nome,
            orderCode: updatedOrder.codigo ?? '',
          },
          dataEncomendaId: updatedOrder.dataEncomendaId,
          pedidoEncomendaId: updatedOrder.id,
          tipo: 'admin',
        });
      }
    } catch (error) {
      console.error('Erro ao notificar admins sobre comprovante:', error);
    }

    return updatedOrder;
  }

  // Admin methods for payment management
  async confirmPayment(id: number, adminUserId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: { dataEncomenda: true },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    if (order.statusPagamento === 'confirmado') {
      throw new BadRequestException('Este pedido já está confirmado');
    }

    if (order.statusPagamento === 'cancelado') {
      throw new BadRequestException(
        'Não é possível confirmar um pedido cancelado',
      );
    }

    // Os comprovantes em análise passam a valer; o que entrou além do total
    // vira reembolso (docs/PAGAMENTO-DIFERENCA-PIX.md).
    const emAnalise = await this.prisma.comprovantePedido.findMany({
      where: { pedidoEncomendaId: id, status: 'em_analise' },
      select: { valor: true },
    });
    const reembolso = reembolsoNaConfirmacao(
      order,
      emAnalise.map((c) => c.valor),
    );

    const [, updatedOrder] = await this.prisma.$transaction([
      this.prisma.comprovantePedido.updateMany({
        where: { pedidoEncomendaId: id, status: 'em_analise' },
        data: { status: 'confirmado' },
      }),
      this.prisma.pedidoEncomenda.update({
        where: { id },
        data: {
          statusPagamento: 'confirmado',
          statusPagamentoAnterior: order.statusPagamento,
          dataPagamento: new Date(),
          confirmadoPor: adminUserId,
          ...(reembolso > 0
            ? {
                reembolsoValor: reembolso,
                reembolsadoEm: null,
                reembolsadoPor: null,
              }
            : {}),
        },
        include: {
          comprovantes: { orderBy: { criadoEm: 'asc' } },
          dataEncomenda: true,
          itens: {
            include: {
              produto: true,
              variedade: true,
            },
          },
        },
      }),
    ]);

    // Notificar o usuário sobre a confirmação do pagamento
    try {
      await this.notificationsService.createAndSendNotification({
        usuarioId: order.usuarioId,
        chave: 'notification.paymentConfirmed',
        parametros: { orderCode: order.codigo ?? '' },
        dataEncomendaId: order.dataEncomendaId,
        pedidoEncomendaId: order.id,
        tipo: 'user',
      });
    } catch (error) {
      console.error(
        'Erro ao notificar usuário sobre confirmação de pagamento:',
        error,
      );
    }

    return updatedOrder;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- trilha de auditoria ainda não gravada nesta ação (ver confirmPayment)
  async revertPayment(id: number, adminUserId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: { dataEncomenda: true },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    let targetStatus = order.statusPagamentoAnterior || 'pendente';

    // Pagamento confirmado com comprovante. Com o formulário aberto, volta para
    // `pendente`: é o único status que libera a edição (`update()`), e antes o
    // pedido caía em `aguardando_confirmacao` e o cliente ficava sem poder
    // editar até o prazo acabar (pedido 222, 2026-09-11). O comprovante fica
    // anexado; o cliente reenvia se o total mudar. Com o prazo encerrado não há
    // edição a liberar, então volta para análise, onde o admin reconfirma.
    //
    // Ao liberar a edição, o valor confirmado vira `valor_pago`: é a base do QR
    // da diferença. Um reembolso ainda não feito entra nele — o dinheiro continua
    // com o restaurante — e é zerado (docs/PAGAMENTO-DIFERENCA-PIX.md).
    let pagamentoAnterior: Prisma.PedidoEncomendaUpdateInput = {};

    if (order.statusPagamento === 'confirmado' && order.comprovanteUrl) {
      const formularioAberto =
        new Date() <= new Date(order.dataEncomenda.dataLimitePedido);
      targetStatus = formularioAberto ? 'pendente' : 'aguardando_confirmacao';
      if (formularioAberto) {
        pagamentoAnterior = {
          valorPago: valorPagoNoRevert(order),
          reembolsoValor: null,
          reembolsadoEm: null,
          reembolsadoPor: null,
        };
      }
    }

    const updatedOrder = await this.prisma.pedidoEncomenda.update({
      where: { id },
      data: {
        statusPagamento: targetStatus,
        statusPagamentoAnterior: order.statusPagamento,
        dataPagamento: null,
        ...pagamentoAnterior,
      },
      include: {
        dataEncomenda: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    // Notificar o usuário sobre o revert do pagamento
    try {
      await this.notificationsService.createAndSendNotification({
        usuarioId: order.usuarioId,
        chave: 'notification.paymentReverted',
        parametros: { orderCode: order.codigo ?? '' },
        dataEncomendaId: order.dataEncomendaId,
        pedidoEncomendaId: order.id,
        tipo: 'user',
      });
    } catch (error) {
      console.error(
        'Erro ao notificar usuário sobre revert de pagamento:',
        error,
      );
    }

    return updatedOrder;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- trilha de auditoria ainda não gravada nesta ação (ver confirmPayment)
  async rejectPayment(id: number, adminUserId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    if (order.statusPagamento !== 'aguardando_confirmacao') {
      throw new BadRequestException(
        'Apenas pedidos com pagamento em análise podem ser recusados',
      );
    }

    // Recusa só o que está em análise. Comprovantes confirmados são pagamento
    // válido e ficam (docs/PAGAMENTO-DIFERENCA-PIX.md).
    const [emAnalise, ultimoConfirmado] = await Promise.all([
      this.prisma.comprovantePedido.findMany({
        where: { pedidoEncomendaId: id, status: 'em_analise' },
        select: { id: true, url: true },
      }),
      this.prisma.comprovantePedido.findFirst({
        where: { pedidoEncomendaId: id, status: 'confirmado' },
        orderBy: { criadoEm: 'desc' },
        select: { url: true },
      }),
    ]);

    // Pedido em análise só porque o pagamento anterior já cobre o total: não há
    // comprovante novo, e recusar o devolveria a pendente cobrando de novo.
    if (emAnalise.length === 0 && ultimoConfirmado) {
      throw new BadRequestException(
        'Não há comprovante em análise para recusar neste pedido',
      );
    }

    // Sem histórico nenhum (pedido anterior à tabela de comprovantes), o
    // comprovante só existe no próprio pedido — o comportamento de antes.
    const recusados =
      emAnalise.length > 0
        ? emAnalise.map((c) => c.url)
        : order.comprovanteUrl
          ? [order.comprovanteUrl]
          : [];
    await this.apagarArquivosDeComprovante(recusados, 'recusado');
    if (emAnalise.length > 0) {
      await this.prisma.comprovantePedido.deleteMany({
        where: { id: { in: emAnalise.map((c) => c.id) } },
      });
    }

    const updatedOrder = await this.prisma.pedidoEncomenda.update({
      where: { id },
      data: {
        statusPagamento: 'pendente',
        statusPagamentoAnterior: order.statusPagamento,
        comprovanteUrl: ultimoConfirmado?.url ?? null,
      },
      include: {
        dataEncomenda: true,
        usuario: { select: { id: true, nome: true } },
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    // Notificar o usuário sobre a recusa do comprovante
    try {
      await this.notificationsService.createAndSendNotification({
        usuarioId: updatedOrder.usuarioId,
        chave: 'notification.receiptRejected',
        parametros: { orderCode: order.codigo ?? '' },
        dataEncomendaId: updatedOrder.dataEncomendaId,
        pedidoEncomendaId: order.id,
        tipo: 'user',
      });
    } catch (error) {
      console.error(
        'Erro ao notificar usuário sobre comprovante recusado:',
        error,
      );
    }

    return updatedOrder;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- trilha de auditoria ainda não gravada nesta ação (ver confirmPayment)
  async cancelOrder(id: number, adminUserId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    if (order.statusPagamento === 'cancelado') {
      throw new BadRequestException('Este pedido já está cancelado');
    }

    const updatedOrder = await this.prisma.pedidoEncomenda.update({
      where: { id },
      data: {
        statusPagamento: 'cancelado',
        statusPagamentoAnterior: order.statusPagamento,
      },
      include: {
        dataEncomenda: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    // Recalculate shared fees if this was a special address order
    if (order.enderecoEspecialNome) {
      await this.recalculateSharedFees(
        order.dataEncomendaId,
        order.enderecoEspecialNome,
      );
    }

    // Notificar o usuário sobre o cancelamento pelo admin
    try {
      await this.notificationsService.createAndSendNotification({
        usuarioId: order.usuarioId,
        chave: 'notification.orderCancelledByAdmin',
        parametros: { orderCode: order.codigo ?? '' },
        dataEncomendaId: order.dataEncomendaId,
        pedidoEncomendaId: order.id,
        tipo: 'user',
      });
    } catch (error) {
      console.error(
        'Erro ao notificar usuário sobre cancelamento pelo admin:',
        error,
      );
    }

    return updatedOrder;
  }

  async cancelMyOrder(id: number, userId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: { dataEncomenda: true, usuario: { select: { nome: true } } },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    if (order.usuarioId !== userId) {
      throw new ForbiddenException(
        'Você não tem permissão para cancelar este pedido',
      );
    }

    if (!['pendente', 'bloqueado'].includes(order.statusPagamento)) {
      throw new BadRequestException(
        'Apenas pedidos pendentes ou aguardando cálculo podem ser cancelados',
      );
    }

    const now = new Date();
    const deadline = new Date(order.dataEncomenda.dataLimitePedido);

    if (now > deadline) {
      throw new BadRequestException(
        'O prazo para cancelamento deste pedido já expirou',
      );
    }

    const updatedOrder = await this.prisma.pedidoEncomenda.update({
      where: { id },
      data: {
        statusPagamento: 'cancelado',
        statusPagamentoAnterior: order.statusPagamento,
      },
      include: {
        dataEncomenda: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    // Recalculate shared fees if this was a special address order
    if (order.enderecoEspecialNome) {
      await this.recalculateSharedFees(
        order.dataEncomendaId,
        order.enderecoEspecialNome,
      );
    }

    // Notificar admins sobre o cancelamento pelo usuário
    try {
      const admins = await this.prisma.usuario.findMany({
        where: { role: 'admin' },
        select: { id: true },
      });
      const targetAdmins = admins
        .map((a) => a.id)
        .filter((adminId) => adminId !== userId);
      if (targetAdmins.length > 0) {
        await this.notificationsService.broadcastNotification({
          usuarioIds: targetAdmins,
          chave: 'notification.orderCancelledByUser',
          parametros: {
            orderCode: order.codigo ?? '',
            userName: order.usuario.nome,
          },
          dataEncomendaId: order.dataEncomendaId,
          pedidoEncomendaId: order.id,
          tipo: 'admin',
        });
      }
    } catch (error) {
      console.error(
        'Erro ao notificar admins sobre cancelamento pelo usuário:',
        error,
      );
    }

    return updatedOrder;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- trilha de auditoria ainda não gravada nesta ação (ver confirmPayment)
  async revertCancellation(id: number, adminUserId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }

    if (order.statusPagamento !== 'cancelado') {
      throw new BadRequestException('Este pedido não está cancelado');
    }

    const newStatus = order.statusPagamentoAnterior || 'pendente';

    const updatedOrder = await this.prisma.pedidoEncomenda.update({
      where: { id },
      data: {
        statusPagamento: newStatus,
        statusPagamentoAnterior: null,
      },
      include: {
        dataEncomenda: true,
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    // Recalculate shared fees if this was a special address order
    if (order.enderecoEspecialNome) {
      await this.recalculateSharedFees(
        order.dataEncomendaId,
        order.enderecoEspecialNome,
      );
    }

    // Notificar o usuário sobre a reversão do cancelamento
    try {
      await this.notificationsService.createAndSendNotification({
        usuarioId: order.usuarioId,
        chave: 'notification.cancellationReverted',
        parametros: { orderCode: order.codigo ?? '' },
        dataEncomendaId: order.dataEncomendaId,
        pedidoEncomendaId: order.id,
        tipo: 'user',
      });
    } catch (error) {
      console.error(
        'Erro ao notificar usuário sobre reversão de cancelamento:',
        error,
      );
    }

    return updatedOrder;
  }

  // Admin: Get summary of orders for a specific order form
  async getOrderFormSummary(dataEncomendaId: number) {
    const orders = await this.prisma.pedidoEncomenda.findMany({
      where: { dataEncomendaId },
      include: {
        usuario: {
          select: {
            id: true,
            nome: true,
            telefone: true,
            email: true,
          },
        },
        itens: {
          include: {
            produto: true,
            variedade: true,
          },
        },
      },
    });

    // Calculate totals
    const totalOrders = orders.length;
    const confirmedOrders = orders.filter(
      (o) => o.statusPagamento === 'confirmado',
    ).length;
    const pendingOrders = orders.filter(
      (o) => o.statusPagamento === 'pendente',
    ).length;
    const blockedOrders = orders.filter(
      (o) => o.statusPagamento === 'bloqueado',
    ).length;
    const cancelledOrders = orders.filter(
      (o) => o.statusPagamento === 'cancelado',
    ).length;

    const totalValue = orders
      .filter((o) => o.statusPagamento !== 'cancelado')
      .reduce((sum, o) => sum + Number(o.totalValor), 0);

    const confirmedValue = orders
      .filter((o) => o.statusPagamento === 'confirmado')
      .reduce((sum, o) => sum + Number(o.totalValor), 0);

    // Group products
    const productSummary: Record<
      string,
      {
        nome: unknown;
        variedadeNome: unknown;
        quantidade: number;
        total: number;
      }
    > = {};

    orders
      .filter((o) => o.statusPagamento !== 'cancelado')
      .forEach((order) => {
        order.itens.forEach((item) => {
          const key = item.variedade
            ? `${item.produtoId}-${item.variedade.id}`
            : `${item.produtoId}`;

          if (!productSummary[key]) {
            productSummary[key] = {
              nome: item.produto?.nome || null,
              variedadeNome: item.variedade?.nome || null,
              quantidade: 0,
              total: 0,
            };
          }

          productSummary[key].quantidade += item.quantidade;
          productSummary[key].total +=
            item.quantidade * Number(item.precoUnitario);
        });
      });

    return {
      totalOrders,
      confirmedOrders,
      pendingOrders,
      blockedOrders,
      cancelledOrders,
      totalValue,
      confirmedValue,
      products: Object.values(productSummary).sort(
        (a, b) => b.quantidade - a.quantidade,
      ),
      orders,
    };
  }

  async getPixQrCode(id: number, userId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      include: {
        usuario: true,
      },
    });

    if (!order) throw new NotFoundException('Pedido não encontrado');

    // Allow admin access
    if (order.usuarioId !== userId) {
      const user = await this.prisma.usuario.findUnique({
        where: { id: userId },
      });
      if (user?.role !== 'admin') {
        throw new ForbiddenException('Não autorizado');
      }
    }

    if (order.formaPagamento !== 'pix')
      throw new BadRequestException('Pedido não é do tipo PIX');

    const config = await this.configuracoesService.get();
    if (!config || !config.chavePix) {
      throw new BadRequestException(
        'Configuração PIX não encontrada. Entre em contato com o suporte.',
      );
    }

    const situacao = situacaoDoPagamento(order);
    if (situacao.temPagamentoAnterior && situacao.aPagar === 0) {
      throw new BadRequestException(
        'O pagamento anterior já cobre este pedido',
      );
    }

    const chavePix = config.chavePix;
    const gerar = async (valor: number, sufixo: string) => {
      const pix = QrCodePix({
        version: '01',
        key: chavePix,
        name: config.nomeRecebedor || 'Yatsunami',
        city: config.cidadeRecebedor || 'Curitiba',
        transactionId: `PAY${order.id}${sufixo}`,
        message: `Pedido #${order.id}`,
        value: valor,
      });
      return { valor, payload: pix.payload(), base64: await pix.base64() };
    };

    const total = await gerar(situacao.total, '');
    const diferenca = situacao.temPagamentoAnterior
      ? await gerar(situacao.aPagar, 'D')
      : null;
    // Com pagamento anterior o padrão é a diferença. `payload` e `base64` de
    // topo seguem o padrão porque os apps antigos só leem esses dois campos.
    const padrao = diferenca ?? total;

    return {
      payload: padrao.payload,
      base64: padrao.base64,
      total,
      diferenca,
      valorPago: situacao.temPagamentoAnterior ? situacao.pago : null,
    };
  }

  /** Marca como feito o reembolso do que o cliente pagou além do total. */
  async marcarReembolsado(id: number, adminUserId: string) {
    const order = await this.prisma.pedidoEncomenda.findUnique({
      where: { id },
      select: { reembolsoValor: true, reembolsadoEm: true },
    });

    if (!order) {
      throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
    }
    if (!order.reembolsoValor || Number(order.reembolsoValor) <= 0) {
      throw new BadRequestException('Este pedido não tem reembolso pendente');
    }
    if (order.reembolsadoEm) {
      throw new BadRequestException('O reembolso deste pedido já foi marcado');
    }

    return this.prisma.pedidoEncomenda.update({
      where: { id },
      data: { reembolsadoEm: new Date(), reembolsadoPor: adminUserId },
      include: {
        comprovantes: { orderBy: { criadoEm: 'asc' } },
        dataEncomenda: true,
        itens: { include: { produto: true, variedade: true } },
      },
    });
  }

  /** Apaga arquivos de comprovante do storage; falha aqui não desfaz a operação. */
  private async apagarArquivosDeComprovante(urls: string[], motivo: string) {
    for (const url of urls) {
      try {
        const caminho = this.storageService.extractPathFromUrl(
          url,
          'comprovantes',
        );
        if (caminho)
          await this.storageService.deleteFile('comprovantes', [caminho]);
      } catch (err) {
        console.error(`Erro ao deletar comprovante ${motivo}:`, err);
      }
    }
  }
}

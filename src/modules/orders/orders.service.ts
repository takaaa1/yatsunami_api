import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto } from './dto';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { QrCodePix } from 'qrcode-pix';
import { StorageService } from '../../config/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

import { generateOrderCode } from '../../common/utils/string-utils';

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private configuracoesService: ConfiguracoesService,
        private storageService: StorageService,
        private notificationsService: NotificationsService,
    ) { }

    private formatAddress(address: any): string | null {
        if (!address) return null;
        if (typeof address === 'string') return address.trim();

        const { logradouro, numero, bairro, cidade, estado } = address;
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

        return typeof address === 'object' ? JSON.stringify(address) : String(address);
    }

    private getPickupDateTime(dataEntrega: Date, horarioRetirada?: string): Date | null {
        if (!horarioRetirada) return null;
        const [hoursStr, minutesStr] = horarioRetirada.split(':');
        const hours = Number(hoursStr);
        const minutes = Number(minutesStr);
        if (Number.isNaN(hours) || Number.isNaN(minutes)) {
            throw new BadRequestException('Horário de retirada inválido');
        }
        if (hours < 8 || hours > 14 || minutes < 0 || minutes > 59) {
            throw new BadRequestException('O horário de retirada deve estar entre 08:00 e 14:59');
        }

        // Build the pickup instant explicitly in Sao Paulo timezone (-03:00),
        // independent of server timezone. This matches route ETA persistence behavior
        // (store an absolute instant in timestamptz).
        const deliveryDatePart = dataEntrega.toISOString().split('T')[0];
        const hh = String(hours).padStart(2, '0');
        const mm = String(minutes).padStart(2, '0');
        return new Date(`${deliveryDatePart}T${hh}:${mm}:00-03:00`);
    }

    private async calculateDeliveryFee(subtotal: number, tipoEntrega?: string, enderecoEspecialNome?: string) {
        if (tipoEntrega === 'retirada') return 0;

        const config = await this.configuracoesService.get();
        if (!config) return 12.00; // Fallback to default base fee

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
        const { dataEncomendaId, itens, horarioRetirada, ...orderData } = createOrderDto;

        // Check if order date exists and is active
        const dataEncomenda = await this.prisma.dataEncomenda.findUnique({
            where: { id: dataEncomendaId },
        });

        if (!dataEncomenda) {
            throw new NotFoundException(`Data de encomenda com ID ${dataEncomendaId} não encontrada`);
        }

        if (!dataEncomenda.ativo) {
            throw new BadRequestException('Esta data de encomenda não está mais ativa');
        }

        // Check ordering window
        const now = new Date();
        const deadline = new Date(dataEncomenda.dataLimitePedido);
        if (now > deadline) {
            throw new BadRequestException('O prazo para pedidos nesta data já encerrou');
        }
        if (dataEncomenda.dataInicioPedido && now < new Date(dataEncomenda.dataInicioPedido)) {
            throw new BadRequestException('Os pedidos para esta data ainda não estão abertos');
        }

        // Check if user already has an order for this order form
        const existingOrder = await this.prisma.pedidoEncomenda.findFirst({
            where: {
                usuarioId: userId,
                dataEncomendaId: dataEncomendaId
            }
        });

        if (existingOrder && existingOrder.statusPagamento !== 'cancelado') {
            throw new BadRequestException('Você já possui um pedido para esta data de entrega. Edite o pedido existente ou cancele-o para criar um novo.');
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
                throw new NotFoundException(`Produto com ID ${item.produtoId} não encontrado`);
            }

            let precoUnitario = produto.preco ? Number(produto.preco) : 0;
            let variedadeId = item.variedadeId;

            if (variedadeId) {
                const variedade = produto.variedades.find(v => v.id === variedadeId);
                if (!variedade) {
                    throw new NotFoundException(`Variedade com ID ${variedadeId} não encontrada para o produto ${item.produtoId}`);
                }
                // Some products keep the effective price only at product level.
                // In this case, fallback to base product price when variety price is missing/zero.
                const varietyPrice = Number(variedade.preco ?? 0);
                precoUnitario = varietyPrice > 0 ? varietyPrice : (produto.preco ? Number(produto.preco) : 0);
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
            createOrderDto.enderecoEspecialNome
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
            orderData.enderecoEntrega = this.formatAddress(orderData.enderecoEntrega);
        }

        const horarioRetiradaDate = orderData.tipoEntrega === 'retirada'
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

        // Create or reuse cancelled order with transaction to ensure integrity
        const order = await this.prisma.$transaction(async (tx) => {
            if (existingOrder && existingOrder.statusPagamento === 'cancelado') {
                await tx.itemPedidoEncomenda.deleteMany({
                    where: { pedidoId: existingOrder.id }
                });

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
                            create: processedItens.map(item => ({
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
                            }
                        }
                    }
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
                        create: processedItens.map(item => ({
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
                        }
                    }
                }
            });

            return newOrder;
        });

        // Notificar administradores sobre o novo pedido
        try {
            const admins = await this.prisma.usuario.findMany({
                where: { role: 'admin' },
                select: { id: true }
            });

            if (admins.length > 0) {
                await this.notificationsService.broadcastNotification({
                    usuarioIds: admins.map(a => a.id),
                    chave: 'notification.orderCreated',
                    parametros: { userName: order.usuario.nome, orderCode: order.codigo ?? '' },
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
            await this.recalculateSharedFees(order.dataEncomendaId, order.enderecoEspecialNome);
            // Reload order after recalculation
            return this.findOne(order.id, userId);
        }

        return order;
    }

    async recalculateSharedFees(dataEncomendaId: number, specialAddressName: string) {
        // Find all orders for this form and special address that are not yet finalized (paid/cancelled)
        const orders = await this.prisma.pedidoEncomenda.findMany({
            where: {
                dataEncomendaId,
                enderecoEspecialNome: specialAddressName,
                statusPagamento: { in: ['bloqueado', 'pendente'] }
            }
        });

        if (orders.length === 0) return;

        // Calculate total subtotal
        let totalSubtotal = 0;
        orders.forEach(order => {
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
            orders.map(order => {
                const subtotal = Number(order.totalValor) - Number(order.taxaEntrega);
                const newTotal = subtotal + sharedFee;
                return this.prisma.pedidoEncomenda.update({
                    where: { id: order.id },
                    data: {
                        taxaEntrega: sharedFee,
                        totalValor: newTotal
                    }
                });
            })
        );
    }

    async findByOrderForm(formId: number, search?: string) {
        const where: any = {
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
            orderBy: { dataPedido: 'desc' },
            include: {
                usuario: true, // Make sure usuario is included for filtering
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            },
        });

        return orders;
    }

    async findAll(userId: string, skip = 0, take = 10) {
        const orders = await this.prisma.pedidoEncomenda.findMany({
            where: { usuarioId: userId },
            orderBy: { dataPedido: 'desc' },
            skip,
            take,
            include: {
                dataEncomenda: true,
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            },
        });

        const now = new Date();
        return Promise.all(orders.map(async (order) => {
            const deadline = new Date(order.dataEncomenda.dataLimitePedido);

            // Automatic UNLOCK: if blocked and deadline passed -> pendente
            if (order.statusPagamento === 'bloqueado' && now > deadline) {
                return this.prisma.pedidoEncomenda.update({
                    where: { id: order.id },
                    data: { statusPagamento: 'pendente' },
                    include: {
                        dataEncomenda: true,
                        itens: {
                            include: {
                                produto: true,
                                variedade: true,
                            }
                        }
                    }
                });
            }

            // Automatic LOCK: if pending (and not paid), special address, and deadline NOT passed -> bloqueado
            // This handles cases where deadline is extended or order was wrongly set to pending
            if (order.statusPagamento === 'pendente' && order.enderecoEspecialNome && now <= deadline) {
                return this.prisma.pedidoEncomenda.update({
                    where: { id: order.id },
                    data: { statusPagamento: 'bloqueado' },
                    include: {
                        dataEncomenda: true,
                        itens: {
                            include: {
                                produto: true,
                                variedade: true,
                            }
                        }
                    }
                });
            }

            return order;
        }));
    }

    async findOne(id: number, userId: string) {
        const order = await this.prisma.pedidoEncomenda.findUnique({
            where: { id },
            include: {
                dataEncomenda: true,
                usuario: true,
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            },
        });

        if (!order) {
            throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
        }

        // Ensure user owns the order (or is admin - implementing basic owner check for now)
        // TODO: Add admin check logic if needed
        if (order.usuarioId !== userId) {
            // Find if user is admin
            const user = await this.prisma.usuario.findUnique({ where: { id: userId } });
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
                        }
                    }
                }
            });
            return updatedOrder;
        }

        // 2. LOCK: if pending, special address, and deadline NOT passed -> bloqueado
        // This ensures orders revert to blocked if deadline is extended
        if (order.statusPagamento === 'pendente' && order.enderecoEspecialNome && now <= deadline) {
            const updatedOrder = await this.prisma.pedidoEncomenda.update({
                where: { id: order.id },
                data: { statusPagamento: 'bloqueado' },
                include: {
                    dataEncomenda: true,
                    itens: {
                        include: {
                            produto: true,
                            variedade: true,
                        }
                    }
                }
            });
            return updatedOrder;
        }

        return order;
    }

    async update(id: number, userId: string, updateOrderDto: UpdateOrderDto) {
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
            const user = await this.prisma.usuario.findUnique({ where: { id: userId } });
            if (user?.role !== 'admin') {
                throw new ForbiddenException('Você não tem permissão para editar este pedido');
            }
        }

        // Check if order can be edited (only pending or blocked status)
        if (!['pendente', 'bloqueado'].includes(order.statusPagamento)) {
            throw new BadRequestException('Apenas pedidos pendentes podem ser editados');
        }

        // Check deadline
        const now = new Date();
        const deadline = new Date(order.dataEncomenda.dataLimitePedido);
        if (now > deadline) {
            throw new BadRequestException('O prazo para edição deste pedido já expirou');
        }

        const { itens, horarioRetirada, ...orderData } = updateOrderDto;

        let totalValor = 0;
        let processedItens: any[] = [];

        // If items are being updated, recalculate everything
        if (itens && itens.length > 0) {
            // Calculate new total and validate products
            const itemPromises = itens.map(async (item) => {
                const produto = await this.prisma.produto.findUnique({
                    where: { id: item.produtoId },
                    include: { variedades: true },
                });

                if (!produto) {
                    throw new NotFoundException(`Produto com ID ${item.produtoId} não encontrado`);
                }

                let precoUnitario = produto.preco ? Number(produto.preco) : 0;
                let variedadeId = item.variedadeId;

                if (variedadeId) {
                    const variedade = produto.variedades.find(v => v.id === variedadeId);
                    if (!variedade) {
                        throw new NotFoundException(`Variedade com ID ${variedadeId} não encontrada para o produto ${item.produtoId}`);
                    }
                    const varietyPrice = Number(variedade.preco ?? 0);
                    precoUnitario = varietyPrice > 0 ? varietyPrice : (produto.preco ? Number(produto.preco) : 0);
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
                if (orderData.enderecoEspecialNome && (order.statusPagamento === 'pendente' || order.statusPagamento === 'confirmado')) {
                    statusPagamento = 'bloqueado';
                } else if (!orderData.enderecoEspecialNome && order.statusPagamento === 'bloqueado') {
                    statusPagamento = 'pendente';
                }

                // Calculate delivery fee using unified method
                const taxaEntrega = await this.calculateDeliveryFee(
                    totalValor,
                    (orderData.tipoEntrega || order.tipoEntrega) ?? undefined,
                    (orderData.enderecoEspecialNome || order.enderecoEspecialNome) ?? undefined
                );

                const finalTotal = totalValor + taxaEntrega;
                const nextTipoEntrega = (orderData.tipoEntrega || order.tipoEntrega) ?? undefined;
                const horarioRetiradaDate = nextTipoEntrega === 'retirada'
                    ? (horarioRetirada
                        ? this.getPickupDateTime(order.dataEncomenda.dataEntrega, horarioRetirada)
                        : (order.horarioEstimadoEntrega ?? null))
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
                            create: processedItens.map(item => ({
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
                            }
                        }
                    }
                });

                return updated;
            });

            // Recalculate shared fees if special address
            if (updatedOrder.enderecoEspecialNome) {
                await this.recalculateSharedFees(updatedOrder.dataEncomendaId, updatedOrder.enderecoEspecialNome);
                return this.findOne(updatedOrder.id, userId);
            }

            // If was special address before but not now, recalculate old group
            if (order.enderecoEspecialNome && !updatedOrder.enderecoEspecialNome) {
                await this.recalculateSharedFees(order.dataEncomendaId, order.enderecoEspecialNome);
            }

            return updatedOrder;
        } else {
            // Just update order data without changing items
            const currentSubtotal = Number(order.totalValor) - Number(order.taxaEntrega);

            // Handle status change based on special address
            let statusPagamento = order.statusPagamento;
            if (orderData.enderecoEspecialNome !== undefined) {
                if (orderData.enderecoEspecialNome && (order.statusPagamento === 'pendente' || order.statusPagamento === 'confirmado')) {
                    statusPagamento = 'bloqueado';
                } else if (!orderData.enderecoEspecialNome && order.statusPagamento === 'bloqueado') {
                    statusPagamento = 'pendente';
                }
            }

            // Recalculate fee if delivery options changed
            const taxaEntrega = await this.calculateDeliveryFee(
                currentSubtotal,
                (orderData.tipoEntrega || order.tipoEntrega) ?? undefined,
                (orderData.enderecoEspecialNome !== undefined ? orderData.enderecoEspecialNome : order.enderecoEspecialNome) ?? undefined
            );

            const totalValor = currentSubtotal + taxaEntrega;
            const nextTipoEntrega = (orderData.tipoEntrega || order.tipoEntrega) ?? undefined;
            const horarioRetiradaDate = nextTipoEntrega === 'retirada'
                ? (horarioRetirada
                    ? this.getPickupDateTime(order.dataEncomenda.dataEntrega, horarioRetirada)
                    : (order.horarioEstimadoEntrega ?? null))
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
                        }
                    }
                }
            });

            // Handle special address fee recalculation
            if (orderData.enderecoEspecialNome !== undefined) {
                if (updatedOrder.enderecoEspecialNome) {
                    await this.recalculateSharedFees(updatedOrder.dataEncomendaId, updatedOrder.enderecoEspecialNome);
                    return this.findOne(updatedOrder.id, userId);
                }
                if (order.enderecoEspecialNome && !updatedOrder.enderecoEspecialNome) {
                    await this.recalculateSharedFees(order.dataEncomendaId, order.enderecoEspecialNome);
                }
            }

            return updatedOrder;
        }
    }

    async updateReceipt(id: number, userId: string, file: Express.Multer.File) {
        const order = await this.prisma.pedidoEncomenda.findUnique({
            where: { id },
            include: { dataEncomenda: true }
        });

        if (!order) {
            throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
        }

        if (order.usuarioId !== userId) {
            throw new ForbiddenException('Você não tem permissão para atualizar este pedido');
        }

        if (order.comprovanteUrl) {
            try {
                const oldPath = this.storageService.extractPathFromUrl(order.comprovanteUrl, 'comprovantes');
                if (oldPath) await this.storageService.deleteFile('comprovantes', [oldPath]);
            } catch (err) {
                console.error('Erro ao deletar comprovante antigo:', err);
            }
        }

        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `formulario-${order.dataEncomendaId}-${timestamp}.${fileExtension}`;
        const filePath = `${userId}/${fileName}`;

        await this.storageService.uploadFile('comprovantes', filePath, file.buffer, file.mimetype);

        const comprovanteUrl = this.storageService.getPublicUrl('comprovantes', filePath);

        const updatedOrder = await this.prisma.pedidoEncomenda.update({
            where: { id },
            data: {
                comprovanteUrl,
                statusPagamento: 'aguardando_confirmacao',
                statusPagamentoAnterior: order.statusPagamento
            },
            include: {
                dataEncomenda: true,
                usuario: true,
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            }
        });

        // Notificar administradores sobre o novo comprovante
        try {
            const admins = await this.prisma.usuario.findMany({
                where: { role: 'admin' },
                select: { id: true }
            });

            if (admins.length > 0) {
                await this.notificationsService.broadcastNotification({
                    usuarioIds: admins.map(a => a.id),
                    chave: 'notification.receiptReceived',
                    parametros: { userName: updatedOrder.usuario.nome, orderCode: updatedOrder.codigo ?? '' },
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
            include: { dataEncomenda: true }
        });

        if (!order) {
            throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
        }

        if (order.statusPagamento === 'confirmado') {
            throw new BadRequestException('Este pedido já está confirmado');
        }

        if (order.statusPagamento === 'cancelado') {
            throw new BadRequestException('Não é possível confirmar um pedido cancelado');
        }

        const updatedOrder = await this.prisma.pedidoEncomenda.update({
            where: { id },
            data: {
                statusPagamento: 'confirmado',
                statusPagamentoAnterior: order.statusPagamento,
                dataPagamento: new Date(),
                confirmadoPor: adminUserId,
            },
            include: {
                dataEncomenda: true,
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            }
        });

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
            console.error('Erro ao notificar usuário sobre confirmação de pagamento:', error);
        }

        return updatedOrder;
    }

    async revertPayment(id: number, adminUserId: string) {
        const order = await this.prisma.pedidoEncomenda.findUnique({
            where: { id },
        });

        if (!order) {
            throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
        }

        // When reverting, if it was 'confirmado', it should go back to 'aguardando_confirmacao' 
        // if there's a receipt, otherwise use the previous status or pendente.
        let targetStatus = order.statusPagamentoAnterior || 'pendente';

        if (order.statusPagamento === 'confirmado' && order.comprovanteUrl) {
            targetStatus = 'aguardando_confirmacao';
        }

        const updatedOrder = await this.prisma.pedidoEncomenda.update({
            where: { id },
            data: {
                statusPagamento: targetStatus,
                statusPagamentoAnterior: order.statusPagamento,
                dataPagamento: null,
            },
            include: {
                dataEncomenda: true,
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            }
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
            console.error('Erro ao notificar usuário sobre revert de pagamento:', error);
        }

        return updatedOrder;
    }

    async rejectPayment(id: number, adminUserId: string) {
        const order = await this.prisma.pedidoEncomenda.findUnique({
            where: { id },
        });

        if (!order) {
            throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
        }

        if (order.statusPagamento !== 'aguardando_confirmacao') {
            throw new BadRequestException('Apenas pedidos com pagamento em análise podem ser recusados');
        }

        if (order.comprovanteUrl) {
            try {
                const oldPath = this.storageService.extractPathFromUrl(order.comprovanteUrl, 'comprovantes');
                if (oldPath) await this.storageService.deleteFile('comprovantes', [oldPath]);
            } catch (err) {
                console.error('Erro ao deletar comprovante recusado:', err);
            }
        }

        const updatedOrder = await this.prisma.pedidoEncomenda.update({
            where: { id },
            data: {
                statusPagamento: 'pendente',
                statusPagamentoAnterior: order.statusPagamento,
                comprovanteUrl: null, // Clear receipt URL
            },
            include: {
                dataEncomenda: true,
                usuario: { select: { id: true, nome: true } },
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            }
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
            console.error('Erro ao notificar usuário sobre comprovante recusado:', error);
        }

        return updatedOrder;
    }

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
                    }
                }
            }
        });

        // Recalculate shared fees if this was a special address order
        if (order.enderecoEspecialNome) {
            await this.recalculateSharedFees(order.dataEncomendaId, order.enderecoEspecialNome);
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
            console.error('Erro ao notificar usuário sobre cancelamento pelo admin:', error);
        }

        return updatedOrder;
    }

    async cancelMyOrder(id: number, userId: string) {
        const order = await this.prisma.pedidoEncomenda.findUnique({
            where: { id },
            include: { dataEncomenda: true, usuario: { select: { nome: true } } }
        });

        if (!order) {
            throw new NotFoundException(`Pedido com ID ${id} não encontrado`);
        }

        if (order.usuarioId !== userId) {
            throw new ForbiddenException('Você não tem permissão para cancelar este pedido');
        }

        if (!['pendente', 'bloqueado'].includes(order.statusPagamento)) {
            throw new BadRequestException('Apenas pedidos pendentes ou aguardando cálculo podem ser cancelados');
        }

        const now = new Date();
        const deadline = new Date(order.dataEncomenda.dataLimitePedido);

        if (now > deadline) {
            throw new BadRequestException('O prazo para cancelamento deste pedido já expirou');
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
                    }
                }
            }
        });

        // Recalculate shared fees if this was a special address order
        if (order.enderecoEspecialNome) {
            await this.recalculateSharedFees(order.dataEncomendaId, order.enderecoEspecialNome);
        }

        // Notificar admins sobre o cancelamento pelo usuário
        try {
            const admins = await this.prisma.usuario.findMany({ where: { role: 'admin' }, select: { id: true } });
            if (admins.length > 0) {
                await this.notificationsService.broadcastNotification({
                    usuarioIds: admins.map(a => a.id),
                    chave: 'notification.orderCancelledByUser',
                    parametros: { orderCode: order.codigo ?? '', userName: order.usuario.nome },
                    dataEncomendaId: order.dataEncomendaId,
                    pedidoEncomendaId: order.id,
                    tipo: 'admin',
                });
            }
        } catch (error) {
            console.error('Erro ao notificar admins sobre cancelamento pelo usuário:', error);
        }

        return updatedOrder;
    }

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
                    }
                }
            }
        });

        // Recalculate shared fees if this was a special address order
        if (order.enderecoEspecialNome) {
            await this.recalculateSharedFees(order.dataEncomendaId, order.enderecoEspecialNome);
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
            console.error('Erro ao notificar usuário sobre reversão de cancelamento:', error);
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
                    }
                },
                itens: {
                    include: {
                        produto: true,
                        variedade: true,
                    }
                }
            },
        });

        // Calculate totals
        const totalOrders = orders.length;
        const confirmedOrders = orders.filter(o => o.statusPagamento === 'confirmado').length;
        const pendingOrders = orders.filter(o => o.statusPagamento === 'pendente').length;
        const blockedOrders = orders.filter(o => o.statusPagamento === 'bloqueado').length;
        const cancelledOrders = orders.filter(o => o.statusPagamento === 'cancelado').length;

        const totalValue = orders
            .filter(o => o.statusPagamento !== 'cancelado')
            .reduce((sum, o) => sum + Number(o.totalValor), 0);

        const confirmedValue = orders
            .filter(o => o.statusPagamento === 'confirmado')
            .reduce((sum, o) => sum + Number(o.totalValor), 0);

        // Group products
        const productSummary: Record<string, { nome: any; variedadeNome: any; quantidade: number; total: number }> = {};

        orders
            .filter(o => o.statusPagamento !== 'cancelado')
            .forEach(order => {
                order.itens.forEach(item => {
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
                    productSummary[key].total += item.quantidade * Number(item.precoUnitario);
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
            products: Object.values(productSummary).sort((a, b) => b.quantidade - a.quantidade),
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
            const user = await this.prisma.usuario.findUnique({ where: { id: userId } });
            if (user?.role !== 'admin') {
                throw new ForbiddenException('Não autorizado');
            }
        }

        if (order.formaPagamento !== 'pix') throw new BadRequestException('Pedido não é do tipo PIX');

        const config = await this.configuracoesService.get();
        if (!config || !config.chavePix) {
            throw new BadRequestException('Configuração PIX não encontrada. Entre em contato com o suporte.');
        }

        const pix = QrCodePix({
            version: '01',
            key: config.chavePix,
            name: config.nomeRecebedor || 'Yatsunami',
            city: config.cidadeRecebedor || 'Curitiba',
            transactionId: `PAY${order.id}`,
            message: `Pedido #${order.id}`,
            value: Number(order.totalValor),
        });

        return {
            payload: pix.payload(),
            base64: await pix.base64(),
        };
    }
}

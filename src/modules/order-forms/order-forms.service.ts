import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderFormDto, UpdateOrderFormDto } from './dto';
import { SalesService } from '../sales/sales.service';
import { DiscountType } from '../sales/dto/create-sale.dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OrderFormsService {
    constructor(
        private prisma: PrismaService,
        private salesService: SalesService,
        private notificationsService: NotificationsService,
    ) { }

    private mapToSnakeCase(item: any) {
        return {
            id: item.id,
            data_entrega: item.dataEntrega instanceof Date ? item.dataEntrega.toISOString().split('T')[0] : item.dataEntrega,
            data_inicio_pedido: item.dataInicioPedido ?? null,
            data_limite_pedido: item.dataLimitePedido,
            ativo: item.ativo,
            concluido: item.concluido,
            observacoes: item.observacoes,
            enderecos_especiais: item.enderecosEspeciais,
            criado_em: item.criadoEm,
        };
    }

    async create(createDto: CreateOrderFormDto) {
        const item = await this.prisma.dataEncomenda.create({
            data: {
                dataEntrega: new Date(createDto.data_entrega),
                dataInicioPedido: createDto.data_inicio_pedido ? new Date(createDto.data_inicio_pedido) : null,
                dataLimitePedido: new Date(createDto.data_limite_pedido),
                ativo: createDto.ativo ?? true,
                concluido: createDto.concluido ?? false,
                observacoes: createDto.observacoes,
                enderecosEspeciais: createDto.enderecos_especiais,
            },
        });

        if (createDto.selections && createDto.selections.length > 0) {
            await this.prisma.produtoEncomenda.createMany({
                data: createDto.selections.map(s => ({
                    dataEncomendaId: item.id,
                    produtoId: s.product_id,
                    variedadeId: s.variedade_id || null,
                })),
            });
        }

        return this.findOne(item.id);
    }

    async findAll() {
        // Fetch all categories to get their order
        const categories = await this.prisma.categoria.findMany();
        const categoryOrderMap = new Map<string, number>();
        categories.forEach(c => {
            if (c.nome) {
                categoryOrderMap.set(JSON.stringify(c.nome), c.ordem);
            }
        });

        const items = await this.prisma.dataEncomenda.findMany({
            include: {
                produtosEncomenda: {
                    include: {
                        produto: true,
                    },
                },
                rotaEntrega: {
                    select: {
                        id: true,
                    },
                },
            },
            orderBy: {
                dataEntrega: 'desc',
            },
        });

        return items.map(item => {
            const mapped = this.mapToSnakeCase(item);

            // Calculate totals for active selections in this form
            const total_produtos = item.produtosEncomenda.length;

            const categoryStatsMap = new Map<string, number>();

            const categorias_count: Record<string, number> = {};
            item.produtosEncomenda.forEach(selection => {
                const categoryJson = selection.produto.categoria as any;
                const categoryName = categoryJson?.['pt-BR'] || 'Outros';
                categorias_count[categoryName] = (categorias_count[categoryName] || 0) + 1;

                if (categoryJson) {
                    const key = JSON.stringify(categoryJson);
                    categoryStatsMap.set(key, (categoryStatsMap.get(key) || 0) + 1);
                }
            });

            const category_stats = Array.from(categoryStatsMap.entries()).map(([key, count]) => {
                const category = JSON.parse(key);
                // Try to find order by exact JSON match, or fallback to 999
                const ordem = categoryOrderMap.get(key) ?? 999;
                return {
                    category,
                    count,
                    ordem
                };
            });

            return {
                ...mapped,
                has_route: !!item.rotaEntrega,
                total_produtos,
                categorias_count, // Keeping for backward compatibility if needed, but we'll use category_stats
                category_stats,
            };
        });
    }

    async findLatest() {
        const item = await this.prisma.dataEncomenda.findFirst({
            orderBy: {
                criadoEm: 'desc',
            },
            include: {
                produtosEncomenda: true,
            },
        });

        if (!item) return null;

        const mapped = this.mapToSnakeCase(item);
        return {
            ...mapped,
            selections: item.produtosEncomenda.map(p => ({
                product_id: p.produtoId,
                variedade_id: p.variedadeId,
            })),
        };
    }

    async findOne(id: number) {
        const item = await this.prisma.dataEncomenda.findUnique({
            where: { id },
            include: {
                produtosEncomenda: true,
            },
        });

        if (!item) {
            throw new NotFoundException(`Order form with ID ${id} not found`);
        }

        const mapped = this.mapToSnakeCase(item);
        return {
            ...mapped,
            selections: item.produtosEncomenda.map(p => ({
                product_id: p.produtoId,
                variedade_id: p.variedadeId,
            })),
        };
    }

    async update(id: number, updateDto: UpdateOrderFormDto, adminUserId?: string) {
        await this.findOne(id); // Ensure it exists

        const item = await this.prisma.dataEncomenda.update({
            where: { id },
            data: {
                ...(updateDto.data_entrega && { dataEntrega: new Date(updateDto.data_entrega) }),
                ...(updateDto.data_inicio_pedido !== undefined && {
                    dataInicioPedido: updateDto.data_inicio_pedido ? new Date(updateDto.data_inicio_pedido) : null,
                }),
                ...(updateDto.data_limite_pedido && { dataLimitePedido: new Date(updateDto.data_limite_pedido) }),
                ...(updateDto.ativo !== undefined && { ativo: updateDto.ativo }),
                ...(updateDto.concluido !== undefined && { concluido: updateDto.concluido }),
                ...(updateDto.observacoes !== undefined && { observacoes: updateDto.observacoes }),
                ...(updateDto.enderecos_especiais !== undefined && { enderecosEspeciais: updateDto.enderecos_especiais }),
                // If closing, ensure it's also inactive
                ...(updateDto.concluido === true && { ativo: false }),
            },
        });

        // If form is being marked as completed, confirm all pending payments and SAVE previous status
        if (updateDto.concluido === true) {
            await this.prisma.$executeRawUnsafe(`
                UPDATE pedidos_encomenda 
                SET 
                    status_pagamento_anterior = status_pagamento,
                    status_pagamento = 'confirmado',
                    data_pagamento = NOW(),
                    confirmado_por = $1
                WHERE 
                    data_encomenda_id = $2 
                    AND status_pagamento IN ('pendente', 'bloqueado', 'aguardando_confirmacao')
            `, `auto_${adminUserId || 'system'}`, id);

            // Mark all non-cancelled orders as 'entregue'
            await this.prisma.pedidoEncomenda.updateMany({
                where: {
                    dataEncomendaId: id,
                    statusPagamento: { notIn: ['cancelado', 'entregue'] },
                },
                data: { statusPagamento: 'entregue', emEntrega: false },
            });

            // Create Sales for all non-cancelled orders
            const orders = await this.prisma.pedidoEncomenda.findMany({
                where: {
                    dataEncomendaId: id,
                    statusPagamento: { not: 'cancelado' },
                    vendaId: null, // Prevent double creation
                },
                include: {
                    itens: {
                        include: {
                            produto: true,
                            variedade: true,
                        },
                    },
                },
            });

            // Verify if the admin user exists in our local database to avoid FK violations
            const adminExists = adminUserId ? await this.prisma.usuario.findUnique({ where: { id: adminUserId } }) : null;
            const validAdminId: string | null = adminExists ? (adminUserId as string) : null;

            for (const order of orders) {
                try {
                    const deliveryFee = Number(order.taxaEntrega) || 0;
                    const saleData = {
                        usuarioId: order.usuarioId,
                        observacoes: deliveryFee > 0
                            ? `Formulário #${id} - Pedido ${order.codigo || order.id} | Taxa de entrega: R$ ${deliveryFee.toFixed(2).replace('.', ',')}`
                            : `Formulário #${id} - Pedido ${order.codigo || order.id}`,
                        taxaEntrega: deliveryFee > 0 ? deliveryFee : undefined,
                        data: order.horarioEstimadoEntrega ?? undefined,
                        itens: order.itens.map(item => ({
                            produtoId: item.produtoId,
                            variedadeId: item.variedadeId || undefined,
                            quantidade: item.quantidade,
                            precoUnitario: Number(item.precoUnitario || 0),
                        })),
                    };

                    const sale = await this.salesService.create(validAdminId, saleData);

                    await this.prisma.pedidoEncomenda.update({
                        where: { id: order.id },
                        data: { vendaId: sale.id },
                    });
                } catch (error) {
                    console.error(`Error creating sale for order ${order.id}:`, error);
                }
            }
        }

        // If form is being reopened, RESTORE previous status ONLY for batch-confirmed orders
        if (updateDto.concluido === false) {
            // Find all sales associated with this form
            const ordersWithSales = await this.prisma.pedidoEncomenda.findMany({
                where: {
                    dataEncomendaId: id,
                    vendaId: { not: null },
                },
                select: {
                    id: true,
                    vendaId: true,
                },
            });

            const vendaIds = ordersWithSales
                .map(o => o.vendaId)
                .filter((id): id is number => id !== null);

            if (vendaIds.length > 0) {
                // Clear links first
                await this.prisma.pedidoEncomenda.updateMany({
                    where: { id: { in: ordersWithSales.map(o => o.id) } },
                    data: { vendaId: null },
                });

                // Delete sales (items will be deleted via cascade)
                await this.prisma.venda.deleteMany({
                    where: { id: { in: vendaIds } },
                });
            }

            await this.prisma.$executeRawUnsafe(`
                UPDATE pedidos_encomenda
                SET
                    status_pagamento = status_pagamento_anterior,
                    status_pagamento_anterior = NULL,
                    data_pagamento = NULL,
                    confirmado_por = NULL
                WHERE
                    data_encomenda_id = $1 
                    AND status_pagamento = 'confirmado'
                    AND status_pagamento_anterior IS NOT NULL
                    AND confirmado_por LIKE 'auto_%'
            `, id);
        }

        if (updateDto.selections) {
            // Simple sync: delete existing and recreate
            await this.prisma.produtoEncomenda.deleteMany({
                where: { dataEncomendaId: id },
            });

            if (updateDto.selections.length > 0) {
                await this.prisma.produtoEncomenda.createMany({
                    data: updateDto.selections.map(s => ({
                        dataEncomendaId: id,
                        produtoId: s.product_id,
                        variedadeId: s.variedade_id || null,
                    })),
                });
            }
        }

        return this.findOne(id);
    }

    async remove(id: number) {
        await this.findOne(id);
        return this.prisma.dataEncomenda.delete({
            where: { id },
        });
    }

    async findAvailable() {
        const now = new Date();
        const items = await this.prisma.dataEncomenda.findMany({
            where: {
                ativo: true,
                concluido: false,
                dataLimitePedido: {
                    gt: now,
                },

            },
            orderBy: {
                dataEntrega: 'asc',
            },
        });

        return items.map(item => this.mapToSnakeCase(item));
    }

    async findProducts(id: number) {
        const items = await this.prisma.produtoEncomenda.findMany({
            where: {
                dataEncomendaId: id,
                ativo: true,
                produto: {
                    ativo: true,
                },
            },
            include: {
                produto: {
                    include: {
                        variedades: true,
                    },
                },
            },
        });

        return items.map(item => {
            const produto = item.produto as any;
            // Filter varieties to only include the one strictly specified in this selection entry.
            // Also ignore inactive varieties.
            const filteredVarieties = (produto.variedades || [])
                .filter((v: any) => v.id === item.variedadeId && v.ativo)
                .map((v: any) => ({
                    ...v,
                    preco: Number(v.preco ?? 0),
                    disponivel: true,
                }));

            // Defensive guard:
            // if a product has varieties, selections must point to a specific active variety.
            // Old/legacy rows with variedadeId = null should be ignored on client listing.
            if ((produto.variedades || []).length > 0 && item.variedadeId == null) {
                return null;
            }

            // If a selected variety is no longer active/available, skip this stale selection.
            if (item.variedadeId != null && filteredVarieties.length === 0) {
                return null;
            }

            return {
                ...produto,
                id: produto.id,
                preco: Number(produto.preco ?? 0),
                variedades_produto: filteredVarieties,
                orderFormProductId: item.id,
            };
        }).filter((item): item is NonNullable<typeof item> => item !== null);
    }

    async getSummaryData(id: number) {
        const orderForm = await this.prisma.dataEncomenda.findUnique({
            where: { id },
            include: {
                pedidosEncomenda: {
                    where: { statusPagamento: { not: 'cancelado' } },
                    include: {
                        usuario: true,
                        itens: {
                            include: {
                                produto: true,
                                variedade: true,
                            },
                        },
                    },
                },
            },
        });

        if (!orderForm) {
            throw new NotFoundException(`Order form with ID ${id} not found`);
        }

        return {
            date: orderForm.dataEntrega,
            orders: orderForm.pedidosEncomenda,
        };
    }

    async sendFormNotification(id: number) {
        const orderForm = await this.findOne(id);

        // Buscar todos os usuários ativos
        const users = await this.prisma.usuario.findMany({
            where: { role: 'user' },
            select: { id: true },
        });

        if (users.length === 0) return { sent: 0 };

        const formattedDate = new Date(orderForm.data_entrega).toLocaleDateString('pt-BR');

        await this.notificationsService.broadcastNotification({
            usuarioIds: users.map(u => u.id),
            chave: 'notification.newOrderForm',
            parametros: { data: formattedDate },
            dataEncomendaId: id,
            tipo: 'user',
        });

        return { sent: users.length };
    }
}

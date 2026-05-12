import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Mesma regra que `getFormStatus` em `yatsunami_app/app/(tabs)/index.tsx` */
function classifyProximoPedidoStatus(
    form: {
        ativo: boolean;
        concluido: boolean;
        dataInicioPedido: Date | null;
        dataLimitePedido: Date;
    },
    now: Date,
): 'aberto' | 'emBreve' | 'encerrado' {
    const deadline = new Date(form.dataLimitePedido);
    const startDate = form.dataInicioPedido ? new Date(form.dataInicioPedido) : null;
    if (!form.ativo || form.concluido || now > deadline) return 'encerrado';
    if (startDate && now < startDate) return 'emBreve';
    return 'aberto';
}

function deliveryDateStartOfDayTs(dataEntregaYmd: string): number {
    const day = dataEntregaYmd.split('T')[0];
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
}

type ProximoPedidoDto = {
    id: number;
    data_entrega: string;
    data_inicio_pedido: Date | null;
    data_limite_pedido: Date;
    observacoes: string | null;
    ativo: boolean;
    concluido: boolean;
};

/**
 * Aberto / em breve: data de entrega futura mais próxima de hoje primeiro (asc).
 * Encerrado: data de entrega passada mais próxima de hoje primeiro (mais recente no passado = desc).
 * Lista final: abertos + em breve, depois encerrados; limitado a `max`.
 */
function sortProximosPedidosForUser(items: ProximoPedidoDto[], now: Date, max: number): ProximoPedidoDto[] {
    const openLike: ProximoPedidoDto[] = [];
    const closed: ProximoPedidoDto[] = [];
    for (const item of items) {
        const st = classifyProximoPedidoStatus(
            {
                ativo: item.ativo,
                concluido: item.concluido,
                dataInicioPedido: item.data_inicio_pedido,
                dataLimitePedido: item.data_limite_pedido,
            },
            now,
        );
        if (st === 'encerrado') closed.push(item);
        else openLike.push(item);
    }
    openLike.sort((a, b) => deliveryDateStartOfDayTs(a.data_entrega) - deliveryDateStartOfDayTs(b.data_entrega));
    closed.sort((a, b) => deliveryDateStartOfDayTs(b.data_entrega) - deliveryDateStartOfDayTs(a.data_entrega));
    return [...openLike, ...closed].slice(0, max);
}

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) { }

    async getAdminDashboard(filters?: { year?: number; month?: number }) {
        const now = new Date();
        const year = filters?.year || now.getFullYear();
        const month = filters?.month !== undefined ? filters.month : now.getMonth() + 1;

        // Calculate start and end dates for the summary
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);

        // 1. Total Vendas (filtered)
        const summaryVendas = await this.prisma.venda.aggregate({
            _sum: {
                total: true,
            },
            where: {
                data: {
                    gte: startDate,
                    lte: endDate,
                },
            },
        });

        // 2. Total Despesas (filtered)
        const summaryDespesas = await this.prisma.notaDespesa.aggregate({
            _sum: {
                valorTotal: true,
            },
            where: {
                dataCompra: {
                    gte: startDate,
                    lte: endDate,
                },
            },
        });

        // 3. Unified History (Last 12 months for chart flexibility)
        const chartStart = new Date(startDate);
        chartStart.setFullYear(chartStart.getFullYear() - 1);
        chartStart.setDate(1);

        const vendasHistory = await this.prisma.venda.groupBy({
            by: ['data'],
            where: {
                data: {
                    gte: chartStart,
                    lte: endDate,
                },
            },
            _sum: {
                total: true,
            },
        });

        const despesasHistory = await this.prisma.notaDespesa.groupBy({
            by: ['dataCompra'],
            where: {
                dataCompra: {
                    gte: chartStart,
                    lte: endDate,
                },
            },
            _sum: {
                valorTotal: true,
            },
        });

        const unifiedHistory = this.groupByMonthUnified(vendasHistory, despesasHistory, chartStart, endDate);

        // 4. Contagem de Pedidos Pendentes
        const pedidosPendentes = await this.prisma.pedidoEncomenda.count({
            where: {
                statusPagamento: 'pendente',
            },
        });

        const pedidosDiretosPendentes = await this.prisma.pedidoDireto.count({
            where: {
                status: 'pendente',
            },
        });

        const totalReceita = Number(summaryVendas._sum.total) || 0;
        const totalDespesas = Number(summaryDespesas._sum.valorTotal) || 0;
        const lucroLiquido = totalReceita - totalDespesas;
        const margem = totalReceita > 0 ? (lucroLiquido / totalReceita) * 100 : 0;

        // 5. Available Years with data
        const [minVenda, minDespesa] = await Promise.all([
            this.prisma.venda.findFirst({
                select: { data: true },
                orderBy: { data: 'asc' },
            }),
            this.prisma.notaDespesa.findFirst({
                select: { dataCompra: true },
                orderBy: { dataCompra: 'asc' },
            }),
        ]);

        const startYear = Math.min(
            minVenda?.data?.getFullYear() || now.getFullYear(),
            minDespesa?.dataCompra?.getFullYear() || now.getFullYear()
        );
        const endYear = now.getFullYear();

        const availableYears: number[] = [];
        for (let y = endYear; y >= startYear; y--) {
            availableYears.push(y);
        }

        return {
            summary: {
                totalReceita,
                totalDespesas,
                lucroLiquido,
                margem,
                pedidosPendentes: pedidosPendentes + pedidosDiretosPendentes,
            },
            history: unifiedHistory,
            availableYears,
            filters: {
                year,
                month,
            },
        };
    }

    async getUserDashboard(userId: string) {
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // 1. User info
        const usuario = await this.prisma.usuario.findUnique({
            where: { id: userId },
            select: { nome: true, avatarUrl: true },
        });

        // 2. Formulário aberto agora (aceita pedidos)
        const formAberta = await this.prisma.dataEncomenda.findFirst({
            where: {
                ativo: true,
                concluido: false,
                dataLimitePedido: { gte: now },
                OR: [
                    { dataInicioPedido: null },
                    { dataInicioPedido: { lte: now } },
                ],
            },
            orderBy: { dataEntrega: 'asc' },
        });

        // 3. Check if user already has an order for the open form
        let jaFezPedidoFormAberta = false;
        if (formAberta) {
            const pedidoExistente = await this.prisma.pedidoEncomenda.findFirst({
                where: {
                    usuarioId: userId,
                    dataEncomendaId: formAberta.id,
                    statusPagamento: { not: 'cancelado' },
                },
            });
            jaFezPedidoFormAberta = !!pedidoExistente;
        }

        // 4. Próximos pedidos (forms ativos + recently closed)
        const proximosWhere = {
            OR: [
                { ativo: true },
                { dataLimitePedido: { gte: sevenDaysAgo } },
            ],
        };

        const [proximosByDeliveryAsc, proximosByDeliveryDesc] = await Promise.all([
            this.prisma.dataEncomenda.findMany({
                where: proximosWhere,
                orderBy: { dataEntrega: 'asc' },
                take: 40,
            }),
            this.prisma.dataEncomenda.findMany({
                where: proximosWhere,
                orderBy: { dataEntrega: 'desc' },
                take: 40,
            }),
        ]);

        const mergedById = new Map<number, (typeof proximosByDeliveryAsc)[0]>();
        for (const row of proximosByDeliveryAsc) mergedById.set(row.id, row);
        for (const row of proximosByDeliveryDesc) mergedById.set(row.id, row);

        const proximosMapped: ProximoPedidoDto[] = Array.from(mergedById.values()).map(form => ({
            id: form.id,
            data_entrega:
                form.dataEntrega instanceof Date
                    ? form.dataEntrega.toISOString().split('T')[0]
                    : String(form.dataEntrega).split('T')[0],
            data_inicio_pedido: form.dataInicioPedido ?? null,
            data_limite_pedido: form.dataLimitePedido,
            observacoes: form.observacoes ?? null,
            ativo: form.ativo,
            concluido: form.concluido,
        }));

        const proximosPedidos = sortProximosPedidosForUser(proximosMapped, now, 3);

        // 5. Últimos pedidos do usuário
        const meusUltimosPedidos = await this.prisma.pedidoEncomenda.findMany({
            where: { usuarioId: userId },
            include: {
                dataEncomenda: {
                    select: { dataEntrega: true },
                },
            },
            orderBy: { dataPedido: 'desc' },
            take: 3,
        });

        // 6. Última notificação não lida
        const ultimaNotificacao = await this.prisma.notificacao.findFirst({
            where: { usuarioId: userId, lido: false },
            orderBy: { criadoEm: 'desc' },
        });

        // 7. Quick stats
        const [totalEncomendas, totalDiretos] = await Promise.all([
            this.prisma.pedidoEncomenda.count({ where: { usuarioId: userId } }),
            this.prisma.pedidoDireto.count({ where: { usuarioId: userId } }),
        ]);

        return {
            userName: usuario?.nome ?? null,
            avatarUrl: usuario?.avatarUrl ?? null,
            formAberta: formAberta ? {
                id: formAberta.id,
                data_entrega: formAberta.dataEntrega instanceof Date ? formAberta.dataEntrega.toISOString().split('T')[0] : formAberta.dataEntrega,
                data_inicio_pedido: formAberta.dataInicioPedido ?? null,
                data_limite_pedido: formAberta.dataLimitePedido,
                observacoes: formAberta.observacoes ?? null,
            } : null,
            jaFezPedidoFormAberta,
            proximosPedidos,
            meusUltimosPedidos: meusUltimosPedidos.map(p => ({
                id: p.id,
                codigo: p.codigo,
                dataPedido: p.dataPedido,
                statusPagamento: p.statusPagamento,
                totalValor: p.totalValor,
                dataEntrega: p.dataEncomenda.dataEntrega,
            })),
            ultimaNotificacao,
            quickStats: {
                totalPedidos: totalEncomendas + totalDiretos,
            },
        };
    }

    private groupByMonthUnified(vendas: any[], despesas: any[], chartStart: Date, chartEnd: Date) {
        const result = {};

        // Initialize all months in the range
        let current = new Date(chartStart);
        while (current <= chartEnd) {
            const key = `${current.getMonth() + 1}/${current.getFullYear()}`;
            result[key] = { revenue: 0, expenses: 0 };
            current.setMonth(current.getMonth() + 1);
        }

        vendas.forEach(item => {
            const date = new Date(item.data);
            const key = `${date.getMonth() + 1}/${date.getFullYear()}`;
            if (result[key]) {
                result[key].revenue += Number(item._sum.total || 0);
            }
        });

        despesas.forEach(item => {
            const date = new Date(item.dataCompra);
            const key = `${date.getMonth() + 1}/${date.getFullYear()}`;
            if (result[key]) {
                result[key].expenses += Number(item._sum.valorTotal || 0);
            }
        });

        return Object.keys(result).map(key => ({
            label: key,
            revenue: result[key].revenue,
            expenses: result[key].expenses,
        })).sort((a, b) => {
            const [mA, yA] = a.label.split('/').map(Number);
            const [mB, yB] = b.label.split('/').map(Number);
            return yA !== yB ? yA - yB : mA - mB;
        });
    }

    private groupByMonth(data: any[], dateField: string, valueField: string) {
        const months = {};
        data.forEach((item) => {
            const date = new Date(item[dateField]);
            const monthYear = `${date.getMonth() + 1}/${date.getFullYear()}`;
            if (!months[monthYear]) {
                months[monthYear] = 0;
            }
            months[monthYear] += Number(item._sum[valueField] || 0);
        });

        return Object.keys(months).map((key) => ({
            label: key,
            value: months[key],
        })).sort((a, b) => {
            const [mA, yA] = a.label.split('/').map(Number);
            const [mB, yB] = b.label.split('/').map(Number);
            return yA !== yB ? yA - yB : mA - mB;
        });
    }
}

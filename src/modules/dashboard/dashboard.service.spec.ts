import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Datas da dashboard no fuso do negócio (GMT-3, Curitiba) — verificação do
 * review, D2. O processo roda em UTC: com `new Date(ano, mes, 1)` e
 * `getMonth()`, o mês começava às 21:00 do último dia do mês anterior em
 * Brasília, e uma venda das 22:00 do dia 30 entrava no mês seguinte.
 */
function prismaFalso() {
  return {
    venda: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { total: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    notaDespesa: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { valorTotal: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    pedidoEncomenda: { count: jest.fn().mockResolvedValue(0) },
    pedidoDireto: { count: jest.fn().mockResolvedValue(0) },
  };
}

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof prismaFalso>;

  beforeEach(async () => {
    prisma = prismaFalso();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
  });

  const intervalo = (m: jest.Mock) =>
    (m.mock.calls[0][0] as { where: Record<string, { gte: Date; lte: Date }> })
      .where;

  it('o resumo do mês usa os limites do mês em Brasília', async () => {
    await service.getAdminDashboard({ year: 2026, month: 11 });

    const { data } = intervalo(prisma.venda.aggregate);
    expect(data.gte.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(data.lte.toISOString()).toBe('2026-12-01T02:59:59.999Z');
    const { dataCompra } = intervalo(prisma.notaDespesa.aggregate);
    expect(dataCompra.gte.toISOString()).toBe('2026-11-01T03:00:00.000Z');
  });

  it('venda das 22:00 do último dia conta no próprio mês', async () => {
    prisma.venda.groupBy.mockResolvedValue([
      // 30/11 22:00 em Brasília = 01/12 01:00 UTC
      { data: new Date('2026-12-01T01:00:00Z'), _sum: { total: 50 } },
    ]);

    const r = await service.getAdminDashboard({ year: 2026, month: 12 });

    const novembro = r.history.find((h) => h.label === '11/2026');
    const dezembro = r.history.find((h) => h.label === '12/2026');
    expect(novembro?.revenue).toBe(50);
    expect(dezembro?.revenue).toBe(0);
  });

  it('o histórico cobre os 12 meses anteriores e o mês escolhido', async () => {
    const r = await service.getAdminDashboard({ year: 2026, month: 11 });

    expect(r.history[0].label).toBe('11/2025');
    expect(r.history[r.history.length - 1].label).toBe('11/2026');
    expect(r.history).toHaveLength(13);
  });
});

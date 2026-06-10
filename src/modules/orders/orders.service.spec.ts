import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { StorageService } from '../../config/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CronLockService } from '../../common/cron/cron-lock.service';

describe('OrdersService (perf Fase 2)', () => {
  let service: OrdersService;

  const mockPrisma = {
    pedidoEncomenda: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfiguracoesService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: NotificationsService, useValue: { createAndSendNotification: jest.fn() } },
        {
          provide: CronLockService,
          useValue: {
            enabled: () => true,
            withLock: async (_key: number, _name: string, fn: () => Promise<void>) => fn(),
          },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('não deve executar UPDATE — apenas resolve status em memória', async () => {
      const pastDeadline = new Date('2020-01-01T00:00:00Z');
      const futureDeadline = new Date('2099-01-01T00:00:00Z');

      mockPrisma.pedidoEncomenda.findMany.mockResolvedValue([
        {
          id: 1,
          statusPagamento: 'bloqueado',
          enderecoEspecialNome: null,
          dataEncomenda: { dataLimitePedido: pastDeadline },
          itens: [],
        },
        {
          id: 2,
          statusPagamento: 'pendente',
          enderecoEspecialNome: 'Condomínio X',
          dataEncomenda: { dataLimitePedido: futureDeadline },
          itens: [],
        },
        {
          id: 3,
          statusPagamento: 'confirmado',
          enderecoEspecialNome: null,
          dataEncomenda: { dataLimitePedido: futureDeadline },
          itens: [],
        },
      ]);

      const result = await service.findAll('user-1', 0, 10);

      expect(mockPrisma.pedidoEncomenda.update).not.toHaveBeenCalled();
      expect(result[0].statusPagamento).toBe('pendente');
      expect(result[1].statusPagamento).toBe('bloqueado');
      expect(result[2].statusPagamento).toBe('confirmado');
    });
  });

  describe('syncPaymentLockStatuses', () => {
    it('deve usar updateMany para unlock e lock em batch', async () => {
      mockPrisma.pedidoEncomenda.updateMany
        .mockResolvedValueOnce({ count: 2 })
        .mockResolvedValueOnce({ count: 1 });
      mockPrisma.pedidoEncomenda.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);

      await service.syncPaymentLockStatuses();

      expect(mockPrisma.pedidoEncomenda.updateMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.pedidoEncomenda.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          statusPagamento: 'bloqueado',
          dataEncomenda: { dataLimitePedido: { lt: expect.any(Date) } },
        },
        data: { statusPagamento: 'pendente' },
      });
      expect(mockPrisma.pedidoEncomenda.findMany).toHaveBeenCalled();
    });
  });

  describe('findByOrderForm', () => {
    it('deve repassar skip e take quando informados', async () => {
      mockPrisma.pedidoEncomenda.findMany.mockResolvedValue([]);

      await service.findByOrderForm(5, 'busca', 20, 50);

      expect(mockPrisma.pedidoEncomenda.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 50 }),
      );
    });

    it('sem take — não limita resultados (retrocompatível)', async () => {
      mockPrisma.pedidoEncomenda.findMany.mockResolvedValue([]);

      await service.findByOrderForm(5);

      const call = mockPrisma.pedidoEncomenda.findMany.mock.calls[0][0];
      expect(call.take).toBeUndefined();
    });
  });
});

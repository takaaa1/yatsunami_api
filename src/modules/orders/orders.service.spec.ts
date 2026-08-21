import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { StorageService } from '../../config/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CronLockService } from '../../common/cron/cron-lock.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('OrdersService (perf Fase 2)', () => {
  let service: OrdersService;

  const mockPrisma = {
    pedidoEncomenda: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    dataEncomenda: { findUnique: jest.fn() },
    usuario: { findUnique: jest.fn() },
    produto: { findUnique: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfiguracoesService, useValue: {} },
        { provide: StorageService, useValue: {} },
        {
          provide: NotificationsService,
          useValue: { createAndSendNotification: jest.fn() },
        },
        {
          provide: CronLockService,
          useValue: {
            enabled: () => true,
            withLock: async (
              _key: number,
              _name: string,
              fn: () => Promise<void>,
            ) => fn(),
          },
        },
        { provide: RealtimeGateway, useValue: { broadcast: jest.fn() } },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    jest.clearAllMocks();
  });

  /**
   * Regras de janela, propriedade e duplicidade.
   *
   * Auditadas e **corretas** — o motivo destes casos não é consertar nada, é
   * que elas não tinham teste nenhum. O spec existente cobria só desempenho
   * (consultas em lote), e estas são as regras cuja falha custa mais caro:
   * aceitar pedido fora do prazo, ou entregar o pedido de um usuário a outro.
   */
  describe('regras de negócio da criação', () => {
    const emHoras = (n: number) => new Date(Date.now() + n * 3600_000);

    const janela = (extra: Record<string, unknown> = {}) => ({
      id: 7,
      ativo: true,
      concluido: false,
      dataInicioPedido: emHoras(-24),
      dataLimitePedido: emHoras(24),
      ...extra,
    });

    const pedido = () => ({
      dataEncomendaId: 7,
      itens: [{ produtoId: 1, quantidade: 1 }],
    });

    beforeEach(() => {
      mockPrisma.pedidoEncomenda.findFirst.mockResolvedValue(null);
    });

    it('recusa quando a data de encomenda não existe', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(null);

      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('recusa quando a data foi desativada', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(
        janela({ ativo: false }),
      );

      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('recusa depois do prazo', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(
        janela({ dataLimitePedido: emHoras(-1) }),
      );

      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('recusa antes da abertura', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(
        janela({ dataInicioPedido: emHoras(1) }),
      );

      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('recusa segundo pedido do mesmo usuário para a mesma data', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(janela());
      mockPrisma.pedidoEncomenda.findFirst.mockResolvedValue({
        id: 99,
        statusPagamento: 'pendente',
      });

      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deixa criar de novo quando o pedido anterior foi cancelado', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(janela());
      mockPrisma.pedidoEncomenda.findFirst.mockResolvedValue({
        id: 99,
        statusPagamento: 'cancelado',
      });
      mockPrisma.produto.findUnique.mockResolvedValue(null);

      // Passou das guardas e tropeçou no produto inexistente, que é o passo
      // seguinte. É assim que se prova que a guarda **não** barrou, sem ter de
      // dublar a criação inteira.
      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.produto.findUnique).toHaveBeenCalled();
    });

    it('dentro da janela, segue para a verificação dos produtos', async () => {
      mockPrisma.dataEncomenda.findUnique.mockResolvedValue(janela());
      mockPrisma.produto.findUnique.mockResolvedValue(null);

      await expect(service.create('user-1', pedido() as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.produto.findUnique).toHaveBeenCalled();
    });
  });

  /**
   * Propriedade do pedido. O não-dono recebe **`NotFoundException`**, não
   * `Forbidden`: o comentário do serviço diz o porquê — não vazar a existência
   * do recurso. O caso abaixo trava essa escolha, que é fácil de "corrigir"
   * para Forbidden sem perceber que era deliberada.
   */
  describe('propriedade do pedido', () => {
    const doOutro = {
      id: 5,
      usuarioId: 'dono',
      statusPagamento: 'pendente',
      dataEncomenda: { dataLimitePedido: new Date(Date.now() + 3600_000) },
      itens: [],
      usuario: {},
    };

    it('o dono vê o próprio pedido', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(doOutro);

      await expect(service.findOne(5, 'dono')).resolves.toBeTruthy();
      expect(mockPrisma.usuario.findUnique).not.toHaveBeenCalled();
    });

    it('estranho não vê, e a resposta não revela que o pedido existe', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(doOutro);
      mockPrisma.usuario.findUnique.mockResolvedValue({ role: 'cliente' });

      await expect(service.findOne(5, 'intruso')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne(5, 'intruso')).rejects.not.toThrow(
        ForbiddenException,
      );
    });

    it('admin vê pedido de terceiro', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(doOutro);
      mockPrisma.usuario.findUnique.mockResolvedValue({ role: 'admin' });

      await expect(service.findOne(5, 'admin-1')).resolves.toBeTruthy();
    });
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
      mockPrisma.pedidoEncomenda.findMany.mockResolvedValue([
        { id: 10 },
        { id: 11 },
      ]);

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

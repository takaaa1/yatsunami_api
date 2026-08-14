import { Test, TestingModule } from '@nestjs/testing';
import { ExpressOrdersService } from './express-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('ExpressOrdersService (perf Fase 2)', () => {
  let service: ExpressOrdersService;
  let notificationsService: { createAndSendNotification: jest.Mock };
  let realtimeGateway: { broadcast: jest.Mock };

  const deliveredOrder = {
    id: 1,
    usuarioId: 'user-1',
    codigo: 'EXP001',
    status: 'entregue',
    vendaId: 99,
    itens: [],
  };

  const mockTx = {
    pedidoDireto: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    venda: {
      create: jest.fn(),
    },
  };

  const mockPrisma = {
    $transaction: jest.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
    ),
    pedidoDireto: {
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    notificationsService = {
      createAndSendNotification: jest.fn().mockResolvedValue(undefined),
    };
    realtimeGateway = { broadcast: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpressOrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: RealtimeGateway, useValue: realtimeGateway },
      ],
    }).compile();

    service = module.get<ExpressOrdersService>(ExpressOrdersService);
    jest.clearAllMocks();
  });

  describe('updateStatus entregue', () => {
    it('retry idempotente — não cria venda nem notifica de novo', async () => {
      mockTx.pedidoDireto.findUnique
        .mockResolvedValueOnce({ ...deliveredOrder, itens: [] })
        .mockResolvedValueOnce({
          ...deliveredOrder,
          usuario: { id: 'user-1', nome: 'Test' },
        });

      const result = await service.updateStatus(1, 'entregue', 'admin-1');

      expect(mockTx.venda.create).not.toHaveBeenCalled();
      expect(mockTx.pedidoDireto.update).not.toHaveBeenCalled();
      expect(
        notificationsService.createAndSendNotification,
      ).not.toHaveBeenCalled();
      expect(result?.vendaId).toBe(99);
    });

    it('primeira entrega — cria venda e notifica uma vez', async () => {
      const pendingOrder = {
        id: 2,
        usuarioId: 'user-2',
        codigo: 'EXP002',
        status: 'confirmado',
        vendaId: null,
        itens: [
          { produtoId: 1, variedadeId: null, quantidade: 2, precoUnitario: 10 },
        ],
      };

      mockTx.pedidoDireto.findUnique.mockResolvedValueOnce(pendingOrder);
      mockTx.venda.create.mockResolvedValue({ id: 200 });
      mockTx.pedidoDireto.update.mockResolvedValue({
        ...pendingOrder,
        status: 'entregue',
        vendaId: 200,
        usuario: { id: 'user-2', nome: 'Cliente' },
      });

      const result = await service.updateStatus(2, 'entregue', 'admin-1');

      expect(mockTx.venda.create).toHaveBeenCalledTimes(1);
      expect(mockTx.pedidoDireto.update).toHaveBeenCalledTimes(1);
      expect(
        notificationsService.createAndSendNotification,
      ).toHaveBeenCalledTimes(1);
      expect(result.vendaId).toBe(200);
    });
  });

  describe('create (batch product lookup)', () => {
    it('usa findMany em lote — não findUnique por item', async () => {
      const findManyProduto = jest.fn().mockResolvedValue([
        { id: 1, preco: 50, nome: { 'pt-BR': 'Prod A' }, variedades: [] },
        { id: 2, preco: 30, nome: { 'pt-BR': 'Prod B' }, variedades: [] },
      ]);
      const findManyProdutoPedidoDireto = jest.fn().mockResolvedValue([
        { produtoId: 1, habilitado: true },
        { produtoId: 2, habilitado: true },
      ]);
      const findManyVariedade = jest.fn().mockResolvedValue([]);
      const findUniqueCliente = jest
        .fn()
        .mockResolvedValue({ habilitado: true });
      const findUniqueCodigo = jest.fn().mockResolvedValue(null);
      const createPedido = jest.fn().mockResolvedValue({
        id: 10,
        codigo: 'ABC123',
        usuario: { id: 'user-1', nome: 'Cliente' },
        itens: [],
      });
      const findManyAdmins = jest.fn().mockResolvedValue([{ id: 'admin-1' }]);

      const batchPrisma = {
        clientePedidoDireto: { findUnique: findUniqueCliente },
        produto: { findMany: findManyProduto, findUnique: jest.fn() },
        produtoPedidoDireto: { findMany: findManyProdutoPedidoDireto },
        variedadePedidoDireto: { findMany: findManyVariedade },
        pedidoDireto: { findUnique: findUniqueCodigo, create: createPedido },
        usuario: { findMany: findManyAdmins },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ExpressOrdersService,
          { provide: PrismaService, useValue: batchPrisma },
          { provide: NotificationsService, useValue: notificationsService },
          { provide: RealtimeGateway, useValue: realtimeGateway },
        ],
      }).compile();

      const createService =
        module.get<ExpressOrdersService>(ExpressOrdersService);

      await createService.create('user-1', {
        itens: [
          { produtoId: 1, quantidade: 2 },
          { produtoId: 2, quantidade: 1 },
        ],
        observacoes: 'teste',
      });

      expect(findManyProduto).toHaveBeenCalledTimes(1);
      expect(findManyProdutoPedidoDireto).toHaveBeenCalledTimes(1);
      expect(batchPrisma.produto.findUnique).not.toHaveBeenCalled();
      expect(createPedido).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * O app assina `produtos_pedido_direto`, `variedades_pedido_direto` e
   * `clientes_pedido_direto` via useRealtime, mas nada era publicado nessas
   * salas: na migração do Supabase Realtime para o gateway próprio, só o
   * fluxo de entrega foi religado. Sem estas emissões o catálogo do pedido
   * direto só atualiza quando a tela é reaberta.
   */
  describe('emissões de realtime', () => {
    const buildService = async (prisma: Record<string, unknown>) => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ExpressOrdersService,
          { provide: PrismaService, useValue: prisma },
          { provide: NotificationsService, useValue: notificationsService },
          { provide: RealtimeGateway, useValue: realtimeGateway },
        ],
      }).compile();
      return module.get<ExpressOrdersService>(ExpressOrdersService);
    };

    it('toggleProduct avisa a sala produtos_pedido_direto', async () => {
      const svc = await buildService({
        produtoPedidoDireto: {
          findFirst: jest.fn().mockResolvedValue({ id: 5, produtoId: 12 }),
          update: jest
            .fn()
            .mockResolvedValue({ id: 5, produtoId: 12, habilitado: true }),
          create: jest.fn(),
        },
      });

      await svc.toggleProduct(12, true);

      expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
        'produtos_pedido_direto',
        'UPDATE',
        { produtoId: 12, habilitado: true },
      );
    });

    it('toggleProduct avisa também quando cria a relação', async () => {
      const svc = await buildService({
        produtoPedidoDireto: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
          create: jest
            .fn()
            .mockResolvedValue({ id: 6, produtoId: 12, habilitado: false }),
        },
      });

      await svc.toggleProduct(12, false);

      expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
        'produtos_pedido_direto',
        'UPDATE',
        { produtoId: 12, habilitado: false },
      );
    });

    it('toggleVariety avisa a sala variedades_pedido_direto', async () => {
      const svc = await buildService({
        variedadePedidoDireto: {
          findUnique: jest.fn().mockResolvedValue({ id: 7, variedadeId: 34 }),
          update: jest
            .fn()
            .mockResolvedValue({ id: 7, variedadeId: 34, habilitado: false }),
          create: jest.fn(),
        },
      });

      await svc.toggleVariety(34, false);

      expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
        'variedades_pedido_direto',
        'UPDATE',
        { variedadeId: 34, habilitado: false },
      );
    });

    it('toggleClient avisa a sala clientes_pedido_direto', async () => {
      const svc = await buildService({
        clientePedidoDireto: {
          upsert: jest.fn().mockResolvedValue({
            id: 3,
            usuarioId: 'user-1',
            habilitado: true,
          }),
        },
      });

      await svc.toggleClient('user-1', true);

      expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
        'clientes_pedido_direto',
        'UPDATE',
        { usuarioId: 'user-1', habilitado: true },
      );
    });
  });
});

import { DeliveryService } from './delivery.service';

/**
 * Regressões do incidente de rastreio:
 *
 * O cron `handleStaleTracking` derrubava `emEntrega` da rota inteira quando a
 * localização ficava 2 minutos sem atualizar — menos que os 5 minutos de parada
 * planejada (`serviceStopSeconds`) —, fazendo o botão "Rastrear" sumir para os
 * clientes a cada entrega, sem nenhuma recuperação automática.
 */
describe('DeliveryService — rastreio de entrega', () => {
  const MINUTE_MS = 60_000;

  /** Rota de exemplo: 2 paradas do entregador 1, 1 do entregador 2 e o retorno. */
  const routeFixture = {
    formId: 10,
    nomesParadas: [
      { address: 'Rua A, 100', name: 'Cliente A', orderId: 101, courierId: 1 },
      {
        address: 'Rua B, 200',
        name: 'Cliente B',
        orderIds: [102, 103],
        courierId: 1,
      },
      { address: 'Rua C, 300', name: 'Cliente C', orderId: 201, courierId: 2 },
      { address: 'Restaurante', name: 'Retorno', orderId: null, courierId: 1 },
    ],
  };

  let prisma: any;
  let service: DeliveryService;
  let realtimeGateway: { broadcast: jest.Mock };

  const buildService = () => {
    prisma = {
      entregadorLocalizacao: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 1, ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ where, data }) =>
            Promise.resolve({ id: where.id, ...data }),
          ),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      pedidoEncomenda: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      rotaEntrega: {
        findUnique: jest.fn().mockResolvedValue(routeFixture),
      },
      entregaConcluida: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      usuario: {
        findUnique: jest.fn().mockResolvedValue({ nome: 'Entregador Teste' }),
      },
    };

    const cronLockService = {
      // Executa o callback direto, como se o lock tivesse sido adquirido
      withLock: jest.fn(
        (_key: string, _name: string, fn: () => Promise<void>) => fn(),
      ),
    };

    realtimeGateway = { broadcast: jest.fn() };

    return new DeliveryService(
      prisma,
      {} as any, // RoutesService — não usado nestes cenários
      {} as any, // ConfiguracoesService — não usado nestes cenários
      cronLockService as any,
      realtimeGateway as any,
    );
  };

  beforeEach(() => {
    service = buildService();
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('handleStaleTracking (limpeza automática)', () => {
    const staleSession = {
      id: 5,
      formId: 10,
      courierId: 1,
      atualizadoEm: new Date(Date.now() - 30 * MINUTE_MS),
    };

    beforeEach(() => {
      prisma.entregadorLocalizacao.findMany.mockResolvedValue([staleSession]);
      prisma.entregadorLocalizacao.deleteMany.mockResolvedValue({ count: 1 });
      prisma.pedidoEncomenda.updateMany.mockResolvedValue({ count: 3 });
    });

    it('usa limiar de 20 minutos, maior que a parada planejada de 5 min', async () => {
      const before = Date.now();
      await service.handleStaleTracking();
      const after = Date.now();

      // É esta folga que impede o incidente: com 2 min, uma parada planejada
      // de 5 min era tratada como abandono e derrubava o rastreio da rota.
      const cutoff: Date =
        prisma.entregadorLocalizacao.findMany.mock.calls[0][0].where
          .atualizadoEm.lt;
      expect(cutoff.getTime()).toBeLessThanOrEqual(before - 20 * MINUTE_MS);
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(after - 21 * MINUTE_MS);
    });

    it('não toca em nada quando não há sessão abandonada', async () => {
      prisma.entregadorLocalizacao.findMany.mockResolvedValue([]);

      await service.handleStaleTracking();

      expect(prisma.pedidoEncomenda.updateMany).not.toHaveBeenCalled();
      expect(prisma.entregadorLocalizacao.deleteMany).not.toHaveBeenCalled();
    });

    it('encerra a entrega dos pedidos da sessão abandonada', async () => {
      await service.handleStaleTracking();

      expect(prisma.pedidoEncomenda.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: [101, 102, 103] }, // paradas do entregador 1, sem o Retorno
          emEntrega: true,
          statusPagamento: { notIn: ['entregue', 'cancelado'] },
        },
        data: { emEntrega: false },
      });
    });

    it('avisa os clientes por realtime ao encerrar', async () => {
      await service.handleStaleTracking();

      expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
        'pedidos_encomenda',
        'UPDATE',
        { id: 101, emEntrega: false },
      );
      expect(realtimeGateway.broadcast).toHaveBeenCalledTimes(3);
    });

    it('não avisa ninguém quando nenhum pedido estava em entrega', async () => {
      prisma.pedidoEncomenda.updateMany.mockResolvedValue({ count: 0 });

      await service.handleStaleTracking();

      expect(realtimeGateway.broadcast).not.toHaveBeenCalled();
    });

    it('remove a linha abandonada (não deixa registro órfão reprocessando a cada minuto)', async () => {
      await service.handleStaleTracking();

      expect(prisma.entregadorLocalizacao.deleteMany).toHaveBeenCalledWith({
        where: { atualizadoEm: { lt: expect.any(Date) } },
      });
    });
  });

  describe('updateLocation (gravação da posição)', () => {
    it('nunca grava courierId nulo — assume a rota 1 quando não informado', async () => {
      await service.updateLocation({
        formId: 10,
        latitude: -23.5,
        longitude: -46.6,
      } as any);

      expect(prisma.entregadorLocalizacao.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ formId: 10, courierId: 1 }),
      });
    });

    it('adota linha legada com courier_id NULL e a normaliza', async () => {
      prisma.entregadorLocalizacao.findFirst.mockResolvedValue({
        id: 77,
        formId: 10,
        courierId: null,
      });

      await service.updateLocation({
        formId: 10,
        latitude: -23.5,
        longitude: -46.6,
        courierId: 2,
      } as any);

      expect(prisma.entregadorLocalizacao.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { formId: 10, OR: [{ courierId: 2 }, { courierId: null }] },
        }),
      );
      expect(prisma.entregadorLocalizacao.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 77 },
          data: expect.objectContaining({ courierId: 2 }),
        }),
      );
      expect(prisma.entregadorLocalizacao.create).not.toHaveBeenCalled();
    });
  });

  describe('updateLocation — auto-recuperação do rastreio', () => {
    it('religa emEntrega dos pedidos do entregador quando a posição volta a chegar', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([
        { id: 101 },
        { id: 102 },
      ]);

      const result: any = await service.updateLocation({
        formId: 10,
        latitude: -23.5,
        longitude: -46.6,
        courierId: 1,
      } as any);

      expect(prisma.pedidoEncomenda.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [101, 102] } },
        data: { emEntrega: true },
      });
      expect(result.reactivatedOrderIds).toEqual([101, 102]);
    });

    it('só considera pedidos parados e ainda não finalizados', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([{ id: 101 }]);

      await service.updateLocation({
        formId: 10,
        latitude: 1,
        longitude: 2,
        courierId: 1,
      } as any);

      expect(prisma.pedidoEncomenda.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: [101, 102, 103] }, // apenas paradas do entregador 1
          emEntrega: false,
          statusPagamento: { notIn: ['entregue', 'cancelado'] },
        },
        select: { id: true },
      });
    });

    it('não toca em pedidos de outro entregador', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([{ id: 201 }]);

      await service.updateLocation({
        formId: 10,
        latitude: 1,
        longitude: 2,
        courierId: 2,
      } as any);

      const where = prisma.pedidoEncomenda.findMany.mock.calls[0][0].where;
      expect(where.id.in).toEqual([201]);
    });

    it('não faz nada quando os pedidos já estão em entrega', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([]);

      const result: any = await service.updateLocation({
        formId: 10,
        latitude: 1,
        longitude: 2,
        courierId: 1,
      } as any);

      expect(prisma.pedidoEncomenda.updateMany).not.toHaveBeenCalled();
      expect(result.reactivatedOrderIds).toEqual([]);
    });

    it('é throttled: pings seguidos não repetem a consulta de recuperação', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([{ id: 101 }]);
      const ping = () =>
        service.updateLocation({
          formId: 10,
          latitude: 1,
          longitude: 2,
          courierId: 1,
        } as any);

      await ping();
      await ping();
      await ping();

      expect(prisma.rotaEntrega.findUnique).toHaveBeenCalledTimes(1);
      // mas todas as posições continuam sendo gravadas
      expect(prisma.entregadorLocalizacao.create).toHaveBeenCalledTimes(3);
    });

    it('uma falha na recuperação não derruba a gravação da posição', async () => {
      prisma.rotaEntrega.findUnique.mockRejectedValue(
        new Error('db indisponível'),
      );

      const result: any = await service.updateLocation({
        formId: 10,
        latitude: 1,
        longitude: 2,
        courierId: 1,
      } as any);

      expect(result.reactivatedOrderIds).toEqual([]);
      expect(prisma.entregadorLocalizacao.create).toHaveBeenCalled();
    });
  });

  describe('stopRouteSharing (parada explícita pelo entregador)', () => {
    it('apaga a localização do entregador, inclusive linhas legadas com courier_id NULL', async () => {
      await service.stopRouteSharing(10, 1);

      expect(prisma.entregadorLocalizacao.deleteMany).toHaveBeenCalledWith({
        where: { formId: 10, OR: [{ courierId: 1 }, { courierId: null }] },
      });
    });

    it('sem courierId, apaga todas as localizações da rota', async () => {
      await service.stopRouteSharing(10);

      expect(prisma.entregadorLocalizacao.deleteMany).toHaveBeenCalledWith({
        where: { formId: 10 },
      });
    });

    it('marca os pedidos do entregador como fora de entrega', async () => {
      await service.stopRouteSharing(10, 1);

      expect(prisma.pedidoEncomenda.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [101, 102, 103] } },
        data: { emEntrega: false },
      });
    });

    it('libera o throttle: a próxima posição recebida já reativa o rastreio', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([{ id: 101 }]);
      const ping = () =>
        service.updateLocation({
          formId: 10,
          latitude: 1,
          longitude: 2,
          courierId: 1,
        } as any);

      await ping();
      expect(prisma.rotaEntrega.findUnique).toHaveBeenCalledTimes(1);

      await service.stopRouteSharing(10, 1);
      await ping();

      // sem a limpeza do throttle, esta segunda tentativa seria ignorada por 30s
      expect(prisma.rotaEntrega.findUnique).toHaveBeenCalledTimes(3); // 2 pings + 1 do stopRouteSharing
    });
  });

  /**
   * Reverter uma parada concluída gravava `emEntrega: true` incondicionalmente.
   * Com o compartilhamento desligado o cliente voltava a ver a tag ENTREGANDO e
   * o botão "Rastrear Entrega" — que abria um mapa sem entregador nenhum.
   */
  describe('unmarkDeliveryComplete', () => {
    const pendingOrder = {
      id: 101,
      dataPagamento: null,
      comprovanteUrl: null,
    };

    beforeEach(() => {
      prisma.entregaConcluida.deleteMany.mockResolvedValue({ count: 1 });
      prisma.pedidoEncomenda.findMany.mockResolvedValue([pendingOrder]);
    });

    it('sem compartilhamento ativo, não devolve o pedido para em entrega', async () => {
      prisma.entregadorLocalizacao.findFirst.mockResolvedValue(null);

      const result = await service.unmarkDeliveryComplete(10, 0);

      expect(prisma.pedidoEncomenda.update).toHaveBeenCalledWith({
        where: { id: 101 },
        data: { statusPagamento: 'pendente', emEntrega: false },
      });
      expect(result.emEntrega).toBe(false);
      expect(result.orderIds).toEqual([101]);
    });

    it('com compartilhamento ativo, devolve o pedido para em entrega', async () => {
      prisma.entregadorLocalizacao.findFirst.mockResolvedValue({
        id: 1,
        formId: 10,
        courierId: 1,
      });

      const result = await service.unmarkDeliveryComplete(10, 0);

      expect(prisma.pedidoEncomenda.update).toHaveBeenCalledWith({
        where: { id: 101 },
        data: { statusPagamento: 'pendente', emEntrega: true },
      });
      expect(result.emEntrega).toBe(true);
    });

    it('procura a sessão do entregador da parada, tolerando courier_id nulo', async () => {
      prisma.entregadorLocalizacao.findFirst.mockResolvedValue(null);

      await service.unmarkDeliveryComplete(10, 2); // parada do entregador 2

      expect(prisma.entregadorLocalizacao.findFirst).toHaveBeenCalledWith({
        where: { formId: 10, OR: [{ courierId: 2 }, { courierId: null }] },
      });
    });

    it('preserva o status de pagamento já confirmado', async () => {
      prisma.entregadorLocalizacao.findFirst.mockResolvedValue(null);
      prisma.pedidoEncomenda.findMany.mockResolvedValue([
        { id: 101, dataPagamento: new Date(), comprovanteUrl: null },
      ]);

      await service.unmarkDeliveryComplete(10, 0);

      expect(prisma.pedidoEncomenda.update).toHaveBeenCalledWith({
        where: { id: 101 },
        data: { statusPagamento: 'confirmado', emEntrega: false },
      });
    });
  });
});

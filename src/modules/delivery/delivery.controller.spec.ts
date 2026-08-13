import { DeliveryController } from './delivery.controller';

/**
 * A auto-recuperação do rastreio só resolve o sintoma se os clientes com a tela
 * aberta forem avisados — senão o botão "Rastrear" só reaparece no próximo refresh.
 */
describe('DeliveryController — updateLocation', () => {
  const payload = {
    formId: 10,
    courierId: 1,
    latitude: -23.5,
    longitude: -46.6,
    userId: 'user-1',
  } as any;

  let deliveryService: any;
  let trackingGateway: any;
  let realtimeGateway: any;
  let controller: DeliveryController;
  let emit: jest.Mock;

  beforeEach(() => {
    emit = jest.fn();
    deliveryService = {
      updateLocation: jest
        .fn()
        .mockResolvedValue({ id: 1, reactivatedOrderIds: [] }),
    };
    trackingGateway = {
      server: { to: jest.fn().mockReturnValue({ emit }) },
      broadcastSharingStatus: jest.fn(),
      handleDynamicETA: jest.fn().mockResolvedValue(undefined),
    };
    realtimeGateway = { broadcast: jest.fn() };

    controller = new DeliveryController(
      deliveryService,
      trackingGateway,
      {} as any, // RoutesService — não usado aqui
      realtimeGateway,
    );
  });

  it('sempre transmite a posição para a sala de rastreio da rota', async () => {
    await controller.updateLocation(payload);

    expect(trackingGateway.server.to).toHaveBeenCalledWith('tracking_10');
    expect(emit).toHaveBeenCalledWith('locationUpdate', payload);
  });

  it('avisa os clientes quando o rastreio é reativado automaticamente', async () => {
    deliveryService.updateLocation.mockResolvedValue({
      id: 1,
      reactivatedOrderIds: [101, 102],
    });

    await controller.updateLocation(payload);

    expect(trackingGateway.broadcastSharingStatus).toHaveBeenCalledWith(
      10,
      true,
      {
        userId: 'user-1',
        courierId: 1,
      },
    );
    expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
      'pedidos_encomenda',
      'UPDATE',
      { id: 101, emEntrega: true },
    );
    expect(realtimeGateway.broadcast).toHaveBeenCalledWith(
      'pedidos_encomenda',
      'UPDATE',
      { id: 102, emEntrega: true },
    );
  });

  it('não emite evento de reativação num ping normal', async () => {
    await controller.updateLocation(payload);

    expect(trackingGateway.broadcastSharingStatus).not.toHaveBeenCalled();
    expect(realtimeGateway.broadcast).not.toHaveBeenCalled();
  });

  it('mantém o recálculo de ETA dinâmico', async () => {
    await controller.updateLocation(payload);

    expect(trackingGateway.handleDynamicETA).toHaveBeenCalledWith(10, 1);
  });
});

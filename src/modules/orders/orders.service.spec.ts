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
    usuario: { findUnique: jest.fn(), findMany: jest.fn() },
    produto: { findUnique: jest.fn() },
    comprovantePedido: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    // Forma em array: as operações já são as promessas dos mocks acima.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const mockStorage = {
    uploadFile: jest.fn(),
    getPublicUrl: jest.fn(),
    deleteFile: jest.fn(),
    extractPathFromUrl: jest.fn((url: string) => url.split('/').pop()),
  };
  const mockConfig = { get: jest.fn() };
  const mockNotifications = {
    createAndSendNotification: jest.fn(),
    broadcastNotification: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfiguracoesService, useValue: mockConfig },
        { provide: StorageService, useValue: mockStorage },
        { provide: NotificationsService, useValue: mockNotifications },
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
  /**
   * Reverter pagamento confirmado com comprovante. Antes o pedido sempre caía em
   * `aguardando_confirmacao`, que `update()` não aceita — com o formulário ainda
   * aberto, o cliente ficava sem poder editar (pedido 222, 2026-09-11).
   */
  describe('revertPayment', () => {
    const AMANHA = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ONTEM = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const pedidoConfirmado = (
      dataLimitePedido: Date,
      comprovanteUrl: string | null,
    ) => ({
      id: 222,
      usuarioId: 'cliente-1',
      codigo: 'TKDAK9',
      dataEncomendaId: 24,
      statusPagamento: 'confirmado',
      statusPagamentoAnterior: 'aguardando_confirmacao',
      comprovanteUrl,
      dataEncomenda: { dataLimitePedido },
    });

    const dadosGravados = () =>
      mockPrisma.pedidoEncomenda.update.mock.calls[0][0].data;

    beforeEach(() => {
      mockPrisma.pedidoEncomenda.update.mockResolvedValue({});
    });

    it('com o formulário aberto, volta para pendente e libera a edição', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(
        pedidoConfirmado(AMANHA, 'https://cdn/comprovante.png'),
      );

      await service.revertPayment(222, 'admin-1');

      expect(dadosGravados()).toEqual(
        expect.objectContaining({
          statusPagamento: 'pendente',
          statusPagamentoAnterior: 'confirmado',
          dataPagamento: null,
        }),
      );
    });

    it('não apaga o comprovante ao reverter', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(
        pedidoConfirmado(AMANHA, 'https://cdn/comprovante.png'),
      );

      await service.revertPayment(222, 'admin-1');

      expect(dadosGravados()).not.toHaveProperty('comprovanteUrl');
    });

    it('com o prazo encerrado, volta para análise, onde o admin reconfirma', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(
        pedidoConfirmado(ONTEM, 'https://cdn/comprovante.png'),
      );

      await service.revertPayment(222, 'admin-1');

      expect(dadosGravados().statusPagamento).toBe('aguardando_confirmacao');
    });

    it('sem comprovante, mantém a regra de voltar ao status anterior', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
        ...pedidoConfirmado(AMANHA, null),
        statusPagamentoAnterior: 'pendente',
      });

      await service.revertPayment(222, 'admin-1');

      expect(dadosGravados().statusPagamento).toBe('pendente');
    });

    it('recusa pedido inexistente', async () => {
      mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(null);

      await expect(service.revertPayment(999, 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  /**
   * Pagamento da diferença via PIX (docs/PAGAMENTO-DIFERENCA-PIX.md). Cenário
   * base: o pedido 222 tinha R$ 221,50 confirmados; o cliente editou para R$ 250.
   */
  describe('pagamento da diferença', () => {
    const AMANHA = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dadosDoUpdate = () =>
      mockPrisma.pedidoEncomenda.update.mock.calls[0][0].data;

    beforeEach(() => {
      mockPrisma.pedidoEncomenda.update.mockResolvedValue({ id: 222 });
      mockPrisma.comprovantePedido.findMany.mockResolvedValue([]);
      mockPrisma.comprovantePedido.findFirst.mockResolvedValue(null);
      mockPrisma.usuario.findMany.mockResolvedValue([]);
    });

    describe('revertPayment', () => {
      it('grava o total confirmado como valor pago e zera o reembolso', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          id: 222,
          usuarioId: 'cliente-1',
          statusPagamento: 'confirmado',
          comprovanteUrl: 'https://cdn/c1.png',
          totalValor: '221.50',
          reembolsoValor: null,
          reembolsadoEm: null,
          dataEncomenda: { dataLimitePedido: AMANHA },
        });

        await service.revertPayment(222, 'admin-1');

        expect(dadosDoUpdate()).toEqual(
          expect.objectContaining({
            statusPagamento: 'pendente',
            valorPago: 221.5,
            reembolsoValor: null,
          }),
        );
      });
    });

    describe('getPixQrCode', () => {
      beforeEach(() => {
        mockConfig.get.mockResolvedValue({
          chavePix: 'pix@exemplo.com',
          nomeRecebedor: 'Yatsunami',
          cidadeRecebedor: 'Curitiba',
        });
      });

      const pedidoPix = (valorPago: string | null) => ({
        id: 222,
        usuarioId: 'cliente-1',
        formaPagamento: 'pix',
        totalValor: '250.00',
        valorPago,
      });

      it('com pagamento anterior, o padrão é o QR da diferença', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(
          pedidoPix('221.50'),
        );

        const qr = await service.getPixQrCode(222, 'cliente-1');

        expect(qr.diferenca?.valor).toBe(28.5);
        expect(qr.total.valor).toBe(250);
        // Campo 54 do BR Code: valor cobrado, precedido do tamanho.
        expect(qr.diferenca?.payload).toContain('540528.50');
        expect(qr.total.payload).toContain('5406250.00');
        // Apps antigos só leem o topo: tem de ser o QR padrão.
        expect(qr.payload).toBe(qr.diferenca?.payload);
      });

      it('sem pagamento anterior, só há o QR do total', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(
          pedidoPix(null),
        );

        const qr = await service.getPixQrCode(222, 'cliente-1');

        expect(qr.diferenca).toBeNull();
        expect(qr.payload).toBe(qr.total.payload);
        expect(qr.valorPago).toBeNull();
      });

      it('recusa gerar QR quando o pagamento anterior já cobre o total', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue(
          pedidoPix('300.00'),
        );

        await expect(service.getPixQrCode(222, 'cliente-1')).rejects.toThrow(
          BadRequestException,
        );
      });
    });

    describe('updateReceipt', () => {
      const arquivo = {
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      } as Express.Multer.File;

      beforeEach(() => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          id: 222,
          usuarioId: 'cliente-1',
          dataEncomendaId: 24,
          statusPagamento: 'pendente',
          comprovanteUrl: 'https://cdn/c1.png',
          totalValor: '250.00',
          valorPago: '221.50',
          dataEncomenda: { dataLimitePedido: AMANHA },
        });
        mockStorage.getPublicUrl.mockReturnValue('https://cdn/c2.png');
      });

      it('registra o comprovante da diferença com o valor calculado no servidor', async () => {
        await service.updateReceipt(222, 'cliente-1', arquivo, undefined);

        expect(mockPrisma.comprovantePedido.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            valor: 28.5,
            tipo: 'diferenca',
            status: 'em_analise',
          }),
        });
      });

      it('não apaga o comprovante já pago', async () => {
        await service.updateReceipt(222, 'cliente-1', arquivo, 'total');

        expect(mockStorage.deleteFile).not.toHaveBeenCalled();
        expect(mockPrisma.comprovantePedido.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ valor: 250, tipo: 'total' }),
        });
      });

      it('substitui só o comprovante que ainda estava em análise', async () => {
        mockPrisma.comprovantePedido.findMany.mockResolvedValue([
          { id: 9, url: 'https://cdn/errado.png' },
        ]);

        await service.updateReceipt(222, 'cliente-1', arquivo, 'diferenca');

        expect(mockPrisma.comprovantePedido.deleteMany).toHaveBeenCalledWith({
          where: { id: { in: [9] } },
        });
        expect(mockStorage.deleteFile).toHaveBeenCalledWith('comprovantes', [
          'errado.png',
        ]);
      });

      it('recusa comprovante da diferença quando o pagamento já cobre o total', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          id: 222,
          usuarioId: 'cliente-1',
          totalValor: '200.00',
          valorPago: '221.50',
          dataEncomenda: { dataLimitePedido: AMANHA },
        });

        await expect(
          service.updateReceipt(222, 'cliente-1', arquivo, 'diferenca'),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('confirmPayment', () => {
      beforeEach(() => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          id: 222,
          usuarioId: 'cliente-1',
          statusPagamento: 'aguardando_confirmacao',
          totalValor: '250.00',
          valorPago: '221.50',
          dataEncomenda: { dataLimitePedido: AMANHA },
        });
      });

      it('pagou a diferença: confirma o comprovante e não gera reembolso', async () => {
        mockPrisma.comprovantePedido.findMany.mockResolvedValue([
          { valor: '28.50' },
        ]);

        await service.confirmPayment(222, 'admin-1');

        expect(mockPrisma.comprovantePedido.updateMany).toHaveBeenCalledWith({
          where: { pedidoEncomendaId: 222, status: 'em_analise' },
          data: { status: 'confirmado' },
        });
        expect(dadosDoUpdate()).not.toHaveProperty('reembolsoValor');
      });

      it('pagou o total de novo: o pagamento anterior vira reembolso', async () => {
        mockPrisma.comprovantePedido.findMany.mockResolvedValue([
          { valor: '250.00' },
        ]);

        await service.confirmPayment(222, 'admin-1');

        expect(dadosDoUpdate()).toEqual(
          expect.objectContaining({ reembolsoValor: 221.5 }),
        );
      });
    });

    describe('rejectPayment', () => {
      beforeEach(() => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          id: 222,
          statusPagamento: 'aguardando_confirmacao',
          comprovanteUrl: 'https://cdn/c2.png',
        });
        mockPrisma.pedidoEncomenda.update.mockResolvedValue({
          id: 222,
          usuarioId: 'cliente-1',
          dataEncomendaId: 24,
        });
      });

      it('apaga só o comprovante em análise e volta ao último confirmado', async () => {
        mockPrisma.comprovantePedido.findMany.mockResolvedValue([
          { id: 9, url: 'https://cdn/c2.png' },
        ]);
        mockPrisma.comprovantePedido.findFirst.mockResolvedValue({
          url: 'https://cdn/c1.png',
        });

        await service.rejectPayment(222, 'admin-1');

        expect(mockStorage.deleteFile).toHaveBeenCalledTimes(1);
        expect(mockStorage.deleteFile).toHaveBeenCalledWith('comprovantes', [
          'c2.png',
        ]);
        expect(dadosDoUpdate()).toEqual(
          expect.objectContaining({
            statusPagamento: 'pendente',
            comprovanteUrl: 'https://cdn/c1.png',
          }),
        );
      });

      /** Recusar um pedido "já coberto" o devolveria a pendente, cobrando de novo. */
      it('recusa quando não há comprovante em análise, só pagamento confirmado', async () => {
        mockPrisma.comprovantePedido.findFirst.mockResolvedValue({
          url: 'https://cdn/c1.png',
        });

        await expect(service.rejectPayment(222, 'admin-1')).rejects.toThrow(
          BadRequestException,
        );
        expect(mockStorage.deleteFile).not.toHaveBeenCalled();
      });
    });

    describe('marcarReembolsado', () => {
      it('grava quem marcou e quando', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          reembolsoValor: '21.50',
          reembolsadoEm: null,
        });

        await service.marcarReembolsado(222, 'admin-1');

        expect(dadosDoUpdate()).toEqual(
          expect.objectContaining({
            reembolsadoPor: 'admin-1',
            reembolsadoEm: expect.any(Date),
          }),
        );
      });

      it('recusa pedido sem reembolso pendente', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          reembolsoValor: null,
          reembolsadoEm: null,
        });

        await expect(service.marcarReembolsado(222, 'admin-1')).rejects.toThrow(
          BadRequestException,
        );
      });

      it('recusa marcar duas vezes', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          reembolsoValor: '21.50',
          reembolsadoEm: new Date(),
        });

        await expect(service.marcarReembolsado(222, 'admin-1')).rejects.toThrow(
          BadRequestException,
        );
      });
    });

    describe('edição que o pagamento anterior já cobre', () => {
      const mover = (id: number) =>
        service['moverParaAnaliseSeJaCoberto'](id, 'cliente-1');

      it('vai direto para análise e avisa os admins', async () => {
        mockPrisma.pedidoEncomenda.findUnique
          .mockResolvedValueOnce({
            totalValor: '200.00',
            valorPago: '221.50',
            statusPagamento: 'pendente',
          })
          .mockResolvedValueOnce({
            id: 222,
            codigo: 'TKDAK9',
            usuario: { nome: 'Cliente' },
          });
        mockPrisma.usuario.findUnique.mockResolvedValue({ nome: 'Cliente' });
        mockPrisma.usuario.findMany.mockResolvedValue([{ id: 'admin-1' }]);

        await mover(222);

        expect(dadosDoUpdate()).toEqual(
          expect.objectContaining({
            statusPagamento: 'aguardando_confirmacao',
          }),
        );
        expect(mockNotifications.broadcastNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            chave: 'notification.paymentCoveredAwaiting',
            usuarioIds: ['admin-1'],
          }),
        );
      });

      it('fica pendente quando ainda falta pagar', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          totalValor: '250.00',
          valorPago: '221.50',
          statusPagamento: 'pendente',
        });

        expect(await mover(222)).toBeNull();
        expect(mockPrisma.pedidoEncomenda.update).not.toHaveBeenCalled();
      });

      /** Ponto especial: sair da divisão da taxa mudaria o total dos vizinhos. */
      it('não mexe em pedido bloqueado de ponto especial', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          totalValor: '200.00',
          valorPago: '221.50',
          statusPagamento: 'bloqueado',
        });

        expect(await mover(222)).toBeNull();
      });

      it('pedido sem pagamento anterior segue como sempre', async () => {
        mockPrisma.pedidoEncomenda.findUnique.mockResolvedValue({
          totalValor: '0',
          valorPago: null,
          statusPagamento: 'pendente',
        });

        expect(await mover(222)).toBeNull();
      });
    });
  });
});

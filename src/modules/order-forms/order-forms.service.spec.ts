import { Test, TestingModule } from '@nestjs/testing';
import { OrderFormsService } from './order-forms.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BackgroundJobService } from '../../common/jobs/background-job.service';
import { CronLockService } from '../../common/cron/cron-lock.service';

/**
 * Ciclo de concluir e reabrir formulário de encomenda.
 *
 * 624 linhas sem teste, e o miolo desta operação vive em `$executeRawUnsafe` —
 * SQL cru, invisível para o TypeScript e para qualquer refatoração automática.
 *
 * A regra mais delicada está numa cláusula do `WHERE`: reabrir restaura o
 * status anterior **apenas** onde `confirmado_por LIKE 'auto_%'`, isto é,
 * apenas o que a própria conclusão confirmou em lote. **Pagamento que um
 * administrador confirmou à mão não é desfeito.** Sem teste, essa linha é fácil
 * de perder numa reescrita, e o prejuízo seria silencioso: pedidos já pagos
 * voltando a pendente.
 */

const formulario = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  dataEntrega: new Date('2026-09-01T00:00:00Z'),
  dataInicioPedido: null,
  dataLimitePedido: new Date('2026-08-30T00:00:00Z'),
  ativo: true,
  concluido: false,
  observacoes: null,
  enderecosEspeciais: null,
  notificarUsuarios: true,
  notificacaoEnviadaEm: null,
  criadoEm: new Date('2026-08-01T00:00:00Z'),
  produtosEncomenda: [],
  ...extra,
});

/** Junta as chamadas de SQL cru num texto só, para inspecionar as cláusulas. */
const sqlDe = (mock: jest.Mock) =>
  mock.mock.calls.map((c) => String(c[0])).join('\n');

describe('OrderFormsService — concluir e reabrir', () => {
  let service: OrderFormsService;
  let prisma: {
    dataEncomenda: { findUnique: jest.Mock; update: jest.Mock };
    pedidoEncomenda: { findMany: jest.Mock; updateMany: jest.Mock };
    venda: { deleteMany: jest.Mock };
    produtoEncomenda: { deleteMany: jest.Mock; createMany: jest.Mock };
    $executeRawUnsafe: jest.Mock;
  };
  let backgroundJobService: { fireAndForget: jest.Mock };

  beforeEach(async () => {
    prisma = {
      dataEncomenda: {
        findUnique: jest.fn().mockResolvedValue(formulario()),
        update: jest.fn().mockResolvedValue(formulario()),
      },
      pedidoEncomenda: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      venda: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      produtoEncomenda: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };
    backgroundJobService = { fireAndForget: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderFormsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SalesService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: BackgroundJobService, useValue: backgroundJobService },
        { provide: CronLockService, useValue: { enabled: () => false } },
      ],
    }).compile();

    service = module.get<OrderFormsService>(OrderFormsService);
  });

  describe('ao concluir', () => {
    it('também desativa o formulário', async () => {
      await service.update(7, { concluido: true });

      expect(prisma.dataEncomenda.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ concluido: true, ativo: false }),
        }),
      );
    });

    it('guarda o status anterior antes de confirmar em lote', async () => {
      await service.update(7, { concluido: true });

      const sql = sqlDe(prisma.$executeRawUnsafe);
      expect(sql).toContain('status_pagamento_anterior = status_pagamento');
      expect(sql).toContain("status_pagamento = 'confirmado'");
    });

    it('confirma só o que ainda não estava resolvido', async () => {
      await service.update(7, { concluido: true });

      const sql = sqlDe(prisma.$executeRawUnsafe);
      expect(sql).toContain('pendente');
      expect(sql).toContain('bloqueado');
      expect(sql).toContain('aguardando_confirmacao');
    });

    /**
     * A marca `auto_` é o que permite desfazer depois **só** o que foi feito
     * automaticamente. Se ela sumir, a reabertura passa a não restaurar nada.
     */
    it('marca quem confirmou com o prefixo automático', async () => {
      await service.update(7, { concluido: true }, 'admin-1');

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        'auto_admin-1',
        7,
      );
    });

    it('sem administrador identificado, marca como sistema', async () => {
      await service.update(7, { concluido: true });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        'auto_system',
        7,
      );
    });

    it('marca os não-cancelados como entregue e tira de rota', async () => {
      await service.update(7, { concluido: true });

      expect(prisma.pedidoEncomenda.updateMany).toHaveBeenCalledWith({
        where: {
          dataEncomendaId: 7,
          statusPagamento: { notIn: ['cancelado', 'entregue'] },
        },
        data: { statusPagamento: 'entregue', emEntrega: false },
      });
    });

    it('agenda a criação das vendas em segundo plano', async () => {
      await service.update(7, { concluido: true });

      expect(backgroundJobService.fireAndForget).toHaveBeenCalledWith(
        'form-close-sales-7',
        expect.any(Function),
      );
    });
  });

  describe('ao reabrir', () => {
    const comVendas = [
      { id: 1, vendaId: 100 },
      { id: 2, vendaId: 101 },
    ];

    it('solta o vínculo dos pedidos antes de apagar as vendas', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue(comVendas);

      await service.update(7, { concluido: false });

      expect(prisma.pedidoEncomenda.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] } },
        data: { vendaId: null },
      });
      expect(prisma.venda.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [100, 101] } },
      });
    });

    it('não apaga venda nenhuma quando não há vínculo', async () => {
      prisma.pedidoEncomenda.findMany.mockResolvedValue([]);

      await service.update(7, { concluido: false });

      expect(prisma.venda.deleteMany).not.toHaveBeenCalled();
    });

    /**
     * O caso que mais importa deste arquivo. Sem a cláusula do `LIKE`, reabrir
     * um formulário reverteria também os pagamentos que um administrador
     * confirmou à mão — pedidos pagos voltando a pendente, em silêncio.
     */
    it('não desfaz confirmação feita à mão por um administrador', async () => {
      await service.update(7, { concluido: false });

      const sql = sqlDe(prisma.$executeRawUnsafe);
      expect(sql).toContain("confirmado_por LIKE 'auto_%'");
      expect(sql).toContain('status_pagamento_anterior IS NOT NULL');
      expect(sql).toContain("status_pagamento = 'confirmado'");
    });

    it('limpa a marca de confirmação ao restaurar', async () => {
      await service.update(7, { concluido: false });

      const sql = sqlDe(prisma.$executeRawUnsafe);
      expect(sql).toContain('status_pagamento_anterior = NULL');
      expect(sql).toContain('data_pagamento = NULL');
      expect(sql).toContain('confirmado_por = NULL');
    });

    /**
     * Comportamento atual, travado aqui como observação, não como aprovação:
     * reabrir **não** reativa o formulário. Quem reabre para voltar a receber
     * pedidos precisa marcar `ativo` também — do contrário a criação de pedido
     * segue recusada com "esta data de encomenda não está mais ativa".
     */
    it('reabrir não reativa o formulário sozinho', async () => {
      await service.update(7, { concluido: false });

      const dados = prisma.dataEncomenda.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(dados.data).not.toHaveProperty('ativo');
    });
  });

  describe('fora do ciclo de conclusão', () => {
    it('uma edição comum não mexe em pedido nem em venda', async () => {
      await service.update(7, { observacoes: 'trocar o ponto de entrega' });

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(prisma.pedidoEncomenda.updateMany).not.toHaveBeenCalled();
      expect(prisma.venda.deleteMany).not.toHaveBeenCalled();
      expect(backgroundJobService.fireAndForget).not.toHaveBeenCalled();
    });

    it('trocar a seleção de produtos recria a lista inteira', async () => {
      await service.update(7, {
        selections: [{ product_id: 3, variedade_id: 9 }],
      });

      expect(prisma.produtoEncomenda.deleteMany).toHaveBeenCalledWith({
        where: { dataEncomendaId: 7 },
      });
      expect(prisma.produtoEncomenda.createMany).toHaveBeenCalledWith({
        data: [{ dataEncomendaId: 7, produtoId: 3, variedadeId: 9 }],
      });
    });

    it('seleção vazia apaga sem recriar', async () => {
      await service.update(7, { selections: [] });

      expect(prisma.produtoEncomenda.deleteMany).toHaveBeenCalled();
      expect(prisma.produtoEncomenda.createMany).not.toHaveBeenCalled();
    });
  });
});

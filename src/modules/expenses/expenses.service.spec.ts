import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QrParserService } from './qr-parser.service';
import { CreateExpenseDto } from './dto/create-expense.dto';

/**
 * Notas de despesa: filtro por período e marca de edição manual.
 *
 * 155 linhas sem teste. Dois pontos justificam o arquivo:
 *
 * 1. **o fim do dia é `23:59:59.999`.** Com `00:00:00`, um filtro
 *    `dateTo = hoje` perderia todas as notas de hoje — e o relatório fecharia
 *    com um dia a menos sem avisar ninguém;
 * 2. **`foiEditada` inverte o padrão entre criar e atualizar.** Nasce `false`
 *    na criação (veio do QR) e vira `true` na atualização (um humano mexeu),
 *    a menos que o corpo diga o contrário.
 */

type Tx = {
  notaDespesa: {
    create: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
  };
  itemDespesa: { createMany: jest.Mock; deleteMany: jest.Mock };
};

const item = (descricao: string) => ({
  descricao,
  quantidade: 1,
  valorUnitario: 10,
  valor: 10,
});

const nota = (extra: Partial<CreateExpenseDto> = {}) =>
  ({
    nomeEstabelecimento: 'MERCADO FICTICIO',
    valorTotal: 100,
    valorTotalSemDesconto: 100,
    ...extra,
  }) as CreateExpenseDto;

describe('ExpensesService', () => {
  let service: ExpensesService;
  let tx: Tx;
  let prisma: {
    $transaction: (fn: (t: Tx) => Promise<unknown>) => Promise<unknown>;
    notaDespesa: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
  };

  /** O `where` que chegou ao `findMany`. */
  const filtro = () =>
    (
      prisma.notaDespesa.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }
    ).where;

  /** Os dados gravados no `create`/`update` da nota. */
  const gravado = (m: jest.Mock) =>
    (m.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  beforeEach(async () => {
    tx = {
      notaDespesa: {
        create: jest.fn().mockResolvedValue({ id: 3 }),
        update: jest.fn().mockResolvedValue({ id: 3 }),
        findUnique: jest.fn().mockResolvedValue({ id: 3, itens: [] }),
      },
      itemDespesa: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma = {
      $transaction: (fn) => fn(tx),
      notaDespesa: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue({ id: 3 }),
        delete: jest.fn().mockResolvedValue({ id: 3 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: PrismaService, useValue: prisma },
        { provide: QrParserService, useValue: { parseQrCode: jest.fn() } },
      ],
    }).compile();

    service = module.get<ExpensesService>(ExpensesService);
  });

  describe('filtro por período', () => {
    /**
     * O caso que mais importa. `dateTo` é o dia inteiro, não o instante em que
     * ele começa: sem os `23:59:59.999`, uma nota das 14h do último dia do
     * intervalo ficaria de fora e o total do relatório sairia menor.
     */
    it('o dia final entra inteiro no intervalo', async () => {
      await service.findAll({ dateTo: '2026-08-21' });

      const dataCompra = filtro().dataCompra as { lte: Date };
      expect(dataCompra.lte.toISOString()).toBe('2026-08-21T23:59:59.999Z');
    });

    it('o dia inicial começa à meia-noite', async () => {
      await service.findAll({ dateFrom: '2026-08-01' });

      const dataCompra = filtro().dataCompra as { gte: Date };
      expect(dataCompra.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('com os dois, monta o intervalo fechado', async () => {
      await service.findAll({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });

      const dataCompra = filtro().dataCompra as { gte: Date; lte: Date };
      expect(dataCompra.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(dataCompra.lte.toISOString()).toBe('2026-08-31T23:59:59.999Z');
    });

    /** O app manda `yyyy-MM-dd`, mas um ISO completo não pode quebrar o corte. */
    it('ignora a hora quando o parâmetro vem com ela', async () => {
      await service.findAll({ dateFrom: '2026-08-01T15:30:00.000Z' });

      const dataCompra = filtro().dataCompra as { gte: Date };
      expect(dataCompra.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('sem datas, não filtra por período', async () => {
      await service.findAll({});

      expect(filtro()).not.toHaveProperty('dataCompra');
    });
  });

  describe('busca e paginação', () => {
    it('busca pelo estabelecimento sem diferenciar maiúsculas', async () => {
      await service.findAll({ search: 'mercado' });

      expect(filtro().OR).toEqual([
        { nomeEstabelecimento: { contains: 'mercado', mode: 'insensitive' } },
      ]);
    });

    it('usa vinte por página quando nada é pedido', async () => {
      await service.findAll({});

      const args = prisma.notaDespesa.findMany.mock.calls[0][0] as {
        take: number;
        skip: number;
      };
      expect(args.take).toBe(20);
      expect(args.skip).toBe(0);
    });

    /**
     * O total tem de usar **o mesmo** `where` da listagem. Contar sem filtro
     * faria a paginação prometer páginas que não existem.
     */
    it('conta com o mesmo filtro da listagem', async () => {
      await service.findAll({ search: 'mercado', dateFrom: '2026-08-01' });

      const doFindMany = filtro();
      const doCount = (
        prisma.notaDespesa.count.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(doCount).toEqual(doFindMany);
    });

    it('ordena da mais recente para a mais antiga, com desempate estável', async () => {
      await service.findAll({});

      const args = prisma.notaDespesa.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(args.orderBy).toEqual([{ dataCompra: 'desc' }, { id: 'desc' }]);
    });
  });

  describe('marca de edição manual', () => {
    it('nota criada nasce como não editada', async () => {
      await service.create(nota());

      expect(gravado(tx.notaDespesa.create).foiEditada).toBe(false);
    });

    /**
     * O segundo ponto sutil. Atualizar é, por si, sinal de que alguém mexeu na
     * nota lida do QR — então o padrão do `update` é o oposto do `create`.
     */
    it('nota atualizada passa a valer como editada', async () => {
      await service.update(3, nota());

      expect(gravado(tx.notaDespesa.update).foiEditada).toBe(true);
    });

    it('mas um `false` explícito é respeitado', async () => {
      await service.update(3, nota({ foiEditada: false }));

      expect(gravado(tx.notaDespesa.update).foiEditada).toBe(false);
    });
  });

  describe('itens', () => {
    it('grava os itens junto da nota nova', async () => {
      await service.create(nota({ itens: [item('ARROZ'), item('FEIJAO')] }));

      expect(tx.itemDespesa.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ notaId: 3, descricao: 'ARROZ' }),
          expect.objectContaining({ notaId: 3, descricao: 'FEIJAO' }),
        ],
      });
    });

    it('nota sem itens não chama a criação em lote', async () => {
      await service.create(nota());

      expect(tx.itemDespesa.createMany).not.toHaveBeenCalled();
    });

    it('atualizar com itens apaga os antigos antes de recriar', async () => {
      await service.update(3, nota({ itens: [item('ARROZ')] }));

      expect(tx.itemDespesa.deleteMany).toHaveBeenCalledWith({
        where: { notaId: 3 },
      });
      expect(tx.itemDespesa.createMany).toHaveBeenCalled();
    });

    /** Mesma família do defeito do `products`: ausência não pode virar exclusão. */
    it('atualizar sem mencionar itens não mexe neles', async () => {
      await service.update(3, nota());

      expect(tx.itemDespesa.deleteMany).not.toHaveBeenCalled();
      expect(tx.itemDespesa.createMany).not.toHaveBeenCalled();
    });

    it('lista vazia limpa os itens', async () => {
      await service.update(3, nota({ itens: [] }));

      expect(tx.itemDespesa.deleteMany).toHaveBeenCalled();
      expect(tx.itemDespesa.createMany).toHaveBeenCalledWith({ data: [] });
    });
  });

  describe('exclusão', () => {
    it('recusa nota inexistente antes de tentar apagar', async () => {
      prisma.notaDespesa.findUnique.mockResolvedValue(null);

      await expect(service.delete(3)).rejects.toThrow(NotFoundException);
      expect(prisma.notaDespesa.delete).not.toHaveBeenCalled();
    });

    it('apaga a nota existente', async () => {
      await service.delete(3);

      expect(prisma.notaDespesa.delete).toHaveBeenCalledWith({
        where: { id: 3 },
      });
    });
  });
});

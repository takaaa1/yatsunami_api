import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * Ordem das categorias.
 *
 * 76 linhas sem teste, e quase tudo é CRUD — mas duas coisas não são:
 *
 * 1. **criar sem `ordem` calcula o próximo**, lendo o máximo atual. Sem isso,
 *    toda categoria nova nasceria em zero e a lista embaralharia;
 * 2. **remover renumera todas para `1..N`.** Sem a renumeração sobrariam
 *    buracos, e o próximo `max + 1` continuaria crescendo — a ordem seguiria
 *    funcionando por acidente, até alguém depender do número.
 */

const NOME = { 'pt-BR': 'Marmitas', 'ja-JP': '弁当' };

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: {
    categoria: {
      aggregate: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const ordemGravada = () =>
    (prisma.categoria.create.mock.calls[0][0] as { data: { ordem: number } })
      .data.ordem;

  beforeEach(async () => {
    prisma = {
      categoria: {
        aggregate: jest.fn().mockResolvedValue({ _max: { ordem: 4 } }),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 1, ordem: 1 }),
        update: jest.fn().mockResolvedValue({ id: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 1 }),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  describe('criação', () => {
    it('sem ordem, vai para o fim da lista', async () => {
      await service.create({ nome: NOME } as CreateCategoryDto);

      expect(ordemGravada()).toBe(5);
    });

    it('na lista vazia, começa em um', async () => {
      prisma.categoria.aggregate.mockResolvedValue({ _max: { ordem: null } });

      await service.create({ nome: NOME } as CreateCategoryDto);

      expect(ordemGravada()).toBe(1);
    });

    it('com ordem informada, respeita a escolha', async () => {
      await service.create({ nome: NOME, ordem: 2 } as CreateCategoryDto);

      expect(ordemGravada()).toBe(2);
      expect(prisma.categoria.aggregate).not.toHaveBeenCalled();
    });

    /** Zero é ordem válida, e `??` existe para não confundi-lo com ausência. */
    it('ordem zero não é tratada como ausente', async () => {
      await service.create({ nome: NOME, ordem: 0 } as CreateCategoryDto);

      expect(ordemGravada()).toBe(0);
      expect(prisma.categoria.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('leitura', () => {
    it('lista na ordem definida', async () => {
      await service.findAll();

      expect(prisma.categoria.findMany).toHaveBeenCalledWith({
        orderBy: { ordem: 'asc' },
      });
    });

    it('categoria inexistente é erro, não nulo', async () => {
      prisma.categoria.findUnique.mockResolvedValue(null);

      await expect(service.findOne(9)).rejects.toThrow(NotFoundException);
    });
  });

  describe('atualização', () => {
    it('confere a existência antes de gravar', async () => {
      prisma.categoria.findUnique.mockResolvedValue(null);

      await expect(
        service.update(9, { nome: NOME } as UpdateCategoryDto),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.categoria.update).not.toHaveBeenCalled();
    });
  });

  describe('remoção', () => {
    it('recusa categoria inexistente antes de apagar', async () => {
      prisma.categoria.findUnique.mockResolvedValue(null);

      await expect(service.remove(9)).rejects.toThrow(NotFoundException);
      expect(prisma.categoria.delete).not.toHaveBeenCalled();
    });

    /**
     * O caso que importa. Depois de apagar a do meio, as restantes precisam
     * virar 1, 2, 3 — sem buraco. A renumeração usa a ordem atual, então o
     * resultado preserva a sequência que o administrador montou.
     */
    it('renumera as restantes de um a N, na ordem atual', async () => {
      prisma.categoria.findMany.mockResolvedValue([
        { id: 7 },
        { id: 3 },
        { id: 9 },
      ]);

      await service.remove(1);

      expect(prisma.categoria.findMany).toHaveBeenCalledWith({
        orderBy: { ordem: 'asc' },
        select: { id: true },
      });
      const renumeracoes = prisma.categoria.update.mock.calls.map(
        (c) => c[0] as { where: { id: number }; data: { ordem: number } },
      );
      expect(renumeracoes).toEqual([
        { where: { id: 7 }, data: { ordem: 1 } },
        { where: { id: 3 }, data: { ordem: 2 } },
        { where: { id: 9 }, data: { ordem: 3 } },
      ]);
    });

    /** Uma transação só: renumeração pela metade deixaria a lista inconsistente. */
    it('renumera tudo numa transação só', async () => {
      prisma.categoria.findMany.mockResolvedValue([{ id: 7 }, { id: 3 }]);

      await service.remove(1);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect((prisma.$transaction.mock.calls[0][0] as unknown[]).length).toBe(
        2,
      );
    });

    it('devolve o id apagado', async () => {
      await expect(service.remove(4)).resolves.toEqual({ deleted: 4 });
    });
  });
});

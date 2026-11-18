import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../config/storage.service';
import { UpdateProductDto } from './dto/update-product.dto';

/**
 * Ciclo de vida das imagens de produto e variedade.
 *
 * 186 linhas sem teste. O que se guarda aqui é **apagar arquivo do
 * armazenamento** — a única operação deste serviço que não tem volta. Errar
 * para mais destrói imagem em uso; errar para menos só deixa lixo.
 *
 * O caso `PATCH` parcial nasceu da auditoria e **falhava antes da correção**.
 */

const URL = (n: string) => `https://armazenamento.exemplo/produtos/${n}.jpg`;

const produtoComVariedades = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  nome: { 'pt-BR': 'BENTO' },
  imagem: URL('produto'),
  variedades: [
    { id: 10, nome: { 'pt-BR': 'P' }, imagem: URL('var-a') },
    { id: 11, nome: { 'pt-BR': 'G' }, imagem: URL('var-b') },
  ],
  ...extra,
});

const variedade = (nome: string, imagem: string) => ({
  // Os dois idiomas: `I18nStringDto` exige ambos, e o `tsc` cobra.
  nome: { 'pt-BR': nome, 'ja-JP': nome },
  preco: 10,
  quantidade: 1,
  ativo: true,
  imagem,
});

/**
 * Prisma falso com o que `update` usa: a transação roda o callback com o
 * próprio objeto, e as contagens de histórico respondem 0 por padrão.
 */
function prismaFalso(produto: unknown = produtoComVariedades()) {
  const falso = {
    produto: {
      findUnique: jest.fn().mockResolvedValue(produto),
      findUniqueOrThrow: jest.fn().mockResolvedValue(produto),
      update: jest.fn().mockResolvedValue({ id: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
    variedadeProduto: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    itemPedidoEncomenda: { count: jest.fn().mockResolvedValue(0) },
    itemPedidoDireto: { count: jest.fn().mockResolvedValue(0) },
    itemVenda: { count: jest.fn().mockResolvedValue(0) },
    produtoEncomenda: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };
  falso.$transaction.mockImplementation((fn: (tx: typeof falso) => unknown) =>
    fn(falso),
  );
  return falso;
}

describe('ProductsService — imagens', () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof prismaFalso>;
  let deleteFile: jest.Mock;

  /** Nomes de arquivo que foram apagados do armazenamento. */
  const apagados = () =>
    deleteFile.mock.calls.flatMap((c) => c[1] as string[]).sort();

  beforeEach(async () => {
    deleteFile = jest.fn().mockResolvedValue(undefined);
    prisma = prismaFalso();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            // Devolve o nome do arquivo, como o real faz ao extrair o caminho.
            extractPathFromUrl: (url: string) => url.split('/').pop() ?? null,
            deleteFile,
          },
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  const atualizar = (dto: Partial<UpdateProductDto>) =>
    service.update(1, dto as UpdateProductDto);

  describe('imagem do produto', () => {
    it('apaga a antiga quando chega uma nova', async () => {
      await atualizar({ imagem: URL('nova'), variedades: [] });

      expect(apagados()).toContain('produto.jpg');
    });

    /** Apagar aqui destruiria o arquivo que o próprio produto continua usando. */
    it('não apaga quando a imagem é a mesma', async () => {
      await atualizar({ imagem: URL('produto'), variedades: [] });

      expect(apagados()).not.toContain('produto.jpg');
    });

    it('não apaga quando a atualização não menciona imagem', async () => {
      await atualizar({ variedades: [] });

      expect(apagados()).not.toContain('produto.jpg');
    });
  });

  describe('imagens de variedade', () => {
    it('apaga só as que saíram da lista', async () => {
      await atualizar({
        variedades: [variedade('P', URL('var-a')), variedade('G', URL('nova'))],
      });

      expect(apagados()).toEqual(['var-b.jpg']);
    });

    it('não apaga nenhuma quando a lista continua igual', async () => {
      await atualizar({
        variedades: [
          variedade('P', URL('var-a')),
          variedade('G', URL('var-b')),
        ],
      });

      expect(apagados()).toEqual([]);
    });

    it('lista vazia apaga todas — a variedade deixou de existir', async () => {
      await atualizar({ variedades: [] });

      expect(apagados()).toEqual(['var-a.jpg', 'var-b.jpg']);
    });

    /**
     * Achado da auditoria — **falhava antes da correção**.
     *
     * O endpoint é `@Patch` e o DTO é `PartialType`: mandar só um campo é o uso
     * anunciado. Mas a limpeza comparava as imagens antigas contra uma lista
     * nova que, sem `variedades` no corpo, era vazia — e **apagava todas as
     * imagens de variedade do armazenamento**. As variedades em si não são
     * recriadas nesse caso (o `data.variedades` fica `undefined`), então o banco
     * seguia apontando para arquivos que não existem mais.
     *
     * Hoje o app sempre manda o produto inteiro, então estava latente. Mas
     * desativar um produto com `PATCH { ativo: false }` é a chamada mais óbvia
     * do mundo para quem escrever a próxima tela.
     */
    it('atualização parcial sem variedades não apaga imagem nenhuma', async () => {
      await atualizar({ ativo: false });

      expect(apagados()).toEqual([]);
    });

    it('variedade sem imagem não atrapalha a comparação', async () => {
      prisma.produto.findUnique.mockResolvedValue(
        produtoComVariedades({
          variedades: [
            { id: 10, nome: { 'pt-BR': 'P' }, imagem: null },
            { id: 11, nome: { 'pt-BR': 'G' }, imagem: URL('var-b') },
          ],
        }),
      );

      await atualizar({ variedades: [variedade('G', URL('var-b'))] });

      expect(apagados()).toEqual([]);
    });
  });

  describe('exclusão', () => {
    it('apaga a imagem do produto e as das variedades', async () => {
      await service.remove(1);

      expect(apagados()).toEqual(['produto.jpg', 'var-a.jpg', 'var-b.jpg']);
      expect(prisma.produto.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('produto sem imagem não tenta apagar arquivo', async () => {
      prisma.produto.findUnique.mockResolvedValue(
        produtoComVariedades({ imagem: null, variedades: [] }),
      );

      await service.remove(1);

      expect(deleteFile).not.toHaveBeenCalled();
      expect(prisma.produto.delete).toHaveBeenCalled();
    });
  });

  /**
   * A falha ao apagar arquivo é engolida de propósito: lixo no armazenamento é
   * problema menor que impedir o administrador de salvar o produto.
   */
  it('falha ao apagar arquivo não impede a atualização', async () => {
    deleteFile.mockRejectedValue(new Error('storage fora do ar'));

    await expect(
      atualizar({ imagem: URL('nova'), variedades: [] }),
    ).resolves.toBeTruthy();
    expect(prisma.produto.update).toHaveBeenCalled();
  });

  /**
   * Code review 2026-11: os arquivos eram apagados **antes** da mutação no
   * banco. Se o `update`/`delete` falhasse, o produto continuava apontando
   * para imagens que já não existiam.
   */
  describe('falha no banco não apaga arquivo', () => {
    it('update rejeitado mantém as imagens antigas', async () => {
      prisma.produto.update.mockRejectedValue(new Error('banco fora do ar'));

      await expect(
        atualizar({ imagem: URL('nova'), variedades: [] }),
      ).rejects.toThrow('banco fora do ar');
      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('delete rejeitado mantém as imagens', async () => {
      prisma.produto.delete.mockRejectedValue(new Error('FK'));

      await expect(service.remove(1)).rejects.toThrow('FK');
      expect(deleteFile).not.toHaveBeenCalled();
    });
  });

  /**
   * Code review 2026-11: imagem compartilhada entre o produto e uma variedade.
   * Trocar só a do produto apagava o arquivo que a variedade ainda usa.
   */
  describe('imagem ainda referenciada não é apagada', () => {
    beforeEach(() => {
      prisma.produto.findUnique.mockResolvedValue(
        produtoComVariedades({
          imagem: URL('comum'),
          variedades: [
            { id: 10, nome: { 'pt-BR': 'P' }, imagem: URL('comum') },
          ],
        }),
      );
    });

    it('troca da imagem do produto sem mexer nas variedades', async () => {
      await atualizar({ imagem: URL('nova') });

      expect(apagados()).toEqual([]);
    });

    it('variedade removida cuja imagem o produto continua usando', async () => {
      await atualizar({ variedades: [] });

      expect(apagados()).toEqual([]);
    });

    it('apaga quando ninguém mais usa', async () => {
      await atualizar({ imagem: URL('nova'), variedades: [] });

      expect(apagados()).toEqual(['comum.jpg']);
    });
  });
});

/**
 * Code review 2026-11: `PATCH` sem `preco` gravava `preco: null` e apagava o
 * preço. Omitido = manter; `null` explícito = limpar (é o que o formulário
 * manda quando o administrador esvazia o campo).
 */
describe('ProductsService.update — preço', () => {
  let service: ProductsService;
  let update: jest.Mock;

  beforeEach(async () => {
    const prisma = prismaFalso({
      id: 1,
      preco: 10,
      imagem: null,
      variedades: [],
    });
    update = prisma.produto.update;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();
    service = module.get<ProductsService>(ProductsService);
  });

  const dataGravada = () =>
    (update.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it('mantém o preço quando o PATCH não menciona preco', async () => {
    await service.update(1, { ativo: false } as UpdateProductDto);

    expect(dataGravada().preco).toBeUndefined();
  });

  it('limpa o preço quando vem null', async () => {
    await service.update(1, { preco: null } as unknown as UpdateProductDto);

    expect(dataGravada().preco).toBeNull();
  });

  it('grava o preço informado', async () => {
    await service.update(1, { preco: 12.5 } as UpdateProductDto);

    expect(dataGravada().preco).toBe(12.5);
  });
});

/**
 * Variedades na edição de produto (decisão D1 da verificação do review).
 *
 * O `deleteMany` + `create` antigo trocava o `id` de toda variedade a cada
 * edição; com as FKs `ON DELETE SET NULL`, pedidos, vendas e formulários
 * perdiam a variedade. Agora a variedade é atualizada no lugar, e a que sai da
 * lista é **desativada** se tiver histórico, ou excluída se não tiver.
 */
describe('ProductsService.update — variedades', () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof prismaFalso>;
  let deleteFile: jest.Mock;

  beforeEach(async () => {
    deleteFile = jest.fn().mockResolvedValue(undefined);
    prisma = prismaFalso();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            extractPathFromUrl: (url: string) => url.split('/').pop() ?? null,
            deleteFile,
          },
        },
      ],
    }).compile();
    service = module.get<ProductsService>(ProductsService);
  });

  const atualizar = (dto: Record<string, unknown>) =>
    service.update(1, dto as unknown as UpdateProductDto);
  const dadosDoProduto = () =>
    (
      prisma.produto.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;

  it('não recria as variedades: atualiza cada uma no lugar, pelo id', async () => {
    await atualizar({
      preco: 50,
      variedades: [
        { id: 10, ...variedade('P', URL('var-a')), preco: 11 },
        { id: 11, ...variedade('G', URL('var-b')), preco: 22 },
      ],
    });

    expect(dadosDoProduto().variedades).toBeUndefined();
    expect(prisma.variedadeProduto.delete).not.toHaveBeenCalled();
    expect(prisma.variedadeProduto.create).not.toHaveBeenCalled();
    expect(
      prisma.variedadeProduto.update.mock.calls.map(
        (c) => (c[0] as { where: { id: number } }).where.id,
      ),
    ).toEqual([10, 11]);
  });

  it('cria só a variedade nova, ligada ao produto', async () => {
    await atualizar({
      variedades: [
        { id: 10, ...variedade('P', URL('var-a')) },
        { id: 11, ...variedade('G', URL('var-b')) },
        variedade('Família', URL('var-c')),
      ],
    });

    expect(prisma.variedadeProduto.create).toHaveBeenCalledTimes(1);
    const criada = prisma.variedadeProduto.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(criada.data).toMatchObject({ produtoId: 1, imagem: URL('var-c') });
    expect(criada.data).not.toHaveProperty('id');
  });

  it('variedade removida com histórico é desativada, não excluída', async () => {
    prisma.itemVenda.count.mockImplementation(
      ({ where }: { where: { variedadeId: number } }) =>
        Promise.resolve(where.variedadeId === 10 ? 3 : 0),
    );

    await atualizar({
      variedades: [{ id: 11, ...variedade('G', URL('var-b')) }],
    });

    expect(prisma.variedadeProduto.delete).not.toHaveBeenCalled();
    expect(prisma.variedadeProduto.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { ativo: false },
    });
    // A desativada continua usando a imagem: o arquivo fica.
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('variedade removida sem histórico é excluída e a imagem sai', async () => {
    await atualizar({
      variedades: [{ id: 11, ...variedade('G', URL('var-b')) }],
    });

    expect(prisma.variedadeProduto.delete).toHaveBeenCalledWith({
      where: { id: 10 },
    });
    expect(deleteFile.mock.calls.flatMap((c) => c[1] as string[])).toEqual([
      'var-a.jpg',
    ]);
  });

  it('conta o histórico nas quatro tabelas que apontam para a variedade', async () => {
    await atualizar({ variedades: [] });

    for (const tabela of [
      prisma.itemPedidoEncomenda,
      prisma.itemPedidoDireto,
      prisma.itemVenda,
      prisma.produtoEncomenda,
    ]) {
      expect(tabela.count).toHaveBeenCalledWith({ where: { variedadeId: 10 } });
    }
  });

  it('tudo numa transação: falha no meio não apaga imagem', async () => {
    prisma.variedadeProduto.update.mockRejectedValue(new Error('falhou'));

    await expect(
      atualizar({
        imagem: URL('nova'),
        variedades: [{ id: 10, ...variedade('P', URL('var-a')) }],
      }),
    ).rejects.toThrow('falhou');
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

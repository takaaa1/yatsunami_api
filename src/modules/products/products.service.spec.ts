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

describe('ProductsService — imagens', () => {
  let service: ProductsService;
  let prisma: {
    produto: {
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let deleteFile: jest.Mock;

  /** Nomes de arquivo que foram apagados do armazenamento. */
  const apagados = () =>
    deleteFile.mock.calls.flatMap((c) => c[1] as string[]).sort();

  beforeEach(async () => {
    deleteFile = jest.fn().mockResolvedValue(undefined);
    prisma = {
      produto: {
        findUnique: jest.fn().mockResolvedValue(produtoComVariedades()),
        update: jest.fn().mockResolvedValue({ id: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };

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
});

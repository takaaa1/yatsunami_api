import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../../config/storage.service';
import {
  imageUploadFileName,
  uploadContentType,
} from '../../common/utils/image-upload.util';
import { randomUUID } from 'crypto';

import { Prisma } from '@prisma/client';
import { planejarVariedades } from './variedades-sync';
import type { CreateVariedadeDto } from './dto/variedade.dto';

/** Campos gravados de uma variedade (sem `id`: ele nunca vem do corpo para o banco). */
const dadosDaVariedade = (v: CreateVariedadeDto) => ({
  nome: v.nome as unknown as Prisma.InputJsonValue,
  preco: v.preco,
  ingredientes: v.ingredientes as unknown as Prisma.InputJsonValue,
  quantidade: v.quantidade,
  unidadeMedida: v.unidadeMedida,
  tipoProduto: v.tipoProduto,
  ativo: v.ativo,
  imagem: v.imagem,
});

/**
 * A variedade aparece em algum pedido, venda ou formulário? As quatro FKs são
 * `ON DELETE SET NULL`: excluir uma variedade com histórico apagaria a
 * variedade desses registros.
 */
async function temHistorico(
  tx: Prisma.TransactionClient,
  variedadeId: number,
): Promise<boolean> {
  const where = { where: { variedadeId } };
  const contagens = await Promise.all([
    tx.itemPedidoEncomenda.count(where),
    tx.itemPedidoDireto.count(where),
    tx.itemVenda.count(where),
    tx.produtoEncomenda.count(where),
  ]);
  return contagens.some((n) => n > 0);
}

const ehImagem = (img: string | null | undefined): img is string =>
  img != null && img !== '';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  async create(createProductDto: CreateProductDto) {
    const { variedades, ...productData } = createProductDto;

    const data: Prisma.ProdutoCreateInput = {
      nome: productData.nome as unknown as Prisma.InputJsonValue,
      preco: productData.preco ?? null,
      ingredientes:
        productData.ingredientes as unknown as Prisma.InputJsonValue,
      quantidade: productData.quantidade,
      unidadeMedida: productData.unidadeMedida,
      tipoProduto: productData.tipoProduto,
      categoria: productData.categoria as unknown as Prisma.InputJsonValue,
      observacoes: productData.observacoes as unknown as Prisma.InputJsonValue,
      imagem: productData.imagem,
      abreviacao: productData.abreviacao,
      ativo: productData.ativo,
      variedades: variedades
        ? {
            create: variedades.map((v) => ({
              nome: v.nome as unknown as Prisma.InputJsonValue,
              preco: v.preco,
              ingredientes: v.ingredientes as unknown as Prisma.InputJsonValue,
              quantidade: v.quantidade,
              unidadeMedida: v.unidadeMedida,
              tipoProduto: v.tipoProduto,
              ativo: v.ativo,
              imagem: v.imagem,
            })),
          }
        : undefined,
    };

    return this.prisma.produto.create({
      data,
      include: {
        variedades: true,
      },
    });
  }

  private async deleteOldImage(imageUrl: string | null | undefined) {
    if (!imageUrl) return;

    try {
      const filePath = this.storageService.extractPathFromUrl(
        imageUrl,
        'produtos',
      );
      if (filePath) {
        await this.storageService.deleteFile('produtos', [filePath]);
      }
    } catch (error) {
      console.warn(
        `Failed to delete old product image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async findAll() {
    return this.prisma.produto.findMany({
      include: {
        variedades: true,
      },
      orderBy: [{ ativo: 'desc' }, { id: 'asc' }],
    });
  }

  async findOne(id: number) {
    const product = await this.prisma.produto.findUnique({
      where: { id },
      include: {
        variedades: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    return product;
  }

  async update(id: number, updateProductDto: UpdateProductDto) {
    const product = await this.findOne(id);
    const { variedades, ...productData } = updateProductDto;

    const data: Prisma.ProdutoUpdateInput = {
      nome: productData.nome as unknown as Prisma.InputJsonValue,
      // Omitido (`undefined`) mantém o preço; `null` explícito limpa.
      // `?? null` aqui transformava todo PATCH parcial em "apagar preço".
      preco: productData.preco,
      ingredientes:
        productData.ingredientes as unknown as Prisma.InputJsonValue,
      quantidade: productData.quantidade,
      unidadeMedida: productData.unidadeMedida,
      tipoProduto: productData.tipoProduto,
      categoria: productData.categoria as unknown as Prisma.InputJsonValue,
      observacoes: productData.observacoes as unknown as Prisma.InputJsonValue,
      imagem: productData.imagem,
      abreviacao: productData.abreviacao,
      ativo: productData.ativo,
    };

    // O banco primeiro, numa transação só: se algo falhar, nenhum arquivo foi
    // apagado e o produto continua apontando para imagens que existem.
    //
    // Variedades são atualizadas **no lugar** (mesmo `id`). O antigo
    // `deleteMany` + `create` trocava o `id` de todas a cada edição, e as FKs
    // `ON DELETE SET NULL` de itens de pedido, itens de venda e seleções de
    // formulário perdiam a variedade — todo o histórico, a cada edição.
    const imagensDesativadas: (string | null)[] = [];
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.produto.update({ where: { id }, data });

      if (variedades) {
        const plano = planejarVariedades(product.variedades, variedades);
        for (const { id: variedadeId, dados } of plano.atualizar) {
          await tx.variedadeProduto.update({
            where: { id: variedadeId },
            data: dadosDaVariedade(dados),
          });
        }
        for (const dados of plano.criar) {
          await tx.variedadeProduto.create({
            data: { ...dadosDaVariedade(dados), produtoId: id },
          });
        }
        for (const variedadeId of plano.remover) {
          if (await temHistorico(tx, variedadeId)) {
            // Excluir apagaria a variedade dos pedidos e vendas antigos.
            await tx.variedadeProduto.update({
              where: { id: variedadeId },
              data: { ativo: false },
            });
            imagensDesativadas.push(
              product.variedades.find((v) => v.id === variedadeId)?.imagem ??
                null,
            );
          } else {
            await tx.variedadeProduto.delete({ where: { id: variedadeId } });
          }
        }
      }

      return tx.produto.findUniqueOrThrow({
        where: { id },
        include: { variedades: true },
      });
    });

    // Limpeza: apaga só o que o produto **resultante** não usa mais.
    //
    // - Campo omitido mantém o valor antigo. O endpoint é `@Patch` com
    //   `PartialType`: um `PATCH { ativo: false }` não recria variedades, e
    //   antes a lista ausente contava como vazia e apagava todas as imagens
    //   de variedade enquanto o banco seguia apontando para elas.
    // - Uma imagem compartilhada entre produto e variedade só sai quando
    //   nenhum dos dois a referencia mais.
    const imagemFinal =
      productData.imagem !== undefined ? productData.imagem : product.imagem;
    // Desativadas continuam no banco e com a imagem: o arquivo fica.
    const imagensVariedadesFinais: (string | null | undefined)[] = variedades
      ? [
          ...variedades.map(
            (v): string | null | undefined =>
              v.imagem as string | null | undefined,
          ),
          ...imagensDesativadas,
        ]
      : product.variedades.map((v) => v.imagem);
    const emUso = new Set(
      [imagemFinal, ...imagensVariedadesFinais].filter(ehImagem),
    );
    const antigas = new Set(
      [product.imagem, ...product.variedades.map((v) => v.imagem)].filter(
        ehImagem,
      ),
    );
    for (const img of antigas) {
      if (!emUso.has(img)) {
        await this.deleteOldImage(img);
      }
    }

    return updated;
  }

  async remove(id: number) {
    const product = await this.findOne(id);

    const deleted = await this.prisma.produto.delete({
      where: { id },
    });

    // Só depois do banco: se o delete falhar, as imagens continuam lá.
    const imagens = new Set(
      [
        product.imagem,
        ...(product.variedades ?? []).map((v) => v.imagem),
      ].filter(ehImagem),
    );
    for (const img of imagens) {
      await this.deleteOldImage(img);
    }

    return deleted;
  }

  async uploadImage(file: Express.Multer.File): Promise<string> {
    const contentType = uploadContentType(file);
    const fileName = imageUploadFileName(randomUUID(), contentType);

    await this.storageService.uploadFile(
      'produtos',
      fileName,
      file.buffer,
      contentType,
    );

    return this.storageService.getPublicUrl('produtos', fileName);
  }
}

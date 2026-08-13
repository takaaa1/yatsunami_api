import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../../config/storage.service';
import { imageUploadFileName, uploadContentType } from '../../common/utils/image-upload.util';
import { randomUUID } from 'crypto';

import { Prisma } from '@prisma/client';

@Injectable()
export class ProductsService {
    constructor(
        private prisma: PrismaService,
        private storageService: StorageService,
    ) { }

    async create(createProductDto: CreateProductDto) {
        const { variedades, ...productData } = createProductDto;

        const data: Prisma.ProdutoCreateInput = {
            nome: productData.nome as unknown as Prisma.InputJsonValue,
            preco: productData.preco ?? null,
            ingredientes: productData.ingredientes as unknown as Prisma.InputJsonValue,
            quantidade: productData.quantidade,
            unidadeMedida: productData.unidadeMedida,
            tipoProduto: productData.tipoProduto,
            categoria: productData.categoria as unknown as Prisma.InputJsonValue,
            observacoes: productData.observacoes as unknown as Prisma.InputJsonValue,
            imagem: productData.imagem,
            abreviacao: productData.abreviacao,
            ativo: productData.ativo,
            variedades: variedades ? {
                create: variedades.map(v => ({
                    nome: v.nome as unknown as Prisma.InputJsonValue,
                    preco: v.preco,
                    ingredientes: v.ingredientes as unknown as Prisma.InputJsonValue,
                    quantidade: v.quantidade,
                    unidadeMedida: v.unidadeMedida,
                    tipoProduto: v.tipoProduto,
                    ativo: v.ativo,
                    imagem: v.imagem
                }))
            } : undefined
        };

        return this.prisma.produto.create({
            data,
            include: {
                variedades: true
            }
        });
    }

    private async deleteOldImage(imageUrl: string | null | undefined) {
        if (!imageUrl) return;

        try {
            const filePath = this.storageService.extractPathFromUrl(imageUrl, 'produtos');
            if (filePath) {
                await this.storageService.deleteFile('produtos', [filePath]);
            }
        } catch (error) {
            console.warn(`Failed to delete old product image: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async findAll() {
        return this.prisma.produto.findMany({
            include: {
                variedades: true
            },
            orderBy: [{ ativo: 'desc' }, { id: 'asc' }],
        });
    }

    async findOne(id: number) {
        const product = await this.prisma.produto.findUnique({
            where: { id },
            include: {
                variedades: true
            }
        });

        if (!product) {
            throw new NotFoundException(`Product with ID ${id} not found`);
        }

        return product;
    }

    async update(id: number, updateProductDto: UpdateProductDto) {
        const product = await this.findOne(id);
        const { variedades, ...productData } = updateProductDto;

        // If updating image, delete old one
        if (updateProductDto.imagem && product.imagem && updateProductDto.imagem !== product.imagem) {
            await this.deleteOldImage(product.imagem);
        }

        const data: Prisma.ProdutoUpdateInput = {
            nome: productData.nome as unknown as Prisma.InputJsonValue,
            preco: productData.preco ?? null,
            ingredientes: productData.ingredientes as unknown as Prisma.InputJsonValue,
            quantidade: productData.quantidade,
            unidadeMedida: productData.unidadeMedida,
            tipoProduto: productData.tipoProduto,
            categoria: productData.categoria as unknown as Prisma.InputJsonValue,
            observacoes: productData.observacoes as unknown as Prisma.InputJsonValue,
            imagem: productData.imagem,
            abreviacao: productData.abreviacao,
            ativo: productData.ativo,
            variedades: variedades ? {
                deleteMany: {}, // Simpler to recreate
                create: variedades.map(v => ({
                    nome: v.nome as unknown as Prisma.InputJsonValue,
                    preco: v.preco,
                    ingredientes: v.ingredientes as unknown as Prisma.InputJsonValue,
                    quantidade: v.quantidade,
                    unidadeMedida: v.unidadeMedida,
                    tipoProduto: v.tipoProduto,
                    ativo: v.ativo,
                    imagem: v.imagem
                }))
            } : undefined
        };

        // Handle variety image cleanup
        const oldVarietyImages = product.variedades
            .map(v => v.imagem)
            .filter((img): img is string => img != null && img !== '');

        const newVarietyImages = variedades
            ? variedades
                  .map(v => v.imagem)
                  .filter((img): img is string => img != null && img !== '')
            : [];

        // Delete images that are no longer in the new varieties list
        for (const oldImg of oldVarietyImages) {
            if (!newVarietyImages.includes(oldImg)) {
                await this.deleteOldImage(oldImg);
            }
        }

        return this.prisma.produto.update({
            where: { id },
            data,
            include: {
                variedades: true
            }
        });
    }

    async remove(id: number) {
        const product = await this.findOne(id);

        // Delete image from storage
        // Delete image from storage
        if (product.imagem) {
            await this.deleteOldImage(product.imagem);
        }

        // Delete variety images from storage
        if (product.variedades) {
            for (const variety of product.variedades) {
                if (variety.imagem) {
                    await this.deleteOldImage(variety.imagem);
                }
            }
        }

        return this.prisma.produto.delete({
            where: { id },
        });
    }

    async uploadImage(file: Express.Multer.File): Promise<string> {
        const contentType = uploadContentType(file);
        const fileName = imageUploadFileName(randomUUID(), contentType);

        await this.storageService.uploadFile('produtos', fileName, file.buffer, contentType);

        return this.storageService.getPublicUrl('produtos', fileName);
    }
}

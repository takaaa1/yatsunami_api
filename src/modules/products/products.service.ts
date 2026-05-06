import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../../config/storage.service';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

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
            nome: productData.nome as any,
            preco: (productData.preco ?? null) as any,
            ingredientes: productData.ingredientes as any,
            quantidade: productData.quantidade,
            categoria: productData.categoria as any,
            observacoes: productData.observacoes as any,
            imagem: productData.imagem,
            abreviacao: productData.abreviacao,
            ativo: productData.ativo,
            variedades: variedades ? {
                create: variedades.map(v => ({
                    nome: v.nome as any,
                    preco: v.preco,
                    ingredientes: v.ingredientes as any,
                    quantidade: v.quantidade,
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
            console.warn(`Failed to delete old product image: ${error.message}`);
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
            nome: productData.nome as any,
            preco: (productData.preco ?? null) as any,
            ingredientes: productData.ingredientes as any,
            quantidade: productData.quantidade,
            categoria: productData.categoria as any,
            observacoes: productData.observacoes as any,
            imagem: productData.imagem,
            abreviacao: productData.abreviacao,
            ativo: productData.ativo,
            variedades: variedades ? {
                deleteMany: {}, // Simpler to recreate
                create: variedades.map(v => ({
                    nome: v.nome as any,
                    preco: v.preco,
                    ingredientes: v.ingredientes as any,
                    quantidade: v.quantidade,
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
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${randomUUID()}.${fileExt}`;

        await this.storageService.uploadFile('produtos', fileName, file.buffer, file.mimetype);

        return this.storageService.getPublicUrl('produtos', fileName);
    }

    private runCommand(command: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: 'pipe' });
            let stderr = '';

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                reject(error);
            });

            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(stderr || `Comando "${command}" terminou com código ${code}`));
            });
        });
    }

    private async runRembg(inputPath: string, outputPath: string): Promise<void> {
        const rembgBinFromEnv = process.env.REMBG_BIN?.trim();
        const cwdVenvRembg = path.resolve(process.cwd(), '.venv', 'bin', 'rembg');

        const attempts: Array<{ command: string; args: string[] }> = [];
        const tryDirectRembg = (cmd: string | undefined) => {
            if (!cmd) return;
            attempts.push({ command: cmd, args: ['i', inputPath, outputPath] });
        };

        // Prioridade: binário explícito/venv local -> PATH -> python module fallback.
        tryDirectRembg(rembgBinFromEnv);
        tryDirectRembg(cwdVenvRembg);
        tryDirectRembg('rembg');
        attempts.push({ command: 'python', args: ['-m', 'rembg', 'i', inputPath, outputPath] });
        attempts.push({ command: 'python3', args: ['-m', 'rembg', 'i', inputPath, outputPath] });

        const failures: string[] = [];
        for (const attempt of attempts) {
            try {
                await this.runCommand(attempt.command, attempt.args);
                return;
            } catch (error) {
                const message = (error as Error)?.message || String(error);
                failures.push(`${attempt.command} ${attempt.args.join(' ')} => ${message}`);

                // Se REMBG_BIN foi explicitamente definido, não mascarar o erro com fallbacks.
                if (rembgBinFromEnv && attempt.command === rembgBinFromEnv) {
                    throw new Error(
                        `Falha ao executar REMBG_BIN (${rembgBinFromEnv}). Detalhe: ${message}`,
                    );
                }
            }
        }

        throw new Error(
            `Falha ao executar rembg. Tentativas: ${failures.join(' | ')}`,
        );
    }

    async generateBackgroundRemovedPreview(file: Express.Multer.File): Promise<string> {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yatsunami-rembg-'));
        const inputPath = path.join(tmpDir, `input-${randomUUID()}.png`);
        const outputPath = path.join(tmpDir, `output-${randomUUID()}.png`);
        const outputStoragePath = `previews/${randomUUID()}.png`;

        try {
            await fs.writeFile(inputPath, file.buffer);
            await this.runRembg(inputPath, outputPath);

            const outputBuffer = await fs.readFile(outputPath);
            await this.storageService.uploadFile('produtos', outputStoragePath, outputBuffer, 'image/png');

            return this.storageService.getPublicUrl('produtos', outputStoragePath);
        } finally {
            await Promise.allSettled([
                fs.unlink(inputPath),
                fs.unlink(outputPath),
            ]);
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    }
}

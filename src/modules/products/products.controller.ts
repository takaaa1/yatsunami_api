import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { FileInterceptor } from '@nestjs/platform-express';

@ApiTags('products')
@Controller('products')
export class ProductsController {
    constructor(private readonly productsService: ProductsService) { }

    @Post()
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Create a new product' })
    create(@Body() createProductDto: CreateProductDto) {
        return this.productsService.create(createProductDto);
    }

    @Get()
    @ApiOperation({ summary: 'List all products' })
    findAll() {
        return this.productsService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a product by ID' })
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.productsService.findOne(id);
    }

    @Patch(':id')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Update a product' })
    update(@Param('id', ParseIntPipe) id: number, @Body() updateProductDto: UpdateProductDto) {
        return this.productsService.update(id, updateProductDto);
    }

    @Delete(':id')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Delete a product' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.productsService.remove(id);
    }

    @Post('upload')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @UseInterceptors(FileInterceptor('file'))
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
        },
    })
    @ApiOperation({ summary: 'Upload a product image' })
    async uploadImage(@UploadedFile() file: Express.Multer.File) {
        if (!file?.buffer) {
            throw new BadRequestException('Arquivo ausente ou corpo multipart inválido (campo "file").');
        }
        const url = await this.productsService.uploadImage(file);
        return { url };
    }

    @Post('remove-bg-preview')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @UseInterceptors(FileInterceptor('file'))
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
        },
    })
    @ApiOperation({ summary: 'Generate product image preview without background (rembg)' })
    async removeBackgroundPreview(@UploadedFile() file: Express.Multer.File) {
        if (!file?.buffer) {
            throw new BadRequestException('Arquivo ausente ou corpo multipart inválido (campo "file").');
        }
        const url = await this.productsService.generateBackgroundRemovedPreview(file);
        return { url };
    }
}

import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, Res } from '@nestjs/common';
import { Response } from 'express';
import { OrderFormsService } from './order-forms.service';
import { CreateOrderFormDto, UpdateOrderFormDto } from './dto';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { PdfService } from '../pdf/pdf.service';

@ApiTags('order-forms')
@ApiTags('order-forms')
@Controller('order-forms')
export class OrderFormsController {
    constructor(
        private readonly orderFormsService: OrderFormsService,
        private readonly pdfService: PdfService,
    ) { }

    @Post()
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Create a new order form (Admin)' })
    create(@Body() createDto: CreateOrderFormDto) {
        return this.orderFormsService.create(createDto);
    }

    @Get()
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @ApiOperation({ summary: 'List all order forms' })
    findAll() {
        return this.orderFormsService.findAll();
    }

    @Get('available')
    @ApiOperation({ summary: 'List available order forms for clients' })
    findAvailable() {
        return this.orderFormsService.findAvailable();
    }

    @Get('latest')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @ApiOperation({ summary: 'Get the latest order form' })
    async findLatest() {
        return this.orderFormsService.findLatest();
    }

    @Get(':id/products')
    @ApiOperation({ summary: 'List products for a specific order form' })
    findProducts(@Param('id', ParseIntPipe) id: number) {
        return this.orderFormsService.findProducts(id);
    }

    @Get(':id')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @ApiOperation({ summary: 'Get an order form by ID' })
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.orderFormsService.findOne(id);
    }

    @Patch(':id')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Update an order form (Admin)' })
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateDto: UpdateOrderFormDto,
        @CurrentUser('id') adminUserId: string
    ) {
        return this.orderFormsService.update(id, updateDto, adminUserId);
    }

    @Delete(':id')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Delete an order form (Admin)' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.orderFormsService.remove(id);
    }

    @Get(':id/pdf-summary')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Gerar resumo PDF consolidado de pedidos' })
    @ApiResponse({ status: 200, description: 'Resumo PDF gerado com sucesso' })
    async getSummaryPdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
        const data = await this.orderFormsService.getSummaryData(id);
        const buffer = await this.pdfService.generateOrderSummary(data);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename=resumo_pedidos_${id}.pdf`,
            'Content-Length': buffer.length,
        });

        res.end(buffer);
    }

    @Post(':id/send-notification')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Enviar notificação sobre este formulário para usuários e admins ativos (inbox + push)' })
    sendNotification(@Param('id', ParseIntPipe) id: number) {
        return this.orderFormsService.sendFormNotification(id);
    }
}

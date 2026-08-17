import { Controller, Get, Post, Body, Param, UseGuards, ParseIntPipe, Delete, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { PdfService } from '../pdf/pdf.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { broadcastAfter, type BroadcastEventType } from '../../common/realtime/broadcast-after';

@ApiTags('Sales')
@Controller('sales')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@ApiBearerAuth('JWT')
export class SalesController {
    constructor(
        private readonly salesService: SalesService,
        private readonly pdfService: PdfService,
        private readonly realtimeGateway: RealtimeGateway,
    ) { }

    /** Venda entra na lista do admin e no faturamento do dashboard. */
    private comBroadcast<T extends { id: number }>(
        eventType: BroadcastEventType,
        operacao: Promise<T>,
    ): Promise<T> {
        return broadcastAfter(this.realtimeGateway, 'vendas', eventType, operacao, (v) => ({
            id: v.id,
        }));
    }

    @Post()
    @Roles('admin')
    @ApiOperation({ summary: 'Registrar uma nova venda (PDV)' })
    @ApiResponse({ status: 201, description: 'Venda registrada com sucesso' })
    create(@CurrentUser('id') creatorId: string, @Body() createSaleDto: CreateSaleDto) {
        return this.comBroadcast('INSERT', this.salesService.create(creatorId, createSaleDto));
    }

    @Get()
    @Roles('admin')
    @ApiOperation({ summary: 'Listar histórico de vendas' })
    @ApiResponse({ status: 200, description: 'Lista de vendas retornada' })
    findAll(
        @Query('limit') limit?: number,
        @Query('offset') offset?: number,
        @Query('search') search?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        return this.salesService.findAll({ limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, search, dateFrom, dateTo });
    }

    @Get(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Obter detalhes de uma venda' })
    @ApiResponse({ status: 200, description: 'Detalhes da venda retornados' })
    @ApiResponse({ status: 404, description: 'Venda não encontrada' })
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.salesService.findOne(id);
    }

    @Get(':id/pdf')
    @Roles('admin')
    @ApiOperation({ summary: 'Gerar recibo PDF de uma venda' })
    @ApiResponse({ status: 200, description: 'Recibo PDF gerado com sucesso' })
    @ApiResponse({ status: 404, description: 'Venda não encontrada' })
    async getPdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
        const sale = await this.salesService.findOne(id);
        const buffer = await this.pdfService.generateSaleReceipt(sale);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename=recibo_venda_${id}.pdf`,
            'Content-Length': buffer.length,
        });

        res.end(buffer);
    }

    @Delete(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Excluir um registro de venda' })
    @ApiResponse({ status: 200, description: 'Venda excluída com sucesso' })
    @ApiResponse({ status: 404, description: 'Venda não encontrada' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.comBroadcast('DELETE', this.salesService.delete(id));
    }
}

import { Controller, Get, Post, Patch, Body, Param, UseGuards, ParseIntPipe, Delete, Query } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto, ParseQrDto } from './dto';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { broadcastAfter, type BroadcastEventType } from '../../common/realtime/broadcast-after';

@ApiTags('Expenses')
@Controller('expenses')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@ApiBearerAuth('JWT')
export class ExpensesController {
    constructor(
        private readonly expensesService: ExpensesService,
        private readonly realtimeGateway: RealtimeGateway,
    ) { }

    /**
     * Despesa entra na lista do admin e no lucro do dashboard.
     *
     * O retorno do serviço é anulável — `create` e `update` incluem os itens
     * via `findUnique`, que pode não achar. Sem registro não há o que avisar,
     * então a emissão é pulada em vez de sair um evento sem `id`.
     */
    private comBroadcast<T extends { id: number } | null>(
        eventType: BroadcastEventType,
        operacao: Promise<T>,
    ): Promise<T> {
        return broadcastAfter(this.realtimeGateway, 'notas_fiscais', eventType, operacao, (n) =>
            n ? { id: n.id } : null,
        );
    }

    @Post('parse-qr')
    @Roles('admin')
    @ApiOperation({ summary: 'Parsear uma URL de QR Code de nota fiscal' })
    @ApiResponse({ status: 200, description: 'Dados da nota extraídos com sucesso' })
    parseQr(@Body() parseQrDto: ParseQrDto) {
        return this.expensesService.parseQrCode(parseQrDto.url);
    }

    @Post()
    @Roles('admin')
    @ApiOperation({ summary: 'Registrar uma nova despesa' })
    @ApiResponse({ status: 201, description: 'Despesa registrada com sucesso' })
    create(@Body() createExpenseDto: CreateExpenseDto) {
        return this.comBroadcast('INSERT', this.expensesService.create(createExpenseDto));
    }

    @Get()
    @Roles('admin')
    @ApiOperation({ summary: 'Listar histórico de despesas' })
    @ApiResponse({ status: 200, description: 'Lista de despesas retornada' })
    findAll(
        @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
        @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
        @Query('search') search?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        return this.expensesService.findAll({
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
            search,
            dateFrom,
            dateTo,
        });
    }

    @Get(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Obter detalhes de uma despesa' })
    @ApiResponse({ status: 200, description: 'Detalhes da despesa retornados' })
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.expensesService.findOne(id);
    }

    @Patch(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Atualizar uma despesa registrada' })
    @ApiResponse({ status: 200, description: 'Despesa atualizada com sucesso' })
    update(@Param('id', ParseIntPipe) id: number, @Body() updateExpenseDto: CreateExpenseDto) {
        return this.comBroadcast('UPDATE', this.expensesService.update(id, updateExpenseDto));
    }

    @Delete(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Excluir um registro de despesa' })
    @ApiResponse({ status: 200, description: 'Despesa excluída com sucesso' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.comBroadcast('DELETE', this.expensesService.delete(id));
    }
}

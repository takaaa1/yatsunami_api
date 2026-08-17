import { Controller, Get, Post, Patch, Body, Param, UseGuards, ParseIntPipe, Delete, Query, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderDto } from './dto';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@ApiTags('Orders')
@Controller('orders')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth('JWT')
export class OrdersController {
    constructor(
        private readonly ordersService: OrdersService,
        private readonly realtimeGateway: RealtimeGateway,
    ) { }

    /**
     * Executa a mutação e, **só se ela concluir**, avisa as telas que exibem o
     * pedido.
     *
     * Fica no controlador porque cada endpoint tem uma saída só — os métodos do
     * serviço têm vários `return`, e emitir em cada um seria fácil de esquecer
     * ao mexer depois. O `delivery.controller.ts` já emite deste mesmo lugar.
     *
     * `dataEncomendaId` vai junto porque a lista do formulário
     * (`(admin)/order-forms/orders.tsx`) filtra por ele; sem o campo, toda tela
     * de formulário aberta refaz a busca a cada evento de qualquer formulário.
     */
    private async comBroadcast<
        T extends { id: number; dataEncomendaId?: number | null; statusPagamento?: string | null },
    >(eventType: 'INSERT' | 'UPDATE', operacao: Promise<T>): Promise<T> {
        const pedido = await operacao;
        this.realtimeGateway.broadcast('pedidos_encomenda', eventType, {
            id: pedido.id,
            dataEncomendaId: pedido.dataEncomendaId ?? null,
            statusPagamento: pedido.statusPagamento ?? null,
        });
        return pedido;
    }

    @Post()
    @ApiOperation({ summary: 'Criar um novo pedido' })
    @ApiResponse({ status: 201, description: 'Pedido criado com sucesso' })
    create(@CurrentUser('id') userId: string, @Body() createOrderDto: CreateOrderDto) {
        return this.comBroadcast('INSERT', this.ordersService.create(userId, createOrderDto));
    }

    @Get()
    @ApiOperation({ summary: 'Listar meus pedidos' })
    @ApiResponse({ status: 200, description: 'Lista de pedidos retornada' })
    findAll(
        @CurrentUser('id') userId: string,
        @Query('skip') skip?: number,
        @Query('take') take?: number,
    ) {
        return this.ordersService.findAll(userId, Number(skip) || 0, Number(take) || 10);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Obter detalhes de um pedido' })
    @ApiResponse({ status: 200, description: 'Detalhes do pedido retornados' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') userId: string) {
        return this.ordersService.findOne(id, userId);
    }

    @Get(':id/pix-qrcode')
    @ApiOperation({ summary: 'Gerar QR Code PIX para um pedido' })
    @ApiResponse({ status: 200, description: 'QR Code PIX gerado' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    getPixQrCode(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') userId: string) {
        return this.ordersService.getPixQrCode(id, userId);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Atualizar um pedido (antes do deadline)' })
    @ApiResponse({ status: 200, description: 'Pedido atualizado com sucesso' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Prazo expirado ou pedido não pode ser editado' })
    @ApiResponse({ status: 403, description: 'Sem permissão para editar este pedido' })
    update(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: string,
        @Body() updateOrderDto: UpdateOrderDto
    ) {
        return this.comBroadcast('UPDATE', this.ordersService.update(id, userId, updateOrderDto));
    }

    @Post(':id/cancel')
    @ApiOperation({ summary: 'Cancelar meu pedido (antes do deadline)' })
    @ApiResponse({ status: 200, description: 'Pedido cancelado com sucesso' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Prazo expirado ou status inválido' })
    @ApiResponse({ status: 403, description: 'Sem permissão para cancelar este pedido' })
    cancelMyOrder(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: string
    ) {
        return this.comBroadcast('UPDATE', this.ordersService.cancelMyOrder(id, userId));
    }

    @Patch(':id/receipt')
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
    @ApiOperation({ summary: 'Enviar comprovante de pagamento' })
    @ApiResponse({ status: 200, description: 'Comprovante enviado com sucesso' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 403, description: 'Sem permissão para este pedido' })
    uploadReceipt(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: string,
        @UploadedFile() file: Express.Multer.File
    ) {
        return this.comBroadcast('UPDATE', this.ordersService.updateReceipt(id, userId, file));
    }

    // Admin endpoints
    @Post(':id/confirm-payment')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Confirmar pagamento de um pedido (Admin)' })
    @ApiResponse({ status: 200, description: 'Pagamento confirmado' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Operação inválida' })
    confirmPayment(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') adminUserId: string) {
        return this.comBroadcast('UPDATE', this.ordersService.confirmPayment(id, adminUserId));
    }

    @Post(':id/revert-payment')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Reverter confirmação de pagamento (Admin)' })
    @ApiResponse({ status: 200, description: 'Pagamento revertido' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Operação inválida' })
    revertPayment(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') adminUserId: string) {
        return this.comBroadcast('UPDATE', this.ordersService.revertPayment(id, adminUserId));
    }

    @Post(':id/reject-payment')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Recusar comprovante de pagamento (Admin)' })
    @ApiResponse({ status: 200, description: 'Pagamento recusado' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Operação inválida' })
    rejectPayment(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') adminUserId: string) {
        return this.comBroadcast('UPDATE', this.ordersService.rejectPayment(id, adminUserId));
    }

    @Delete(':id')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Cancelar um pedido (Admin)' })
    @ApiResponse({ status: 200, description: 'Pedido cancelado' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Operação inválida' })
    cancelOrder(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') adminUserId: string) {
        return this.comBroadcast('UPDATE', this.ordersService.cancelOrder(id, adminUserId));
    }

    @Post(':id/revert-cancellation')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Reverter cancelamento de um pedido (Admin)' })
    @ApiResponse({ status: 200, description: 'Cancelamento revertido' })
    @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
    @ApiResponse({ status: 400, description: 'Operação inválida' })
    revertCancellation(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') adminUserId: string) {
        return this.comBroadcast('UPDATE', this.ordersService.revertCancellation(id, adminUserId));
    }

    @Get('form/:formId')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Listar pedidos de um formulário (Admin)' })
    @ApiResponse({ status: 200, description: 'Lista de pedidos do formulário retornada' })
    findByOrderForm(
        @Param('formId') formId: string,
        @Query('search') search?: string,
        @Query('skip') skip?: number,
        @Query('take') take?: number,
    ) {
        return this.ordersService.findByOrderForm(
            +formId,
            search,
            Number(skip) || 0,
            take !== undefined ? Number(take) : undefined,
        );
    }

    @Get('form/:formId/summary')
    @UseGuards(RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Resumo de pedidos de um formulário (Admin)' })
    @ApiResponse({ status: 200, description: 'Resumo de pedidos' })
    getOrderFormSummary(@Param('formId', ParseIntPipe) formId: number) {
        return this.ordersService.getOrderFormSummary(formId);
    }
}

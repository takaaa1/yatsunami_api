import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  ParseIntPipe,
  Res,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { OrderFormsService } from './order-forms.service';
import { CreateOrderFormDto, UpdateOrderFormDto } from './dto';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { PdfService } from '../pdf/pdf.service';
import { BackgroundJobService } from '../../common/jobs/background-job.service';
import { PdfJobResult } from '../../common/jobs/background-job.types';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  broadcastAfter,
  type BroadcastEventType,
} from '../../common/realtime/broadcast-after';

@ApiTags('order-forms')
@ApiTags('order-forms')
@Controller('order-forms')
export class OrderFormsController {
  constructor(
    private readonly orderFormsService: OrderFormsService,
    private readonly pdfService: PdfService,
    private readonly backgroundJobService: BackgroundJobService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * O que mais importa aqui é ativar ou desativar: o admin abre o formulário
   * e os clientes precisam ver "Novo Pedido" liberado sem reabrir o app.
   *
   * `ativo` e `concluido` vão no evento porque decidem se o formulário
   * aparece para o cliente — quem escuta pode reagir sem refazer a busca.
   */
  private comBroadcast<
    T extends { id: number; ativo?: boolean; concluido?: boolean },
  >(eventType: BroadcastEventType, operacao: Promise<T>): Promise<T> {
    return broadcastAfter(
      this.realtimeGateway,
      'datas_encomenda',
      eventType,
      operacao,
      (f) => ({
        id: f.id,
        ativo: f.ativo ?? null,
        concluido: f.concluido ?? null,
      }),
    );
  }

  @Post()
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a new order form (Admin)' })
  create(@Body() createDto: CreateOrderFormDto) {
    return this.comBroadcast(
      'INSERT',
      this.orderFormsService.create(createDto),
    );
  }

  @Get()
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List all order forms' })
  findAll(
    @Query('skip', new ParseIntPipe({ optional: true })) skip?: number,
    @Query('take', new ParseIntPipe({ optional: true })) take?: number,
  ) {
    return this.orderFormsService.findAll(
      Number(skip) || 0,
      take !== undefined ? Number(take) : undefined,
    );
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
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.comBroadcast(
      'UPDATE',
      this.orderFormsService.update(id, updateDto, adminUserId),
    );
  }

  @Delete(':id')
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Delete an order form (Admin)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.comBroadcast('DELETE', this.orderFormsService.remove(id));
  }

  @Post(':id/pdf-summary')
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Enfileirar geração assíncrona do resumo PDF' })
  @ApiResponse({ status: 202, description: 'Job de PDF enfileirado' })
  queueSummaryPdf(@Param('id', ParseIntPipe) id: number) {
    const jobId = this.backgroundJobService.enqueue<PdfJobResult>(
      `pdf-summary-${id}`,
      async () => {
        const data = await this.orderFormsService.getSummaryData(id);
        const buffer = await this.pdfService.generateOrderSummary(data);
        return {
          buffer,
          filename: `resumo_pedidos_${id}.pdf`,
          contentType: 'application/pdf',
        };
      },
    );

    return {
      jobId,
      status: 'queued',
    };
  }

  @Get(':id/pdf-summary')
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Gerar resumo PDF consolidado de pedidos (síncrono — legado)',
  })
  @ApiResponse({ status: 200, description: 'Resumo PDF gerado com sucesso' })
  async getSummaryPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
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
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Enfileirar notificação sobre este formulário para usuários ativos',
  })
  @ApiResponse({ status: 202, description: 'Envio enfileirado' })
  sendNotification(@Param('id', ParseIntPipe) id: number) {
    return this.orderFormsService.sendFormNotification(id);
  }
}

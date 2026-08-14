import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { TrackingGateway } from './tracking.gateway';
import { RoutesService } from './routes.service';
import { CreateRouteDto } from './dto/create-route.dto';
import { ReorderStopsDto } from './dto/reorder-stops.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@ApiTags('delivery')
@Controller('delivery')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth('JWT')
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly trackingGateway: TrackingGateway,
    private readonly routesService: RoutesService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /** Notifica clientes em /realtime que pedidos tiveram emEntrega alterado. */
  private broadcastOrdersEmEntrega(
    orderIds: number[] | undefined,
    emEntrega: boolean,
  ) {
    if (!orderIds?.length) return;
    for (const id of orderIds) {
      this.realtimeGateway.broadcast('pedidos_encomenda', 'UPDATE', {
        id,
        emEntrega,
      });
    }
  }

  @Post('routes')
  @UseGuards(RolesGuard)
  @Roles('admin')
  createRoute(@Body() createRouteDto: CreateRouteDto) {
    return this.deliveryService.createRoute(createRouteDto);
  }

  @Get('routes/:formId')
  getRoute(@Param('formId', ParseIntPipe) formId: number) {
    return this.deliveryService.getRoute(formId);
  }

  @Patch('routes/:formId/reorder')
  @UseGuards(RolesGuard)
  @Roles('admin')
  reorderStops(
    @Param('formId', ParseIntPipe) formId: number,
    @Body() reorderStopsDto: ReorderStopsDto,
  ) {
    return this.deliveryService.reorderStops(formId, reorderStopsDto);
  }

  @Delete('routes/:formId')
  @UseGuards(RolesGuard)
  @Roles('admin')
  deleteRoute(@Param('formId', ParseIntPipe) formId: number) {
    return this.deliveryService.deleteRoute(formId);
  }

  @Post('location')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async updateLocation(@Body() updateLocationDto: UpdateLocationDto) {
    const result = await this.deliveryService.updateLocation(updateLocationDto);
    this.trackingGateway.server
      .to(`tracking_${updateLocationDto.formId}`)
      .emit('locationUpdate', updateLocationDto);

    // Rastreio retomado automaticamente: avisa os clientes para o botão "Rastrear" voltar na hora
    if (result.reactivatedOrderIds?.length) {
      this.trackingGateway.broadcastSharingStatus(
        updateLocationDto.formId,
        true,
        {
          userId: updateLocationDto.userId ?? null,
          courierId: updateLocationDto.courierId,
        },
      );
      this.broadcastOrdersEmEntrega(result.reactivatedOrderIds, true);
    }

    await this.trackingGateway.handleDynamicETA(
      updateLocationDto.formId,
      updateLocationDto.courierId,
    );
    return result;
  }

  @Post('complete')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async markDeliveryComplete(
    @Body('formId', ParseIntPipe) formId: number,
    @Body('paradaIdx', ParseIntPipe) paradaIdx: number,
  ) {
    const result = await this.deliveryService.markDeliveryComplete(
      formId,
      paradaIdx,
    );
    this.trackingGateway.sendDeliveryUpdate(formId, paradaIdx);
    for (const id of result.orderIds ?? []) {
      this.realtimeGateway.broadcast('pedidos_encomenda', 'UPDATE', {
        id,
        emEntrega: false,
        statusPagamento: 'entregue',
      });
    }
    return result;
  }

  @Post('start-sharing')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async startRouteSharing(
    @Body('formId', ParseIntPipe) formId: number,
    @Body('courierId') courierId?: number,
    @Body('userId') userId?: string,
  ) {
    if (courierId !== undefined) {
      const activeTracking = await this.deliveryService.getActiveTracking(
        formId,
        courierId,
      );
      if (
        activeTracking &&
        activeTracking.isActive &&
        activeTracking.userId !== userId
      ) {
        return {
          success: false,
          error: 'ROUTE_ALREADY_TRACKED',
          message:
            'Outro usuário já está compartilhando localização para esta rota.',
          trackedBy: activeTracking.userId,
        };
      }
    }

    const result = await this.deliveryService.startRouteSharing(
      formId,
      courierId,
      userId,
    );
    this.trackingGateway.broadcastSharingStatus(formId, true, {
      userName: result.userName,
      userId: result.userId,
      courierId,
    });
    this.broadcastOrdersEmEntrega(result.orderIds, true);
    return result;
  }

  @Post('stop-sharing')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async stopRouteSharing(
    @Body('formId', ParseIntPipe) formId: number,
    @Body('courierId') courierId?: number,
  ) {
    const result = await this.deliveryService.stopRouteSharing(
      formId,
      courierId,
    );
    this.trackingGateway.broadcastSharingStatus(formId, false, { courierId });
    this.broadcastOrdersEmEntrega(result.orderIds, false);
    return result;
  }

  @Get('tracking-status/:formId/:courierId')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async getTrackingStatus(
    @Param('formId', ParseIntPipe) formId: number,
    @Param('courierId', ParseIntPipe) courierId: number,
  ) {
    return this.deliveryService.getActiveTracking(formId, courierId);
  }

  @Delete('complete')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async unmarkDeliveryComplete(
    @Body('formId', ParseIntPipe) formId: number,
    @Body('paradaIdx', ParseIntPipe) paradaIdx: number,
  ) {
    const result = await this.deliveryService.unmarkDeliveryComplete(
      formId,
      paradaIdx,
    );
    this.trackingGateway.sendDeliveryUpdate(formId, paradaIdx);
    // Espelha o POST: sem isto o cliente só via a reversão ao reabrir a tela.
    for (const id of result.orderIds) {
      this.realtimeGateway.broadcast('pedidos_encomenda', 'UPDATE', {
        id,
        emEntrega: result.emEntrega,
      });
    }
    return result;
  }

  @Get('status/:formId')
  getDeliveryStatus(
    @Param('formId', ParseIntPipe) formId: number,
    @Query('courierId') courierIdStr?: string,
  ) {
    const courierId = courierIdStr ? parseInt(courierIdStr, 10) : undefined;
    return this.deliveryService.getDeliveryStatus(formId, courierId);
  }

  @Get('etas/:formId')
  getDynamicEtas(
    @Param('formId', ParseIntPipe) formId: number,
    @Query('courierId') courierIdStr?: string,
  ) {
    const courierId = courierIdStr ? parseInt(courierIdStr, 10) : undefined;
    return this.deliveryService.calculateDynamicETAs(formId, courierId);
  }

  @Post('geocode-address')
  async geocodeAddress(
    @Body('address') address: string,
    @Body('cep') cep?: string,
  ) {
    if (!address || typeof address !== 'string' || address.trim().length < 5) {
      return { found: false };
    }
    const result = await this.routesService.geocodeAddress(
      address.trim(),
      cep?.trim(),
    );
    if (!result) return { found: false };
    return { found: true, ...result };
  }
}

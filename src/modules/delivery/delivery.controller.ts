import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { TrackingGateway } from './tracking.gateway';
import { RoutesService } from './routes.service';
import { CreateRouteDto } from './dto/create-route.dto';
import { ReorderStopsDto } from './dto/reorder-stops.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Controller('delivery')
export class DeliveryController {
    constructor(
        private readonly deliveryService: DeliveryService,
        private readonly trackingGateway: TrackingGateway,
        private readonly routesService: RoutesService,
    ) { }

    @Post('routes')
    createRoute(@Body() createRouteDto: CreateRouteDto) {
        return this.deliveryService.createRoute(createRouteDto);
    }

    @Get('routes/:formId')
    getRoute(@Param('formId', ParseIntPipe) formId: number) {
        return this.deliveryService.getRoute(formId);
    }

    @Patch('routes/:formId/reorder')
    reorderStops(
        @Param('formId', ParseIntPipe) formId: number,
        @Body() reorderStopsDto: ReorderStopsDto,
    ) {
        return this.deliveryService.reorderStops(formId, reorderStopsDto);
    }

    @Delete('routes/:formId')
    deleteRoute(@Param('formId', ParseIntPipe) formId: number) {
        return this.deliveryService.deleteRoute(formId);
    }

    @Post('location')
    async updateLocation(@Body() updateLocationDto: UpdateLocationDto) {
        const result = await this.deliveryService.updateLocation(updateLocationDto);
        // Also broadcast to WebSockets for real-time tracking
        this.trackingGateway.server.to(`tracking_${updateLocationDto.formId}`).emit('locationUpdate', updateLocationDto);
        // Recalculate ETA if necessary (throttled)
        await this.trackingGateway.handleDynamicETA(updateLocationDto.formId, updateLocationDto.courierId);
        return result;
    }

    @Post('complete')
    async markDeliveryComplete(
        @Body('formId', ParseIntPipe) formId: number,
        @Body('paradaIdx', ParseIntPipe) paradaIdx: number,
    ) {
        const result = await this.deliveryService.markDeliveryComplete(formId, paradaIdx);
        this.trackingGateway.sendDeliveryUpdate(formId, paradaIdx);
        return result;
    }

    @Post('start-sharing')
    async startRouteSharing(
        @Body('formId', ParseIntPipe) formId: number,
        @Body('courierId') courierId?: number,
        @Body('userId') userId?: string,
    ) {
        // Check if another user is already tracking this courier route
        if (courierId !== undefined) {
            const activeTracking = await this.deliveryService.getActiveTracking(formId, courierId);
            if (activeTracking && activeTracking.isActive && activeTracking.userId !== userId) {
                return {
                    success: false,
                    error: 'ROUTE_ALREADY_TRACKED',
                    message: 'Outro usuário já está compartilhando localização para esta rota.',
                    trackedBy: activeTracking.userId
                };
            }
        }

        const result = await this.deliveryService.startRouteSharing(formId, courierId, userId);
        this.trackingGateway.broadcastSharingStatus(formId, true, {
            userName: result.userName,
            userId: result.userId,
            courierId,
        });
        return result;
    }

    @Post('stop-sharing')
    async stopRouteSharing(
        @Body('formId', ParseIntPipe) formId: number,
        @Body('courierId') courierId?: number,
    ) {
        const result = await this.deliveryService.stopRouteSharing(formId, courierId);
        this.trackingGateway.broadcastSharingStatus(formId, false, { courierId });
        return result;
    }

    @Get('tracking-status/:formId/:courierId')
    async getTrackingStatus(
        @Param('formId', ParseIntPipe) formId: number,
        @Param('courierId', ParseIntPipe) courierId: number,
    ) {
        return this.deliveryService.getActiveTracking(formId, courierId);
    }

    @Delete('complete')
    async unmarkDeliveryComplete(
        @Body('formId', ParseIntPipe) formId: number,
        @Body('paradaIdx', ParseIntPipe) paradaIdx: number,
    ) {
        const result = await this.deliveryService.unmarkDeliveryComplete(formId, paradaIdx);
        this.trackingGateway.sendDeliveryUpdate(formId, paradaIdx);
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

    /**
     * Geocodifica um endereço via Google Maps e retorna endereço formatado + coordenadas.
     * Usado pelo app para validar endereços antes de salvar no perfil.
     */
    @Post('geocode-address')
    async geocodeAddress(@Body('address') address: string, @Body('cep') cep?: string) {
        if (!address || typeof address !== 'string' || address.trim().length < 5) {
            return { found: false };
        }
        const result = await this.routesService.geocodeAddress(address.trim(), cep?.trim());
        if (!result) return { found: false };
        return { found: true, ...result };
    }
}

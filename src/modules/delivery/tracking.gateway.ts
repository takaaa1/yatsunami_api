import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DeliveryService } from './delivery.service';
import { UpdateLocationDto } from './dto/update-location.dto';

@WebSocketGateway({ cors: true })
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer() server: Server;
    private readonly etaThrottle = new Map<string, number>(); // Changed key to string for "formId_courierId"
    private readonly THROTTLE_MS = 30000; // 30 seconds

    constructor(private readonly deliveryService: DeliveryService) { }

    handleConnection(_client: Socket) { }

    handleDisconnect(_client: Socket) { }

    @SubscribeMessage('updateLocation')
    async handleLocationUpdate(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: UpdateLocationDto,
    ) {
        // 1. Save to DB
        await this.deliveryService.updateLocation(payload);

        // 2. Broadcast location to room
        this.server.to(`tracking_${payload.formId}`).emit('locationUpdate', payload);

        // 3. Handle Dynamic ETA
        await this.handleDynamicETA(payload.formId, payload.courierId);
    }

    // Accessible from Controller for background updates
    async handleDynamicETA(formId: number, courierId?: number) {
        const now = Date.now();
        const throttleKey = courierId ? `${formId}_${courierId}` : `${formId}`;
        const lastRun = this.etaThrottle.get(throttleKey) || 0;

        if (now - lastRun >= this.THROTTLE_MS) {
            this.etaThrottle.set(throttleKey, now);

            try {
                const dynamicEtas = await this.deliveryService.calculateDynamicETAs(formId, courierId);
                if (dynamicEtas) {
                    this.server.to(`tracking_${formId}`).emit('etaUpdate', dynamicEtas);
                }
            } catch (error) {
                // Silently fail to not block location updates
            }
        }
    }

    @SubscribeMessage('joinTracking')
    handleJoinTracking(
        @ConnectedSocket() client: Socket,
        @MessageBody('formId') formId: number,
    ) {
        client.join(`tracking_${formId}`);
        return { event: 'joinedTracking', data: formId };
    }

    @SubscribeMessage('leaveTracking')
    handleLeaveTracking(
        @ConnectedSocket() client: Socket,
        @MessageBody('formId') formId: number,
    ) {
        client.leave(`tracking_${formId}`);
        return { event: 'leftTracking', data: formId };
    }

    // Used by REST controller when a delivery is marked as complete
    sendDeliveryUpdate(formId: number, paradaIdx: number) {
        this.server.to(`tracking_${formId}`).emit('deliveryUpdate', { formId, paradaIdx });
    }

    // Notify clients that sharing was started or stopped
    broadcastSharingStatus(formId: number, active: boolean, meta?: { userName?: string | null; userId?: string | null; courierId?: number }) {
        this.server.to(`tracking_${formId}`).emit('sharingStatus', {
            formId,
            active,
            userName: meta?.userName ?? null,
            userId: meta?.userId ?? null,
            courierId: meta?.courierId,
        });
    }
}

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

/**
 * General-purpose realtime gateway.
 * Replaces Supabase Realtime `postgres_changes` subscriptions.
 *
 * Protocol:
 *   Client → joinTable   { table: string }           → joins room "table:<name>"
 *   Client → leaveTable  { table: string }            → leaves room
 *   Server → tableChange { table, eventType, record } → broadcast to room
 */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/realtime' })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Realtime client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Realtime client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinTable')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody('table') table: string,
  ) {
    if (!table) return;
    void client.join(`table:${table}`);
    return { event: 'joinedTable', data: table };
  }

  @SubscribeMessage('leaveTable')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody('table') table: string,
  ) {
    if (!table) return;
    void client.leave(`table:${table}`);
    return { event: 'leftTable', data: table };
  }

  /**
   * Called by services after any DB mutation so connected clients can react.
   * eventType mirrors Supabase: 'INSERT' | 'UPDATE' | 'DELETE'
   */
  broadcast(
    table: string,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    record?: Record<string, unknown> | null,
  ) {
    this.server?.to(`table:${table}`).emit('tableChange', {
      table,
      eventType,
      record: record ?? null,
    });
  }
}

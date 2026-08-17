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
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

/**
 * General-purpose realtime gateway.
 * Replaces Supabase Realtime `postgres_changes` subscriptions.
 *
 * Protocol:
 *   Client → joinTable    { table: string }            → joins room "table:<name>"
 *   Client → leaveTable   { table: string }            → leaves room
 *   Client → authenticate { token: string }            → joins room "user:<sub>"
 *   Server → authenticated { userId }                  → confirma a sala do usuário
 *   Server → tableChange  { table, eventType, record } → broadcast to room
 *
 * Há dois tipos de sala, e a diferença é de privacidade, não de conveniência:
 *
 * - `table:<nome>` é **pública entre os conectados**. Serve para dado que já é
 *   visível a quem está na tela — produto, categoria, janela de pedido. O
 *   registro emitido carrega só chaves e status, nunca dado pessoal.
 * - `user:<id>` é do dono. Serve para o que só interessa (e só pode chegar) a
 *   uma pessoa: a inbox de notificações. Emitir isso na sala da tabela
 *   entregaria o UUID do destinatário a todo aparelho conectado.
 */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/realtime' })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  handleConnection(client: Socket) {
    this.logger.debug(`Realtime client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Realtime client disconnected: ${client.id}`);
  }

  /**
   * O app já emitia `authenticate` no `connect` desde a migração do Supabase,
   * mas não havia nada escutando: o socket ficava anônimo e não existia sala
   * por usuário. Sem isto, notificação não tem como ser entregue só ao dono.
   *
   * A verificação é a mesma da `JwtStrategy` (HS256, `jwt.secret`) menos a
   * consulta ao banco: aqui só o `sub` é usado, para nomear a sala. Token
   * inválido ou expirado apenas não entra em sala nenhuma — a conexão segue
   * viva, porque as salas de tabela são públicas e não dependem de login.
   */
  @SubscribeMessage('authenticate')
  handleAuthenticate(
    @ConnectedSocket() client: Socket,
    @MessageBody('token') token: string,
  ) {
    if (!token) return;

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token);
    } catch {
      this.logger.debug(`Realtime auth recusada para ${client.id}`);
      return;
    }

    if (!payload?.sub) return;

    // Uma conexão só serve a um usuário por vez. Trocar de conta sem
    // reconectar (logout e login com o socket compartilhado vivo) deixaria a
    // sala antiga ativa, e a inbox do usuário anterior chegaria aqui.
    for (const room of client.rooms) {
      if (room.startsWith('user:') && room !== `user:${payload.sub}`) {
        void client.leave(room);
      }
    }

    void client.join(`user:${payload.sub}`);
    return { event: 'authenticated', data: { userId: payload.sub } };
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

  /**
   * Mesma via do `broadcast`, mas só para os aparelhos daquele usuário.
   *
   * O evento continua sendo `tableChange` de propósito: o `useRealtime` no app
   * já filtra por `payload.table`, então a tela escuta `notificacoes` sem
   * saber que a entrega foi dirigida. Quem decide o alcance é o servidor.
   */
  broadcastToUser(
    usuarioId: string,
    table: string,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    record?: Record<string, unknown> | null,
  ) {
    if (!usuarioId) return;
    this.server?.to(`user:${usuarioId}`).emit('tableChange', {
      table,
      eventType,
      record: record ?? null,
    });
  }
}

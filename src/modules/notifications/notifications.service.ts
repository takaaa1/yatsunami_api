import { Prisma } from '@prisma/client';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import {
  buildNotificationMessage,
  SupportedLocale,
} from './notifications.i18n';
import { Cron } from '@nestjs/schedule';
import { CronLockService } from '../../common/cron/cron-lock.service';
import { CRON_LOCK_KEYS } from '../../common/runtime/runtime.config';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class NotificationsService {
  private expo: Expo;
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private cronLockService: CronLockService,
    private realtimeGateway: RealtimeGateway,
  ) {
    this.expo = new Expo({
      accessToken: process.env.EXPO_ACCESS_TOKEN,
    });
  }

  /**
   * Avisa **só os aparelhos do dono** que a inbox dele mudou.
   *
   * Vai na sala `user:<id>`, não na sala da tabela: o destinatário de uma
   * notificação é dado pessoal. O registro carrega o mínimo — a tela refaz a
   * busca de qualquer forma, porque a lista é paginada e ordenada no servidor.
   */
  private avisaInbox(
    usuarioId: string,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    registro: Record<string, unknown> = {},
  ) {
    this.realtimeGateway.broadcastToUser(usuarioId, 'notificacoes', eventType, {
      usuarioId,
      ...registro,
    });
  }

  private async deduplicateNotification(
    usuarioId: string,
    chave: string,
    pedidoDiretoId?: number,
    pedidoEncomendaId?: number,
    dataEncomendaId?: number,
  ) {
    if (!pedidoDiretoId && !pedidoEncomendaId && !dataEncomendaId) return;

    const where: Prisma.NotificacaoWhereInput = {
      usuarioId,
      titulo: `${chave}.title`,
    };
    if (pedidoDiretoId) where.pedidoDiretoId = pedidoDiretoId;
    if (pedidoEncomendaId) where.pedidoEncomendaId = pedidoEncomendaId;
    if (dataEncomendaId) where.dataEncomendaId = dataEncomendaId;

    await this.prisma.notificacao.deleteMany({ where });
  }

  async createAndSendNotification(data: {
    usuarioId: string;
    chave: string;
    parametros: Record<string, string>;
    dataEncomendaId?: number;
    pedidoDiretoId?: number;
    pedidoEncomendaId?: number;
    tipo?: string;
  }) {
    // 0. Deduplicar: remover notificações antigas do mesmo pedido + mesmo status
    await this.deduplicateNotification(
      data.usuarioId,
      data.chave,
      data.pedidoDiretoId,
      data.pedidoEncomendaId,
      data.dataEncomendaId,
    );

    // 1. Salvar no banco (Inbox) com chave i18n
    const notificacao = await this.prisma.notificacao.create({
      data: {
        usuarioId: data.usuarioId,
        titulo: `${data.chave}.title`,
        mensagem: `${data.chave}.message`,
        parametros: data.parametros,
        dataEncomendaId: data.dataEncomendaId,
        pedidoDiretoId: data.pedidoDiretoId,
        pedidoEncomendaId: data.pedidoEncomendaId,
        tipo: data.tipo || 'user',
      },
    });

    // 1b. Avisar a inbox antes de tentar o push. O push é o caminho que pode
    // falhar (token inválido, aparelho sem permissão); o realtime não depende
    // dele, e o sino precisa acender mesmo com o app já aberto na frente.
    this.avisaInbox(data.usuarioId, 'INSERT', { id: notificacao.id });

    // 2. Buscar token, preferência e idioma do usuário
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: data.usuarioId },
      select: { expoPushToken: true, receberNotificacoes: true, idioma: true },
    });

    if (
      usuario?.receberNotificacoes &&
      usuario?.expoPushToken &&
      Expo.isExpoPushToken(usuario.expoPushToken)
    ) {
      try {
        const locale = (
          usuario.idioma === 'ja-JP' ? 'ja-JP' : 'pt-BR'
        ) as SupportedLocale;
        const { title, message } = buildNotificationMessage(
          data.chave,
          data.parametros,
          locale,
        );

        const messages: ExpoPushMessage[] = [
          {
            to: usuario.expoPushToken,
            sound: 'default',
            title,
            body: message,
            data: {
              notificacaoId: notificacao.id,
              dataEncomendaId: data.dataEncomendaId,
              pedidoDiretoId: data.pedidoDiretoId,
              pedidoEncomendaId: data.pedidoEncomendaId,
              tipo: data.tipo || 'user',
            },
            projectId: process.env.EXPO_PROJECT_ID,
          } as ExpoPushMessage & { projectId?: string },
        ];

        const chunks = this.expo.chunkPushNotifications(messages);
        for (const chunk of chunks) {
          try {
            await this.expo.sendPushNotificationsAsync(chunk);
          } catch (error) {
            this.logger.error(`Erro ao enviar push chunk: ${error}`);
          }
        }
      } catch (error) {
        this.logger.error(`Erro ao processar push: ${error}`);
      }
    }

    return notificacao;
  }

  async getUserNotifications(usuarioId: string, skip = 0, take = 10) {
    return this.prisma.notificacao.findMany({
      where: { usuarioId },
      orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
  }

  // Os três métodos abaixo usam `updateMany`/`deleteMany` com `usuarioId` no
  // filtro — é assim que a posse é verificada. Por isso o `count` manda no
  // aviso: zero significa que a notificação não era desta pessoa, e emitir
  // faria os aparelhos dela recarregarem à toa.

  async markAsRead(id: string, usuarioId: string) {
    const resultado = await this.prisma.notificacao.updateMany({
      where: { id, usuarioId },
      data: { lido: true },
    });
    if (resultado.count > 0) {
      this.avisaInbox(usuarioId, 'UPDATE', { id, lido: true });
    }
    return resultado;
  }

  async markAllAsRead(usuarioId: string) {
    const resultado = await this.prisma.notificacao.updateMany({
      where: { usuarioId, lido: false },
      data: { lido: true },
    });
    if (resultado.count > 0) {
      this.avisaInbox(usuarioId, 'UPDATE');
    }
    return resultado;
  }

  async deleteOne(id: string, usuarioId: string) {
    const resultado = await this.prisma.notificacao.deleteMany({
      where: { id, usuarioId },
    });
    if (resultado.count > 0) {
      this.avisaInbox(usuarioId, 'DELETE', { id });
    }
    return resultado;
  }

  @Cron('0 3 * * *') // Daily at 03:00
  async purgeOldNotifications() {
    await this.cronLockService.withLock(
      CRON_LOCK_KEYS.NOTIFICATION_PURGE,
      'purgeOldNotifications',
      async () => {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const result = await this.prisma.notificacao.deleteMany({
          where: { criadoEm: { lt: thirtyDaysAgo } },
        });

        this.logger.log(
          `Auto-purge: ${result.count} notificações com 30+ dias removidas`,
        );
      },
    );
  }

  async broadcastNotification(data: {
    usuarioIds: string[];
    chave: string;
    parametros: Record<string, string>;
    dataEncomendaId?: number;
    pedidoDiretoId?: number;
    pedidoEncomendaId?: number;
    tipo?: string;
  }) {
    const uniqueUserIds = [...new Set(data.usuarioIds)];
    if (uniqueUserIds.length === 0) {
      return { pushSent: 0 };
    }

    const notificacaoIdByUserId = await this.createInboxNotificationsBulk(
      data,
      uniqueUserIds,
    );

    const usuarios = await this.prisma.usuario.findMany({
      where: {
        id: { in: uniqueUserIds },
        receberNotificacoes: true,
        AND: [{ expoPushToken: { not: null } }, { expoPushToken: { not: '' } }],
      },
      select: { id: true, expoPushToken: true, idioma: true },
    });

    const messages: ExpoPushMessage[] = [];
    for (const usuario of usuarios) {
      if (
        usuario.expoPushToken &&
        Expo.isExpoPushToken(usuario.expoPushToken)
      ) {
        const locale = (
          usuario.idioma === 'ja-JP' ? 'ja-JP' : 'pt-BR'
        ) as SupportedLocale;
        const { title, message } = buildNotificationMessage(
          data.chave,
          data.parametros,
          locale,
        );

        messages.push({
          to: usuario.expoPushToken,
          sound: 'default',
          title,
          body: message,
          data: {
            notificacaoId: notificacaoIdByUserId.get(usuario.id),
            dataEncomendaId: data.dataEncomendaId,
            pedidoDiretoId: data.pedidoDiretoId,
            pedidoEncomendaId: data.pedidoEncomendaId,
            tipo: data.tipo || 'admin',
          },
          projectId: process.env.EXPO_PROJECT_ID,
        } as ExpoPushMessage & { projectId?: string });
      }
    }

    if (messages.length > 0) {
      const chunks = this.expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        try {
          const tickets = await this.expo.sendPushNotificationsAsync(chunk);
          for (const ticket of tickets) {
            if (ticket.status === 'error') {
              this.logger.warn(
                `Push broadcast ticket error: ${ticket.message}${ticket.details ? ` — ${JSON.stringify(ticket.details)}` : ''}`,
              );
            }
          }
        } catch (error) {
          this.logger.error(`Erro ao enviar broadcast push chunk: ${error}`);
        }
      }
    } else if (uniqueUserIds.length > 0) {
      this.logger.log(
        `Broadcast sem mensagens push (${uniqueUserIds.length} destinatários na inbox): nenhum token Expo válido com receberNotificacoes=true`,
      );
    }

    return { pushSent: messages.length };
  }

  private async createInboxNotificationsBulk(
    data: {
      chave: string;
      parametros: Record<string, string>;
      dataEncomendaId?: number;
      pedidoDiretoId?: number;
      pedidoEncomendaId?: number;
      tipo?: string;
    },
    usuarioIds: string[],
  ): Promise<Map<string, string>> {
    const notificacaoIdByUserId = new Map<string, string>();
    const hasDedupeKey = !!(
      data.pedidoDiretoId ||
      data.pedidoEncomendaId ||
      data.dataEncomendaId
    );

    if (hasDedupeKey) {
      const dedupeWhere: Record<string, unknown> = {
        usuarioId: { in: usuarioIds },
        titulo: `${data.chave}.title`,
      };
      if (data.pedidoDiretoId) dedupeWhere.pedidoDiretoId = data.pedidoDiretoId;
      if (data.pedidoEncomendaId)
        dedupeWhere.pedidoEncomendaId = data.pedidoEncomendaId;
      if (data.dataEncomendaId)
        dedupeWhere.dataEncomendaId = data.dataEncomendaId;

      await this.prisma.notificacao.deleteMany({ where: dedupeWhere });
    }

    const BATCH_SIZE = 100;
    for (let offset = 0; offset < usuarioIds.length; offset += BATCH_SIZE) {
      const batch = usuarioIds.slice(offset, offset + BATCH_SIZE);
      const created = await this.prisma.notificacao.createManyAndReturn({
        data: batch.map((usuarioId) => ({
          usuarioId,
          titulo: `${data.chave}.title`,
          mensagem: `${data.chave}.message`,
          parametros: data.parametros,
          dataEncomendaId: data.dataEncomendaId,
          pedidoDiretoId: data.pedidoDiretoId,
          pedidoEncomendaId: data.pedidoEncomendaId,
          tipo: data.tipo || 'admin',
        })),
      });

      for (const notificacao of created) {
        notificacaoIdByUserId.set(notificacao.usuarioId, notificacao.id);
        // Um aviso por destinatário, cada um na sua sala. O broadcast pode
        // atingir centenas de pessoas, mas ninguém recebe o id de outro.
        this.avisaInbox(notificacao.usuarioId, 'INSERT', {
          id: notificacao.id,
        });
      }
    }

    return notificacaoIdByUserId;
  }
}

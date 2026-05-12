import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { buildNotificationMessage, SupportedLocale } from './notifications.i18n';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class NotificationsService {
    private expo: Expo;
    private readonly logger = new Logger(NotificationsService.name);

    constructor(private prisma: PrismaService) {
        this.expo = new Expo({
            accessToken: process.env.EXPO_ACCESS_TOKEN,
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

        const where: any = { usuarioId, titulo: `${chave}.title` };
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

        // 2. Buscar token, preferência e idioma do usuário
        const usuario = await this.prisma.usuario.findUnique({
            where: { id: data.usuarioId },
            select: { expoPushToken: true, receberNotificacoes: true, idioma: true },
        });

        if (usuario?.receberNotificacoes && usuario?.expoPushToken && Expo.isExpoPushToken(usuario.expoPushToken)) {
            try {
                const locale = (usuario.idioma === 'ja-JP' ? 'ja-JP' : 'pt-BR') as SupportedLocale;
                const { title, message } = buildNotificationMessage(data.chave, data.parametros, locale);

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
                        // @ts-ignore - Required for EAS
                        projectId: process.env.EXPO_PROJECT_ID,
                    } as any,
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
            orderBy: { criadoEm: 'desc' },
            skip,
            take,
        });
    }

    async markAsRead(id: string, usuarioId: string) {
        return this.prisma.notificacao.updateMany({
            where: { id, usuarioId },
            data: { lido: true },
        });
    }

    async markAllAsRead(usuarioId: string) {
        return this.prisma.notificacao.updateMany({
            where: { usuarioId, lido: false },
            data: { lido: true },
        });
    }

    async deleteOne(id: string, usuarioId: string) {
        return this.prisma.notificacao.deleteMany({
            where: { id, usuarioId },
        });
    }

    @Cron('0 3 * * *') // Daily at 03:00
    async purgeOldNotifications() {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const result = await this.prisma.notificacao.deleteMany({
            where: { criadoEm: { lt: thirtyDaysAgo } },
        });

        this.logger.log(`Auto-purge: ${result.count} notificações com 30+ dias removidas`);
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
        const notificacaoIdByUserId = new Map<string, string>();

        // Criar notificações na Inbox individualmente
        for (const id of data.usuarioIds) {
            // Deduplicar antes de criar
            await this.deduplicateNotification(
                id,
                data.chave,
                data.pedidoDiretoId,
                data.pedidoEncomendaId,
                data.dataEncomendaId,
            );

            const notificacao = await this.prisma.notificacao.create({
                data: {
                    usuarioId: id,
                    titulo: `${data.chave}.title`,
                    mensagem: `${data.chave}.message`,
                    parametros: data.parametros,
                    dataEncomendaId: data.dataEncomendaId,
                    pedidoDiretoId: data.pedidoDiretoId,
                    pedidoEncomendaId: data.pedidoEncomendaId,
                    tipo: data.tipo || 'admin',
                },
            });

            notificacaoIdByUserId.set(id, notificacao.id);
        }

        // Buscar tokens e idiomas para envio push
        const usuarios = await this.prisma.usuario.findMany({
            where: {
                id: { in: data.usuarioIds },
                receberNotificacoes: true,
                AND: [{ expoPushToken: { not: null } }, { expoPushToken: { not: '' } }],
            },
            select: { id: true, expoPushToken: true, idioma: true },
        });

        const messages: ExpoPushMessage[] = [];
        for (const usuario of usuarios) {
            if (usuario.expoPushToken && Expo.isExpoPushToken(usuario.expoPushToken)) {
                const locale = (usuario.idioma === 'ja-JP' ? 'ja-JP' : 'pt-BR') as SupportedLocale;
                const { title, message } = buildNotificationMessage(data.chave, data.parametros, locale);

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
                    // @ts-ignore - Required for EAS
                    projectId: process.env.EXPO_PROJECT_ID,
                } as any);
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
        } else if (data.usuarioIds.length > 0) {
            this.logger.log(
                `Broadcast sem mensagens push (${data.usuarioIds.length} destinatários na inbox): nenhum token Expo válido com receberNotificacoes=true`,
            );
        }

        return { pushSent: messages.length };
    }
}

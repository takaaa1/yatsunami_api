import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/authenticated-request';
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Log de acesso HTTP com atribuição de autoria.
 *
 * Sem o id do utilizador na linha de log, descobrir quem executou uma escrita
 * exige correlacionar o `POST /auth/login` mais próximo no tempo e torcer para
 * não haver duas sessões em paralelo — foi o que aconteceu na investigação da
 * venda 312 (2026-08-23). O `requestId` é devolvido no header `X-Request-Id`
 * para ligar o relato de um utilizador à linha exacta do log.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const { method, originalUrl, url } = request;
    const path = originalUrl || url;
    const userAgent = request.get('user-agent') || '-';
    const requestId = request.get('x-request-id') || randomUUID();
    const now = Date.now();

    response.setHeader('X-Request-Id', requestId);

    const write = (statusCode: number, contentLength?: string) => {
      const elapsed = Date.now() - now;
      // Só é conhecido depois do guard JWT correr — por isso lido aqui, não acima.
      const actor = request.user
        ? `${request.user.id}${request.user.role ? `/${request.user.role}` : ''}`
        : 'anon';

      this.logger.log(
        `${method} ${path} ${statusCode} ${contentLength ?? '-'} - ${elapsed}ms - ` +
          `ip=${this.clientIp(request)} user=${actor} req=${requestId} "${userAgent}"`,
      );
    };

    return next.handle().pipe(
      tap({
        next: () =>
          write(
            response.statusCode,
            response.get('content-length') ?? undefined,
          ),
        // Sem este ramo, 401/403/404 e erros 5xx não deixavam rasto nenhum.
        error: (err: { status?: number; statusCode?: number }) =>
          write(err?.status ?? err?.statusCode ?? 500),
      }),
    );
  }

  /**
   * `request.ip` só é fiável com `trust proxy` configurado (ver `main.ts`).
   * O `cf-connecting-ip` é o fallback: a Cloudflare reescreve-o em cada pedido,
   * mas quem atinge o origin directamente pode forjá-lo — daí ficar em segundo.
   */
  private clientIp(request: AuthenticatedRequest): string {
    return request.ip || request.get('cf-connecting-ip') || '-';
  }
}

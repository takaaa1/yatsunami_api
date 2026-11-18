import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Log de acesso HTTP com atribuição de autoria.
 *
 * Sem o id do utilizador na linha de log, descobrir quem executou uma escrita
 * exige correlacionar o `POST /auth/login` mais próximo no tempo e torcer para
 * não haver duas sessões em paralelo — foi o que aconteceu na investigação da
 * venda 312 (2026-08-23). O `requestId` é devolvido no header `X-Request-Id`
 * para ligar o relato de um utilizador à linha exacta do log.
 *
 * **Middleware, não interceptor** (code review 2026-11): o Nest roda os guards
 * antes dos interceptors, então uma rejeição do `JwtAuthGuard`/`RolesGuard`
 * (401/403) nunca chegava ao antigo `LoggingInterceptor` — sem linha de acesso
 * e sem `X-Request-Id` justamente nas tentativas negadas. O middleware roda
 * antes de tudo e escreve no `finish` da resposta, quando o status final e o
 * `request.user` (preenchido pelo guard) já existem.
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(request: AuthenticatedRequest, response: Response, next: NextFunction) {
    const { method, originalUrl, url } = request;
    const path = originalUrl || url;
    const userAgent = request.get('user-agent') || '-';
    const requestId = request.get('x-request-id') || randomUUID();
    const inicio = Date.now();

    response.setHeader('X-Request-Id', requestId);

    response.once('finish', () => {
      const elapsed = Date.now() - inicio;
      const actor = request.user
        ? `${request.user.id}${request.user.role ? `/${request.user.role}` : ''}`
        : 'anon';
      const contentLength = response.get('content-length') ?? '-';

      this.logger.log(
        `${method} ${path} ${response.statusCode} ${contentLength} - ${elapsed}ms - ` +
          `ip=${clientIp(request)} user=${actor} req=${requestId} "${userAgent}"`,
      );
    });

    next();
  }
}

/**
 * `request.ip` só é fiável com `trust proxy` configurado (ver `main.ts`).
 * O `cf-connecting-ip` é o fallback: a Cloudflare reescreve-o em cada pedido,
 * mas quem atinge o origin directamente pode forjá-lo — daí ficar em segundo.
 */
function clientIp(request: AuthenticatedRequest): string {
  return request.ip || request.get('cf-connecting-ip') || '-';
}

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/authenticated-request';
import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private readonly logger = new Logger('HTTP');

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const { method, url, ip } = request;
        const userAgent = request.get('user-agent') || '';
        const now = Date.now();

        return next.handle().pipe(
            tap(() => {
                const response = context.switchToHttp().getResponse<Response>();
                const { statusCode } = response;
                const contentLength = response.get('content-length');
                const elapsed = Date.now() - now;

                this.logger.log(
                    `${method} ${url} ${statusCode} ${contentLength ?? '-'} - ${elapsed}ms - ${ip} ${userAgent}`,
                );
            }),
        );
    }
}

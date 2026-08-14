import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        let status = HttpStatus.INTERNAL_SERVER_ERROR;
        // Erros de validação do Nest devolvem um array de mensagens — o corpo da
        // resposta sempre repassou isso; o tipo agora reflete a realidade.
        let message: string | string[] = 'Internal server error';
        let error = 'Internal Server Error';

        if (exception instanceof HttpException) {
            status = exception.getStatus();
            const exceptionResponse = exception.getResponse();

            if (typeof exceptionResponse === 'string') {
                message = exceptionResponse;
            } else if (typeof exceptionResponse === 'object') {
                const responseObj = exceptionResponse as {
                    message?: string | string[];
                    error?: string;
                };
                message = responseObj.message || exception.message;
                error = responseObj.error || 'Error';
            }
        } else if (exception instanceof Error) {
            message = exception.message;
        }

        // Log the error
        this.logger.error(
            `${request.method} ${request.url} - ${status} - ${Array.isArray(message) ? message.join('; ') : message}`,
            exception instanceof Error ? exception.stack : undefined,
        );

        response.status(status).json({
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            method: request.method,
            error,
            message,
        });
    }
}

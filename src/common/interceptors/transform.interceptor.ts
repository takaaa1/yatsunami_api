
import type { Response as ExpressResponse } from 'express';
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
    data: T;
    statusCode: number;
    timestamp: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Response<T>> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
        return next.handle().pipe(
            map((data: T) => ({
                data,
                statusCode: context.switchToHttp().getResponse<ExpressResponse>().statusCode,
                timestamp: new Date().toISOString(),
            })),
        );
    }
}

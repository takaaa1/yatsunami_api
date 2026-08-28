import { Logger } from '@nestjs/common';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

type Headers = Record<string, string | undefined>;

function makeContext(options: {
  user?: { id: string; role?: string };
  ip?: string;
  headers?: Headers;
  statusCode?: number;
}) {
  const headers: Headers = {
    'user-agent': 'Yatsunami/8 CFNetwork/3860.700.1 Darwin/25.6.0',
    ...options.headers,
  };
  const setHeader = jest.fn();
  const request = {
    method: 'POST',
    originalUrl: '/api/sales',
    url: '/api/sales',
    ip: options.ip,
    user: options.user,
    get: (name: string) => headers[name.toLowerCase()],
  };
  const response = {
    statusCode: options.statusCode ?? 201,
    setHeader,
    get: () => '1510',
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, setHeader };
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let logged: string[];

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    logged = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => jest.restoreAllMocks());

  const run = (context: ExecutionContext, handler: CallHandler) =>
    lastValueFrom(interceptor.intercept(context, handler)).catch(
      () => undefined,
    );

  it('regista o id e o papel de quem fez a escrita', async () => {
    const { context } = makeContext({
      user: { id: 'c627dd08-379c-4afd-a5e1-6f5f3949ae7c', role: 'admin' },
      ip: '203.0.113.9',
    });

    await run(context, { handle: () => of({ id: 312 }) });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('POST /api/sales 201');
    expect(logged[0]).toContain(
      'user=c627dd08-379c-4afd-a5e1-6f5f3949ae7c/admin',
    );
    expect(logged[0]).toContain('ip=203.0.113.9');
    expect(logged[0]).toContain('Yatsunami/8');
  });

  it('marca como anónimo o pedido sem utilizador autenticado', async () => {
    const { context } = makeContext({ ip: '203.0.113.9' });

    await run(context, { handle: () => of(null) });

    expect(logged[0]).toContain('user=anon');
  });

  it('regista também os pedidos que falham', async () => {
    const { context } = makeContext({ ip: '203.0.113.9' });

    await run(context, {
      handle: () => throwError(() => ({ status: 401 })),
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('POST /api/sales 401');
  });

  it('devolve o X-Request-Id e reutiliza o recebido', async () => {
    const { context, setHeader } = makeContext({
      headers: { 'x-request-id': 'abc-123' },
    });

    await run(context, { handle: () => of(null) });

    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-123');
    expect(logged[0]).toContain('req=abc-123');
  });

  it('cai no cf-connecting-ip quando o trust proxy não resolveu o ip', async () => {
    const { context } = makeContext({
      ip: undefined,
      headers: { 'cf-connecting-ip': '198.51.100.7' },
    });

    await run(context, { handle: () => of(null) });

    expect(logged[0]).toContain('ip=198.51.100.7');
  });
});

import {
  CanActivate,
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AccessLogMiddleware } from './access-log.middleware';

/**
 * Log de acesso HTTP com atribuição de autoria.
 *
 * Code review 2026-11: o log era um **interceptor**, e o Nest roda os guards
 * antes dos interceptors. Uma rejeição do `RolesGuard`/`JwtAuthGuard` (401/403)
 * nunca chegava a ele: sem linha de acesso, sem ip, sem `X-Request-Id` — logo
 * nas tentativas que mais interessam numa investigação. Como middleware, o
 * registro roda antes de tudo e escreve no `finish` da resposta.
 */

class RecusaTudo implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('somente admin');
  }
}

class PoeUsuario implements CanActivate {
  canActivate(ctx: import('@nestjs/common').ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: 'c627dd08-379c-4afd-a5e1-6f5f3949ae7c', role: 'admin' };
    return true;
  }
}

@Controller()
class RotasDeTeste {
  @Get('admin')
  @UseGuards(RecusaTudo)
  admin() {
    return { ok: true };
  }

  @Get('vendas')
  @UseGuards(PoeUsuario)
  vendas() {
    return { id: 312 };
  }

  @Get('publico')
  publico() {
    return { ok: true };
  }
}

@Module({ controllers: [RotasDeTeste] })
class ModuloDeTeste implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AccessLogMiddleware).forRoutes('{*path}');
  }
}

describe('AccessLogMiddleware', () => {
  let app: INestApplication;
  let logged: string[];

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ModuloDeTeste],
    }).compile();
    app = modulo.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logged = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => jest.restoreAllMocks());

  const linhaDe = (caminho: string) =>
    logged.find((l) => l.includes(` ${caminho} `));

  it('registra a rejeição do guard, com ip e X-Request-Id', async () => {
    const resposta = await request(app.getHttpServer())
      .get('/admin')
      .set('cf-connecting-ip', '198.51.100.7')
      .set('user-agent', 'Yatsunami/8');

    expect(resposta.status).toBe(403);
    expect(resposta.headers['x-request-id']).toBeTruthy();
    const linha = linhaDe('/admin');
    expect(linha).toContain('GET /admin 403');
    expect(linha).toContain(`req=${resposta.headers['x-request-id']}`);
    expect(linha).toContain('user=anon');
  });

  it('registra id e papel de quem fez o pedido', async () => {
    await request(app.getHttpServer())
      .get('/vendas')
      .set('user-agent', 'Yatsunami/8');

    const linha = linhaDe('/vendas');
    expect(linha).toContain('GET /vendas 200');
    expect(linha).toContain('user=c627dd08-379c-4afd-a5e1-6f5f3949ae7c/admin');
    expect(linha).toContain('Yatsunami/8');
  });

  it('reutiliza o X-Request-Id recebido', async () => {
    const resposta = await request(app.getHttpServer())
      .get('/publico')
      .set('x-request-id', 'abc-123');

    expect(resposta.headers['x-request-id']).toBe('abc-123');
    expect(linhaDe('/publico')).toContain('req=abc-123');
  });

  it('marca como anônimo e registra uma linha por pedido', async () => {
    await request(app.getHttpServer()).get('/publico');

    expect(logged.filter((l) => l.includes(' /publico '))).toHaveLength(1);
    expect(linhaDe('/publico')).toContain('user=anon');
  });
});

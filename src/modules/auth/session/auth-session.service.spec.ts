import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthSessionService } from './auth-session.service';
import { formatRefreshToken, hashSecret } from './session-token.util';

const NOW = new Date('2026-09-17T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const config = {
  get: (key: string) =>
    ({
      'session.rememberIdleDays': 90,
      'session.rememberAbsoluteDays': 365,
      'session.ephemeralIdleHours': 24,
      'session.ephemeralAbsoluteDays': 7,
      'session.reuseGraceSeconds': 30,
    })[key],
} as unknown as ConfigService;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    userId: 'user-1',
    familyId: 'fam-1',
    tokenHash: hashSecret('segredo-1'),
    rememberMe: true,
    platform: 'ios',
    createdAt: new Date(NOW.getTime() - DAY),
    lastUsedAt: new Date(NOW.getTime() - DAY),
    expiresAt: new Date(NOW.getTime() + 89 * DAY),
    absoluteExpiresAt: new Date(NOW.getTime() + 364 * DAY),
    replacedById: null,
    rotatedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makePrisma(
  row: Record<string, unknown> | null = makeRow(),
  opts: { txUpdateManyResults?: Array<{ count: number }> } = {},
) {
  const txUpdateMany = opts.txUpdateManyResults
    ? jest
        .fn()
        .mockImplementationOnce(() => Promise.resolve(opts.txUpdateManyResults![0]))
        .mockImplementationOnce(() =>
          Promise.resolve(opts.txUpdateManyResults![1] ?? opts.txUpdateManyResults![0]),
        )
        .mockImplementation(() => Promise.resolve({ count: 1 }))
    : jest.fn().mockResolvedValue({ count: 1 });

  const tx = {
    authSession: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data })),
      updateMany: txUpdateMany,
    },
  };
  return {
    tx,
    authSession: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data })),
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    $transaction: jest.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
}

const validToken = formatRefreshToken('sess-1', 'segredo-1');

describe('AuthSessionService', () => {
  it('create: grava hash (não o segredo) e devolve token <id>.<segredo>', async () => {
    const prisma = makePrisma();
    const service = new AuthSessionService(prisma as never, config);

    const result = await service.create({
      userId: 'user-1',
      rememberMe: true,
      platform: 'web',
      now: NOW,
    });

    const data = prisma.authSession.create.mock.calls[0][0].data;
    const [id, secret] = result.refreshToken.split('.');
    expect(id).toBe(data.id);
    expect(data.tokenHash).toBe(hashSecret(secret));
    expect(data.familyId).toBe(data.id);
    expect(data.rememberMe).toBe(true);
    expect(result.refreshExpiresAt.getTime() - NOW.getTime()).toBe(90 * DAY);
  });

  it('rotate: sessão válida gera sucessora na mesma família e marca a atual', async () => {
    const prisma = makePrisma();
    const service = new AuthSessionService(prisma as never, config);

    const result = await service.rotate(validToken, NOW);

    expect(result.userId).toBe('user-1');
    const created = prisma.tx.authSession.create.mock.calls[0][0].data;
    expect(created.familyId).toBe('fam-1');
    expect(created.absoluteExpiresAt).toEqual(makeRow().absoluteExpiresAt);
    expect(prisma.tx.authSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', revokedAt: null, rotatedAt: null },
      data: { rotatedAt: NOW, replacedById: created.id, lastUsedAt: NOW },
    });
    expect(result.sessionId).toBe(created.id);
  });

  it('rotate: colisão concorrente faz uma única retentativa', async () => {
    const prisma = makePrisma(makeRow(), {
      txUpdateManyResults: [{ count: 0 }, { count: 1 }],
    });
    const service = new AuthSessionService(prisma as never, config);

    const result = await service.rotate(validToken, NOW);

    expect(result.userId).toBe('user-1');
    expect(prisma.tx.authSession.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.tx.authSession.create).toHaveBeenCalledTimes(1);
  });

  it('rotate: colisão persistente recusa com 401 e não cria sucessora', async () => {
    const prisma = makePrisma(makeRow(), {
      txUpdateManyResults: [{ count: 0 }, { count: 0 }],
    });
    const service = new AuthSessionService(prisma as never, config);

    await expect(service.rotate(validToken, NOW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.tx.authSession.create).not.toHaveBeenCalled();
  });

  it.each([
    ['token malformado', 'lixo', makeRow()],
    ['sessão inexistente', validToken, null],
    ['segredo errado', formatRefreshToken('sess-1', 'outro'), makeRow()],
    ['sessão revogada', validToken, makeRow({ revokedAt: NOW })],
    ['inatividade vencida', validToken, makeRow({ expiresAt: new Date(NOW.getTime() - 1) })],
    ['teto absoluto vencido', validToken, makeRow({ absoluteExpiresAt: new Date(NOW.getTime() - 1) })],
  ])('rotate: recusa %s com 401', async (_label, token, row) => {
    const prisma = makePrisma(row as never);
    const service = new AuthSessionService(prisma as never, config);

    await expect(service.rotate(token as string, NOW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.tx.authSession.create).not.toHaveBeenCalled();
  });

  it('rotate: reuso dentro da janela de 30 s emite novo par sem revogar', async () => {
    const prisma = makePrisma(
      makeRow({
        rotatedAt: new Date(NOW.getTime() - 10_000),
        replacedById: 'sess-2',
      }),
    );
    const service = new AuthSessionService(prisma as never, config);

    await expect(service.rotate(validToken, NOW)).resolves.toMatchObject({ userId: 'user-1' });
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('rotate: reuso fora da janela revoga a família e recusa', async () => {
    const prisma = makePrisma(
      makeRow({
        rotatedAt: new Date(NOW.getTime() - 31_000),
        replacedById: 'sess-2',
      }),
    );
    const service = new AuthSessionService(prisma as never, config);

    await expect(service.rotate(validToken, NOW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(prisma.tx.authSession.create).not.toHaveBeenCalled();
  });

  it('revokeFamilyByToken ignora token inválido', async () => {
    const prisma = makePrisma();
    const service = new AuthSessionService(prisma as never, config);

    await expect(service.revokeFamilyByToken('lixo')).resolves.toBeUndefined();
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('revokeFamilyByToken revoga a família quando o segredo confere', async () => {
    const prisma = makePrisma();
    const service = new AuthSessionService(prisma as never, config);

    await service.revokeFamilyByToken(validToken, NOW);

    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', revokedAt: null },
      data: { revokedAt: NOW },
    });
  });
});

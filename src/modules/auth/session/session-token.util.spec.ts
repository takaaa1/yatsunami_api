import {
  computeInitialExpiry,
  formatRefreshToken,
  generateSecret,
  hashSecret,
  parseRefreshToken,
  secretMatchesHash,
  slideExpiry,
} from './session-token.util';

const prazos = {
  rememberIdleDays: 90,
  rememberAbsoluteDays: 365,
  ephemeralIdleHours: 24,
  ephemeralAbsoluteDays: 7,
};

const DAY = 24 * 60 * 60 * 1000;

describe('session-token.util', () => {
  it('gera segredos distintos com 43 caracteres base64url', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash é SHA-256 hex e confere com o segredo', () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(secretMatchesHash(secret, hash)).toBe(true);
    expect(secretMatchesHash('outro', hash)).toBe(false);
  });

  it.each(['', 'xyz', 'ABC', 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64)])(
    'secretMatchesHash devolve false (sem lançar) para hash inválido: %p',
    (hashInvalido) => {
      expect(secretMatchesHash('qualquer', hashInvalido)).toBe(false);
    },
  );

  it('formata e lê o token <sessionId>.<segredo>', () => {
    const token = formatRefreshToken(
      '3f7c2a4e-1111-4222-8333-944455556666',
      'abc_DEF-123',
    );
    expect(parseRefreshToken(token)).toEqual({
      sessionId: '3f7c2a4e-1111-4222-8333-944455556666',
      secret: 'abc_DEF-123',
    });
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'semponto',
    '.segredo',
    'id.',
    'a.b.c',
    'x'.repeat(600),
  ])('rejeita token malformado: %p', (value) => {
    expect(parseRefreshToken(value)).toBeNull();
  });

  it('expiração inicial com lembrar-me: 90 dias de inatividade e teto de 365', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const { expiresAt, absoluteExpiresAt } = computeInitialExpiry(
      now,
      true,
      prazos,
    );
    expect(expiresAt.getTime() - now.getTime()).toBe(90 * DAY);
    expect(absoluteExpiresAt.getTime() - now.getTime()).toBe(365 * DAY);
  });

  it('expiração inicial sem lembrar-me: 24 h de inatividade e teto de 7 dias', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const { expiresAt, absoluteExpiresAt } = computeInitialExpiry(
      now,
      false,
      prazos,
    );
    expect(expiresAt.getTime() - now.getTime()).toBe(DAY);
    expect(absoluteExpiresAt.getTime() - now.getTime()).toBe(7 * DAY);
  });

  it('slideExpiry nunca passa do teto absoluto', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const absolute = new Date(now.getTime() + 10 * DAY);
    expect(slideExpiry(now, true, absolute, prazos).getTime()).toBe(
      absolute.getTime(),
    );
  });
});

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export type SessionDurations = {
  rememberIdleDays: number;
  rememberAbsoluteDays: number;
  ephemeralIdleHours: number;
  ephemeralAbsoluteDays: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TOKEN_LENGTH = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Comparação em tempo constante entre o segredo recebido e o hash salvo. */
export function secretMatchesHash(secret: string, storedHash: string): boolean {
  if (typeof storedHash !== 'string' || !SHA256_HEX.test(storedHash)) {
    return false;
  }
  const received = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return received.length === stored.length && timingSafeEqual(received, stored);
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(
  token: unknown,
): { sessionId: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [sessionId, secret] = parts;
  if (!sessionId || !secret) return null;
  return { sessionId, secret };
}

function idleMs(rememberMe: boolean, d: SessionDurations): number {
  return rememberMe
    ? d.rememberIdleDays * DAY_MS
    : d.ephemeralIdleHours * HOUR_MS;
}

export function computeInitialExpiry(
  now: Date,
  rememberMe: boolean,
  d: SessionDurations,
): { expiresAt: Date; absoluteExpiresAt: Date } {
  const absoluteMs = rememberMe
    ? d.rememberAbsoluteDays * DAY_MS
    : d.ephemeralAbsoluteDays * DAY_MS;
  const absoluteExpiresAt = new Date(now.getTime() + absoluteMs);
  return {
    expiresAt: slideExpiry(now, rememberMe, absoluteExpiresAt, d),
    absoluteExpiresAt,
  };
}

/** Nova expiração por inatividade, limitada ao teto absoluto da família. */
export function slideExpiry(
  now: Date,
  rememberMe: boolean,
  absoluteExpiresAt: Date,
  d: SessionDurations,
): Date {
  const idle = now.getTime() + idleMs(rememberMe, d);
  return new Date(Math.min(idle, absoluteExpiresAt.getTime()));
}

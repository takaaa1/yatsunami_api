import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma';
import {
  computeInitialExpiry,
  formatRefreshToken,
  generateSecret,
  hashSecret,
  parseRefreshToken,
  secretMatchesHash,
  slideExpiry,
  type SessionDurations,
} from './session-token.util';

export type IssuedRefreshToken = {
  sessionId: string;
  refreshToken: string;
  refreshExpiresAt: Date;
};

export type RotatedSession = IssuedRefreshToken & {
  userId: string;
  rememberMe: boolean;
};

const CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INVALID_SESSION = 'Sessão inválida ou expirada';
const CLEANUP_BATCH_SIZE = 5000;
const CLEANUP_MAX_BATCHES = 20;

/**
 * O compare-and-set do `updateMany` não encontrou a linha no estado lido
 * (outra requisição já rotacionou o mesmo token). Nunca escapa de `rotate()`.
 */
class ConcurrentRotationError extends Error {}

@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(input: {
    userId: string;
    rememberMe: boolean;
    platform?: string | null;
    now?: Date;
  }): Promise<IssuedRefreshToken> {
    const now = input.now ?? new Date();
    const id = randomUUID();
    const secret = generateSecret();
    const durations = this.durations();
    const { expiresAt, absoluteExpiresAt } = computeInitialExpiry(
      now,
      input.rememberMe,
      durations,
    );

    await this.prisma.authSession.create({
      data: {
        id,
        userId: input.userId,
        familyId: id,
        tokenHash: hashSecret(secret),
        rememberMe: input.rememberMe,
        platform: input.platform ?? null,
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
        absoluteExpiresAt,
      },
    });

    return {
      sessionId: id,
      refreshToken: formatRefreshToken(id, secret),
      refreshExpiresAt: expiresAt,
    };
  }

  async rotate(rawToken: string, now: Date = new Date()): Promise<RotatedSession> {
    try {
      return await this.attemptRotate(rawToken, now);
    } catch (err) {
      if (!(err instanceof ConcurrentRotationError)) throw err;

      try {
        return await this.attemptRotate(rawToken, now);
      } catch (retryErr) {
        if (retryErr instanceof ConcurrentRotationError) {
          throw new UnauthorizedException(INVALID_SESSION);
        }
        throw retryErr;
      }
    }
  }

  private async attemptRotate(
    rawToken: string,
    now: Date,
  ): Promise<RotatedSession> {
    const current = await this.findValidByToken(rawToken, now);

    if (current.rotatedAt) {
      const elapsedMs = now.getTime() - current.rotatedAt.getTime();
      // Janela curta para refresh concorrente legítimo (várias chamadas com o
      // mesmo token). Fora dela, reapresentar um token já rotacionado revoga
      // a família inteira — é o sinal de reuso indevido.
      if (elapsedMs > this.reuseGraceSeconds() * 1000) {
        this.logger.warn({
          action: 'auth.session.reuse_detected',
          familyId: current.familyId,
          userId: current.userId,
        });
        await this.revokeFamily(current.familyId, now);
        throw new UnauthorizedException(INVALID_SESSION);
      }
    }

    const nextId = randomUUID();
    const secret = generateSecret();
    const expiresAt = slideExpiry(
      now,
      current.rememberMe,
      current.absoluteExpiresAt,
      this.durations(),
    );

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.authSession.updateMany({
        where: {
          id: current.id,
          revokedAt: null,
          rotatedAt: current.rotatedAt,
        },
        data: {
          rotatedAt: current.rotatedAt ?? now,
          replacedById: nextId,
          lastUsedAt: now,
        },
      });

      if (count === 0) {
        throw new ConcurrentRotationError();
      }

      await tx.authSession.create({
        data: {
          id: nextId,
          userId: current.userId,
          familyId: current.familyId,
          tokenHash: hashSecret(secret),
          rememberMe: current.rememberMe,
          platform: current.platform,
          createdAt: now,
          lastUsedAt: now,
          expiresAt,
          absoluteExpiresAt: current.absoluteExpiresAt,
        },
      });
    });

    return {
      userId: current.userId,
      rememberMe: current.rememberMe,
      sessionId: nextId,
      refreshToken: formatRefreshToken(nextId, secret),
      refreshExpiresAt: expiresAt,
    };
  }

  /** Logout: revoga a família do token. Token inválido é ignorado. */
  async revokeFamilyByToken(
    rawToken: string,
    now: Date = new Date(),
  ): Promise<void> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) return;
    const row = await this.prisma.authSession.findUnique({
      where: { id: parsed.sessionId },
    });
    if (!row || !secretMatchesHash(parsed.secret, row.tokenHash)) return;
    await this.revokeFamily(row.familyId, now);
  }

  async revokeAllForUser(
    userId: string,
    opts: { exceptSessionId?: string; now?: Date } = {},
  ): Promise<void> {
    const now = opts.now ?? new Date();
    let exceptFamilyId: string | undefined;
    if (opts.exceptSessionId) {
      const current = await this.prisma.authSession.findUnique({
        where: { id: opts.exceptSessionId },
      });
      if (current?.userId === userId) exceptFamilyId = current.familyId;
    }
    await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { NOT: { familyId: exceptFamilyId } } : {}),
      },
      data: { revokedAt: now },
    });
  }

  async cleanup(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - CLEANUP_RETENTION_MS);
    const where = {
      OR: [
        { expiresAt: { lt: cutoff } },
        { absoluteExpiresAt: { lt: cutoff } },
        { revokedAt: { lt: cutoff } },
      ],
    };

    let total = 0;
    for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch++) {
      const rows = await this.prisma.authSession.findMany({
        where,
        select: { id: true },
        take: CLEANUP_BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const { count } = await this.prisma.authSession.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      total += count;

      if (rows.length < CLEANUP_BATCH_SIZE) break;
    }
    return total;
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async findValidByToken(rawToken: string, now: Date) {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) throw new UnauthorizedException(INVALID_SESSION);

    const row = await this.prisma.authSession.findUnique({
      where: { id: parsed.sessionId },
    });
    if (
      !row ||
      !secretMatchesHash(parsed.secret, row.tokenHash) ||
      row.revokedAt ||
      row.expiresAt.getTime() <= now.getTime() ||
      row.absoluteExpiresAt.getTime() <= now.getTime()
    ) {
      throw new UnauthorizedException(INVALID_SESSION);
    }
    return row;
  }

  private durations(): SessionDurations {
    return {
      rememberIdleDays: this.num('session.rememberIdleDays', 90),
      rememberAbsoluteDays: this.num('session.rememberAbsoluteDays', 365),
      ephemeralIdleHours: this.num('session.ephemeralIdleHours', 24),
      ephemeralAbsoluteDays: this.num('session.ephemeralAbsoluteDays', 7),
    };
  }

  private reuseGraceSeconds(): number {
    return this.num('session.reuseGraceSeconds', 30);
  }

  private num(key: string, fallback: number): number {
    const raw = Number(this.config.get(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isCronEnabled } from '../runtime/runtime.config';

@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);

  constructor(private readonly prisma: PrismaService) {}

  enabled(): boolean {
    return isCronEnabled();
  }

  /**
   * Roda `fn` só se esta instância conseguir o advisory lock `lockKey`.
   *
   * O lock é de **transação** e o trabalho roda dentro dela: o PostgreSQL o
   * solta no commit/rollback, na mesma conexão em que foi pego. A versão
   * anterior usava lock de sessão com unlock numa chamada solta — com pool de
   * várias conexões, o unlock podia cair noutra sessão e o lock ficava preso,
   * fazendo as outras instâncias pularem o job (code review 2026-11).
   *
   * A transação só segura o lock: o `fn` continua usando `this.prisma` (outras
   * conexões do pool). Por isso ela fica aberta e ociosa enquanto o job roda,
   * e o `timeout` precisa cobrir o job mais longo.
   */
  async withLock(
    lockKey: number,
    jobName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (!this.enabled()) {
      return;
    }

    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ adquirido: boolean }[]>`
                    SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS "adquirido"
                `;
        if (rows[0]?.adquirido !== true) {
          this.logger.debug(
            `Cron "${jobName}" skipped — advisory lock ${lockKey} held by another instance`,
          );
          return;
        }
        await fn();
      },
      { timeout: CRON_LOCK_TIMEOUT_MS },
    );
  }
}

/** Teto de duração de um job sob lock. Passou disso, a transação é abortada e o lock solto. */
const CRON_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

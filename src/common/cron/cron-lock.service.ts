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

    async withLock(lockKey: number, jobName: string, fn: () => Promise<void>): Promise<void> {
        if (!this.enabled()) {
            return;
        }

        const acquired = await this.tryAcquire(lockKey);
        if (!acquired) {
            this.logger.debug(`Cron "${jobName}" skipped — advisory lock ${lockKey} held by another instance`);
            return;
        }

        try {
            await fn();
        } finally {
            await this.release(lockKey);
        }
    }

    private async tryAcquire(lockKey: number): Promise<boolean> {
        const rows = await this.prisma.$queryRaw<{ pg_try_advisory_lock: boolean }[]>`
            SELECT pg_try_advisory_lock(${lockKey}::bigint) AS "pg_try_advisory_lock"
        `;
        return rows[0]?.pg_try_advisory_lock === true;
    }

    private async release(lockKey: number): Promise<void> {
        await this.prisma.$queryRaw`
            SELECT pg_advisory_unlock(${lockKey}::bigint)
        `;
    }
}

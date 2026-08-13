import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import {
  BackgroundJobRecord,
  BackgroundJobStatus,
} from './background-job.types';
import { CronLockService } from '../cron/cron-lock.service';
import {
  CRON_LOCK_KEYS,
  isBackgroundJobRuntime,
} from '../runtime/runtime.config';

const JOB_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class BackgroundJobService {
  private readonly logger = new Logger(BackgroundJobService.name);
  private readonly jobs = new Map<string, BackgroundJobRecord>();

  constructor(private readonly cronLockService: CronLockService) {}

  enqueue<TResult>(name: string, fn: () => Promise<TResult>): string {
    if (!isBackgroundJobRuntime()) {
      throw new ServiceUnavailableException(
        'Background jobs exigem runtime long-running (VPS/Docker). Use o endpoint síncrono legado.',
      );
    }
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      name,
      status: 'queued',
      createdAt: new Date(),
    });

    setImmediate(() => {
      void this.run(id, fn);
    });

    return id;
  }

  fireAndForget(name: string, fn: () => Promise<void>): void {
    if (!isBackgroundJobRuntime()) {
      void fn().catch((error) => {
        this.logger.error(
          `Background job "${name}" failed (sync fallback): ${error}`,
        );
      });
      return;
    }

    setImmediate(() => {
      void (async () => {
        try {
          await fn();
        } catch (error) {
          this.logger.error(`Background job "${name}" failed: ${error}`);
        }
      })();
    });
  }

  getJob<TResult = unknown>(
    id: string,
  ): BackgroundJobRecord<TResult> | undefined {
    return this.jobs.get(id) as BackgroundJobRecord<TResult> | undefined;
  }

  getJobOrThrow<TResult = unknown>(id: string): BackgroundJobRecord<TResult> {
    const job = this.getJob<TResult>(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  toPublicStatus(job: BackgroundJobRecord) {
    return {
      id: job.id,
      name: job.name,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.completedAt?.toISOString(),
      error: job.error,
    };
  }

  @Cron(CronExpression.EVERY_HOUR)
  purgeExpiredJobs() {
    void this.cronLockService.withLock(
      CRON_LOCK_KEYS.BACKGROUND_JOB_PURGE,
      'purgeExpiredJobs',
      // Limpeza puramente em memória — sem I/O, logo sem `await`;
      // `withLock` espera uma função que devolva Promise.
      () => {
        const cutoff = Date.now() - JOB_TTL_MS;
        let removed = 0;

        for (const [id, job] of this.jobs.entries()) {
          const finishedAt =
            job.completedAt?.getTime() ?? job.createdAt.getTime();
          if (finishedAt < cutoff) {
            this.jobs.delete(id);
            removed++;
          }
        }

        if (removed > 0) {
          this.logger.log(`Purged ${removed} expired background job(s)`);
        }
        return Promise.resolve();
      },
    );
  }

  private async run<TResult>(id: string, fn: () => Promise<TResult>) {
    const job = this.jobs.get(id);
    if (!job) return;

    this.updateStatus(id, 'processing', { startedAt: new Date() });

    try {
      const result = await fn();
      this.updateStatus(id, 'completed', {
        completedAt: new Date(),
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Job ${id} (${job.name}) failed: ${message}`);
      this.updateStatus(id, 'failed', {
        completedAt: new Date(),
        error: message,
      });
    }
  }

  private updateStatus(
    id: string,
    status: BackgroundJobStatus,
    patch: Partial<BackgroundJobRecord>,
  ) {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch, { status });
  }
}

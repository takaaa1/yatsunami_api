import { BackgroundJobService } from './background-job.service';
import { CronLockService } from '../cron/cron-lock.service';

describe('BackgroundJobService', () => {
    let service: BackgroundJobService;
    let cronLockService: CronLockService;

    beforeEach(() => {
        process.env.RUNTIME_MODE = 'long-running';
        cronLockService = {
            withLock: jest.fn(async (_key, _name, fn) => fn()),
            enabled: jest.fn(() => true),
        } as unknown as CronLockService;
        service = new BackgroundJobService(cronLockService);
    });

    afterEach(() => {
        delete process.env.RUNTIME_MODE;
    });

    it('executes enqueued jobs and stores result', async () => {
        const jobId = service.enqueue('test-job', async () => ({ ok: true }));

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));

        const job = service.getJob<{ ok: boolean }>(jobId);
        expect(job?.status).toBe('completed');
        expect(job?.result).toEqual({ ok: true });
    });

    it('marks failed jobs', async () => {
        const jobId = service.enqueue('failing-job', async () => {
            throw new Error('boom');
        });

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));

        const job = service.getJob(jobId);
        expect(job?.status).toBe('failed');
        expect(job?.error).toBe('boom');
    });
});

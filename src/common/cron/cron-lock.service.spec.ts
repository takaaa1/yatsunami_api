import { CronLockService } from './cron-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('CronLockService', () => {
    const originalCronEnabled = process.env.CRON_ENABLED;

    afterEach(() => {
        if (originalCronEnabled === undefined) {
            delete process.env.CRON_ENABLED;
        } else {
            process.env.CRON_ENABLED = originalCronEnabled;
        }
        jest.restoreAllMocks();
    });

    it('skips work when crons are disabled', async () => {
        process.env.CRON_ENABLED = 'false';
        const prisma = {
            $queryRaw: jest.fn(),
        } as unknown as PrismaService;
        const service = new CronLockService(prisma);
        const fn = jest.fn();

        await service.withLock(1, 'test', fn);

        expect(fn).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('runs work when lock is acquired', async () => {
        process.env.CRON_ENABLED = 'true';
        const prisma = {
            $queryRaw: jest
                .fn()
                .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
                .mockResolvedValueOnce([]),
        } as unknown as PrismaService;
        const service = new CronLockService(prisma);
        const fn = jest.fn().mockResolvedValue(undefined);

        await service.withLock(42, 'test', fn);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });
});

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

  /**
   * Code review 2026-11: o purge usava `completedAt ?? createdAt`. Um job ainda
   * em processamento depois do TTL era apagado; quando terminava,
   * `updateStatus` não achava o registro e o resultado se perdia — o cliente
   * recebia 404 para um trabalho que continuava rodando.
   */
  describe('purgeExpiredJobs', () => {
    const DUAS_HORAS = 2 * 60 * 60 * 1000;
    const escoar = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
    };

    afterEach(() => jest.useRealTimers());

    /**
     * Verificação do review (D5): o registro de jobs é um `Map` **desta
     * instância**. Com o lock global entre instâncias, na sobreposição do
     * blue/green uma instância limpava e a outra pulava — e cada hora abria
     * uma transação no banco para um trabalho só de memória.
     */
    it('limpa a memória local sem usar o lock entre instâncias', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const jobId = service.enqueue('rapido', () => Promise.resolve(1));
      await escoar();

      jest.setSystemTime(Date.now() + DUAS_HORAS);
      service.purgeExpiredJobs();
      await escoar();

      expect(cronLockService.withLock).not.toHaveBeenCalled();
      expect(service.getJob(jobId)).toBeUndefined();
    });

    it('mantém o job em processamento mesmo depois do TTL e guarda o resultado', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      let terminar: (v: unknown) => void = () => undefined;
      const jobId = service.enqueue(
        'lento',
        () =>
          new Promise((res) => {
            terminar = res;
          }),
      );
      await escoar();
      expect(service.getJob(jobId)?.status).toBe('processing');

      jest.setSystemTime(Date.now() + DUAS_HORAS);
      service.purgeExpiredJobs();
      await escoar();

      expect(service.getJob(jobId)).toBeDefined();
      terminar({ ok: true });
      await escoar();
      expect(service.getJob(jobId)?.status).toBe('completed');
    });

    it('remove o job terminado há mais que o TTL', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const jobId = service.enqueue('rapido', () => Promise.resolve(1));
      await escoar();
      expect(service.getJob(jobId)?.status).toBe('completed');

      jest.setSystemTime(Date.now() + DUAS_HORAS);
      service.purgeExpiredJobs();
      await escoar();

      expect(service.getJob(jobId)).toBeUndefined();
    });

    it('conta o TTL a partir do fim, não da criação', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      let terminar: (v: unknown) => void = () => undefined;
      const jobId = service.enqueue(
        'longo',
        () =>
          new Promise((res) => {
            terminar = res;
          }),
      );
      await escoar();

      jest.setSystemTime(Date.now() + DUAS_HORAS);
      terminar(1);
      await escoar();
      service.purgeExpiredJobs();
      await escoar();

      expect(service.getJob(jobId)?.status).toBe('completed');
    });
  });
});

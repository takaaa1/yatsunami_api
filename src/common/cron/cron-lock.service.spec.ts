import { CronLockService } from './cron-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Code review 2026-11: o lock era de **sessão** (`pg_try_advisory_lock`) e o
 * unlock rodava em outra chamada `$queryRaw`, sem transação. Com pool de mais
 * de uma conexão, o unlock podia cair noutra sessão do PostgreSQL, devolver
 * `false` em silêncio e deixar o lock preso — as outras instâncias pulavam o
 * job até a conexão original fechar.
 *
 * Agora o lock é de **transação** (`pg_try_advisory_xact_lock`) e o trabalho
 * roda dentro da mesma `$transaction`: o lock sai sozinho no commit/rollback,
 * na mesma conexão em que entrou.
 */
type Tx = { $queryRaw: jest.Mock };

function montar(adquiriu: boolean) {
  const tx: Tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ adquirido: adquiriu }]),
  };
  const prisma = {
    $queryRaw: jest.fn(),
    // O segundo parâmetro (opções da transação) é lido pelo teste de timeout
    // via `mock.calls`; aqui só precisa existir na assinatura.
    $transaction: jest.fn(
      (fn: (t: Tx) => Promise<unknown>, opcoes?: { timeout?: number }) => {
        void opcoes;
        return fn(tx);
      },
    ),
  };
  return {
    tx,
    prisma,
    service: new CronLockService(prisma as unknown as PrismaService),
  };
}

const sqlDe = (mock: jest.Mock, chamada = 0) =>
  (mock.mock.calls[chamada][0] as TemplateStringsArray).join('?');

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
    const { prisma, service } = montar(true);
    const fn = jest.fn();

    await service.withLock(1, 'test', fn);

    expect(fn).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('pega o lock de transação e roda o trabalho dentro da mesma transação', async () => {
    process.env.CRON_ENABLED = 'true';
    const { tx, prisma, service } = montar(true);
    const ordem: string[] = [];
    tx.$queryRaw.mockImplementation(() => {
      ordem.push('lock');
      return Promise.resolve([{ adquirido: true }]);
    });
    const fn = jest.fn(() => {
      ordem.push('trabalho');
      return Promise.resolve();
    });

    await service.withLock(42, 'test', fn);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(sqlDe(tx.$queryRaw)).toContain('pg_try_advisory_xact_lock');
    expect(ordem).toEqual(['lock', 'trabalho']);
    // Nada de unlock solto fora da transação.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('não roda o trabalho quando outra instância tem o lock', async () => {
    process.env.CRON_ENABLED = 'true';
    const { service } = montar(false);
    const fn = jest.fn();

    await service.withLock(42, 'test', fn);

    expect(fn).not.toHaveBeenCalled();
  });

  it('dá à transação tempo para o job inteiro, não os 5 s padrão do Prisma', async () => {
    process.env.CRON_ENABLED = 'true';
    const { prisma, service } = montar(true);

    await service.withLock(42, 'test', () => Promise.resolve());

    const opcoes = prisma.$transaction.mock.calls[0][1] as
      | { timeout?: number }
      | undefined;
    expect(opcoes?.timeout).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('propaga a falha do trabalho (a transação faz rollback e solta o lock)', async () => {
    process.env.CRON_ENABLED = 'true';
    const { service } = montar(true);

    await expect(
      service.withLock(42, 'test', () => Promise.reject(new Error('falhou'))),
    ).rejects.toThrow('falhou');
  });
});

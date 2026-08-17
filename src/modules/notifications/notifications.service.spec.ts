import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/cron/cron-lock.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: {} },
        {
          provide: CronLockService,
          useValue: {
            enabled: () => true,
            withLock: async (_key: number, _name: string, fn: () => Promise<void>) => fn(),
          },
        },
        {
          provide: RealtimeGateway,
          useValue: { broadcast: jest.fn(), broadcastToUser: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

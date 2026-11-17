import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthSessionService } from './auth-session.service';

@Injectable()
export class AuthSessionCleanupCron {
  private readonly logger = new Logger(AuthSessionCleanupCron.name);

  constructor(private readonly sessions: AuthSessionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async limpar(): Promise<void> {
    const removed = await this.sessions.cleanup();
    if (removed > 0) {
      this.logger.log(`Sessões antigas removidas: ${removed}`);
    }
  }
}

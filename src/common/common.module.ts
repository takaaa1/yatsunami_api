import { Module, Global } from '@nestjs/common';
import { MailService } from './services/mail.service';
import { BackgroundJobService } from './jobs/background-job.service';
import { BackgroundJobController } from './jobs/background-job.controller';
import { CronLockService } from './cron/cron-lock.service';

@Global()
@Module({
    controllers: [BackgroundJobController],
    providers: [MailService, BackgroundJobService, CronLockService],
    exports: [MailService, BackgroundJobService, CronLockService],
})
export class CommonModule { }

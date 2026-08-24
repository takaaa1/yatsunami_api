import { Module } from '@nestjs/common';
import { OrderFormsService } from './order-forms.service';
import { OrderFormsController } from './order-forms.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { PdfModule } from '../pdf/pdf.module';
import { SalesModule } from '../sales/sales.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, PdfModule, SalesModule, NotificationsModule],
  controllers: [OrderFormsController],
  providers: [OrderFormsService],
  exports: [OrderFormsService],
})
export class OrderFormsModule {}

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProductsModule } from './modules/products/products.module';
import { OrdersModule } from './modules/orders/orders.module';
import { HttpExceptionFilter } from './common/filters';
import { TransformInterceptor } from './common/interceptors';
import { AccessLogMiddleware } from './common/middleware/access-log.middleware';
import { CommonModule } from './common/common.module';
import { OrderFormsModule } from './modules/order-forms/order-forms.module';
import { ConfiguracoesModule } from './modules/configuracoes/configuracoes.module';
import { ExpressOrdersModule } from './modules/express-orders/express-orders.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { SalesModule } from './modules/sales/sales.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { PdfModule } from './modules/pdf/pdf.module';
import { UsersModule } from './modules/users/users.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AppConfigModule,
    PrismaModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
    CommonModule,
    OrderFormsModule,
    ConfiguracoesModule,
    ExpressOrdersModule,
    DeliveryModule,
    SalesModule,
    ExpensesModule,
    PdfModule,
    UsersModule,
    NotificationsModule,
    DashboardModule,
    RealtimeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * Log de acesso como middleware: roda antes dos guards e vê também as
   * rejeições 401/403, que o antigo interceptor nunca recebia.
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AccessLogMiddleware).forRoutes('{*path}');
  }
}

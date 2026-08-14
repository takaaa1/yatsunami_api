import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';
import { AppModule } from './app.module';
import {
  resolveRuntimeMode,
  isCronEnabled,
} from './common/runtime/runtime.config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const runtimeMode = resolveRuntimeMode();

  if (!process.env.RUNTIME_MODE) {
    process.env.RUNTIME_MODE = runtimeMode;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Socket.IO
  app.useWebSocketAdapter(new IoAdapter(app));

  // Ficheiros estáticos: /uploads e também /api/uploads (reverse proxy que só encaminha /api)
  const uploadsPath =
    process.env.UPLOADS_PATH || path.join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadsPath, { prefix: '/uploads' });
  app.useStaticAssets(uploadsPath, { prefix: '/api/uploads' });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3000;

  // Enable CORS
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api');

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Yatsunami API')
    .setDescription(
      'API do sistema Yatsunami — gerenciamento de restaurante japonês',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token JWT obtido via POST /api/auth/login',
      },
      'JWT',
    )
    .addServer(configService.get<string>('apiUrl') || 'http://localhost:3000')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);

  logger.log(
    `Runtime: ${runtimeMode} | crons=${isCronEnabled() ? 'on' : 'off'}`,
  );
  logger.log(`🚀 Yatsunami API running on http://localhost:${port}`);
  logger.log(`📚 API endpoints available at http://localhost:${port}/api`);
  logger.log(`📖 Swagger docs at http://localhost:${port}/api/docs`);
}

void bootstrap();

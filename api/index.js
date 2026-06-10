"use strict";
/** @deprecated Produção usa VPS/Docker (dist/main.js). Vercel: só REST; crons/jobs/WS desactivados. Ver docs/RUNTIME-ARCHITECTURE.md */
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const app_module_1 = require("../src/app.module");
let cachedHandler;
async function getHandler() {
    if (!cachedHandler) {
        process.env.RUNTIME_MODE = 'serverless';
        process.env.CRON_ENABLED = 'false';

        let dbUrl = process.env.DATABASE_URL || '';
        if (dbUrl.includes('supabase.com') && dbUrl.includes('6543') && !dbUrl.includes('pgbouncer=true')) {
            const separator = dbUrl.includes('?') ? '&' : '?';
            dbUrl = `${dbUrl}${separator}pgbouncer=true&connection_limit=1`;
            process.env.DATABASE_URL = dbUrl;
        }
        const maskedUrl = dbUrl.replace(/:([^:@]+)@/, ':****@');
        const app = await core_1.NestFactory.create(app_module_1.AppModule);
        app.enableCors({
            origin: true,
            methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
            credentials: true,
        });
        app.setGlobalPrefix('api');
        app.useGlobalPipes(new common_1.ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: {
                enableImplicitConversion: true,
            },
        }));
        const swaggerConfig = new swagger_1.DocumentBuilder()
            .setTitle('Yatsunami API')
            .setDescription('API do sistema Yatsunami — gerenciamento de restaurante japonês')
            .setVersion('1.0')
            .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
            .addServer(process.env.API_URL || 'https://yatsunami-api-vercel.vercel.app')
            .build();
        const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
        swagger_1.SwaggerModule.setup('api/docs', app, document, {
            customCssUrl: [
                'https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css',
            ],
            customJs: [
                'https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js',
                'https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js',
            ],
        });
        await app.init();
        cachedHandler = app.getHttpAdapter().getInstance();
    }
    return cachedHandler;
}
exports.default = async (req, res) => {
    try {
        const handler = await getHandler();
        handler(req, res);
    }
    catch (err) {
        console.error('Vercel Execution Error:', err);
        res.status(500).json({
            statusCode: 500,
            message: 'Vercel Runtime Error',
            error: err.message,
        });
    }
};
//# sourceMappingURL=index.js.map
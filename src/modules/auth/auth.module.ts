import type { SignOptions } from 'jsonwebtoken';
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                secret: config.get<string>('jwt.secret') as string,
                signOptions: {
                    // `expiresIn` é um template literal do jsonwebtoken (ex. '7d'),
                    // não `string` — daí o cast explícito.
                    expiresIn: config.get<string>(
                        'jwt.expiration',
                        '7d',
                    ) as SignOptions['expiresIn'],
                },
            }),
        }),
        NotificationsModule,
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy],
    exports: [AuthService, JwtStrategy, JwtModule],
})
export class AuthModule { }

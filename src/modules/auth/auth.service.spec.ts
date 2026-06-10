import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
jest.mock('uuid', () => ({ v4: jest.fn(() => '00000000-0000-4000-8000-000000000001') }));

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
    hash: jest.fn().mockResolvedValue('$2b$12$mockhash'),
}));

import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma';
import { MailService } from '../../common/services/mail.service';
import { StorageService } from '../../config/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

const mockUser = {
    id: 'uuid-1',
    nome: 'João Silva',
    email: 'joao@test.com',
    role: 'user',
    tema: 'system',
    idioma: 'pt-BR',
    ativo: true,
    avatarUrl: null,
    senhaHash: '$2b$12$testhashplaceholder',
};

const mockPrisma = {
    usuario: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
    },
    codigoRecuperacao: {
        deleteMany: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    legacyPasswordHash: {
        findUnique: jest.fn().mockResolvedValue(null),
    },
};

const mockMailService = {
    sendResetCode: jest.fn().mockResolvedValue(true),
};

const mockConfigService = {
    get: jest.fn().mockReturnValue(15),
};

const mockJwtService = {
    sign: jest.fn().mockReturnValue('mock-jwt-token'),
};

const mockStorageService = {
    extractPathFromUrl: jest.fn(),
    deleteFile: jest.fn(),
    uploadFile: jest.fn(),
    getPublicUrl: jest.fn(),
};

const mockNotificationsService = {
    createAndSendNotification: jest.fn().mockResolvedValue(undefined),
};

describe('AuthService', () => {
    let service: AuthService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthService,
                { provide: PrismaService, useValue: mockPrisma },
                { provide: JwtService, useValue: mockJwtService },
                { provide: MailService, useValue: mockMailService },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: StorageService, useValue: mockStorageService },
                { provide: NotificationsService, useValue: mockNotificationsService },
            ],
        }).compile();

        service = module.get<AuthService>(AuthService);
        jest.clearAllMocks();
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrisma.legacyPasswordHash.findUnique.mockResolvedValue(null);
        (bcrypt.compare as jest.Mock).mockReset();
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('login', () => {
        it('deve retornar accessToken para credenciais válidas (bcrypt)', async () => {
            mockPrisma.usuario.findUnique.mockResolvedValue(mockUser);
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);

            const result = await service.login({ email: 'joao@test.com', password: 'senha123' });

            expect(result.accessToken).toBe('mock-jwt-token');
            expect(result.user.id).toBe('uuid-1');
            expect(mockJwtService.sign).toHaveBeenCalled();
        });

        it('deve lançar UnauthorizedException para credenciais inválidas', async () => {
            mockPrisma.usuario.findUnique.mockResolvedValue(mockUser);
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);

            await expect(
                service.login({ email: 'joao@test.com', password: 'errada' }),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('deve lançar UnauthorizedException para usuário inativo', async () => {
            mockPrisma.usuario.findUnique.mockResolvedValue({ ...mockUser, ativo: false });

            await expect(
                service.login({ email: 'joao@test.com', password: 'senha123' }),
            ).rejects.toThrow(new UnauthorizedException('Conta desativada. Entre em contato com o suporte.'));
        });
    });

    describe('deactivateOwnAccount', () => {
        it('deve desativar a conta no banco', async () => {
            mockPrisma.usuario.findUnique.mockResolvedValue(mockUser);
            mockPrisma.usuario.update.mockResolvedValue({ ...mockUser, ativo: false });

            const result = await service.deactivateOwnAccount('uuid-1');

            expect(mockPrisma.usuario.update).toHaveBeenCalledWith({
                where: { id: 'uuid-1' },
                data: { ativo: false },
            });
            expect(result.message).toBe('Conta desativada com sucesso');
        });

        it('deve lançar BadRequestException para usuário inexistente', async () => {
            mockPrisma.usuario.findUnique.mockResolvedValue(null);

            await expect(service.deactivateOwnAccount('nao-existe')).rejects.toThrow(
                BadRequestException,
            );
        });
    });
});

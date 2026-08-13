import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    Logger,
    BadRequestException,
    InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma';
import {
    LoginDto,
    RegisterDto,
    ChangePasswordDto,
    ForgotPasswordDto,
    VerifyCodeDto,
    ResetPasswordDto,
    UpdateProfileDto,
    AuthResponseDto,
} from './dto';
import { MailService } from '../../common/services/mail.service';
import { StorageService } from '../../config/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { imageUploadFileName, uploadContentType } from '../../common/utils/image-upload.util';
import { checkWerkzeugPassword } from '../../common/utils/werkzeug-password';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private prisma: PrismaService,
        private configService: ConfigService,
        private jwtService: JwtService,
        private mailService: MailService,
        private storageService: StorageService,
        private notificationsService: NotificationsService,
    ) { }

    private async notifyAdminsNewUser(user: { id: string; nome: string; email: string }) {
        try {
            const admins = await this.prisma.usuario.findMany({
                where: { role: 'admin' },
                select: { id: true },
            });
            const adminIds = admins.map(a => a.id).filter(id => id !== user.id);
            if (adminIds.length === 0) return;

            await this.notificationsService.broadcastNotification({
                usuarioIds: adminIds,
                chave: 'notification.newUserRegistered',
                parametros: {
                    userName: user.nome,
                    userEmail: user.email,
                },
                tipo: 'admin',
            });
        } catch (error) {
            this.logger.error(`Failed to notify admins about new user: ${error}`);
        }
    }

    // ─── Token ────────────────────────────────────────────────────────────────

    private generateToken(user: { id: string; email: string; role: string }): string {
        return this.jwtService.sign({
            sub: user.id,
            email: user.email,
            role: user.role,
        });
    }

    // ─── Password cascade ─────────────────────────────────────────────────────

    /**
     * Verifies password using a three-layer cascade:
     * 1. Own bcrypt hash (senhaHash) — fastest path after migration
     * 2. Supabase auth.users bcrypt hash — imported via pg_dump; covers users who logged in before migration
     * 3. LegacyPasswordHash (Werkzeug) — covers users who never logged in after the web-app → Supabase migration
     *
     * On any successful match, the password is immediately re-hashed into senhaHash so the
     * next login hits the fast path and the slower layers gradually go empty.
     */
    private async verifyAndMigratePassword(
        userId: string,
        email: string,
        password: string,
        senhaHash: string | null,
    ): Promise<boolean> {
        // 1. Own bcrypt hash
        if (senhaHash) {
            const valid = await bcrypt.compare(password, senhaHash);
            if (valid) return true;
        }

        // 2. Supabase auth.users (imported from pg_dump — may not exist in dev)
        try {
            const rows: Array<{ encrypted_password: string }> = await this.prisma.$queryRaw`
                SELECT encrypted_password
                FROM auth.users
                WHERE id = ${userId}::uuid
                LIMIT 1
            `;
            if (rows[0]?.encrypted_password) {
                const valid = await bcrypt.compare(password, rows[0].encrypted_password);
                if (valid) {
                    await this.saveBcryptHash(userId, password);
                    return true;
                }
            }
        } catch {
            // auth.users table may not exist in local dev — that's fine
        }

        // 3. Werkzeug legacy hash
        const legacy = await this.prisma.legacyPasswordHash.findUnique({ where: { email } });
        if (legacy && checkWerkzeugPassword(password, legacy.passwordHash)) {
            await this.saveBcryptHash(userId, password);
            await this.prisma.legacyPasswordHash.delete({ where: { email } });
            this.logger.log(`Legacy password migrated for: ${email}`);
            return true;
        }

        return false;
    }

    private async saveBcryptHash(userId: string, password: string): Promise<void> {
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await this.prisma.usuario.update({
            where: { id: userId },
            data: { senhaHash: hash },
        });
    }

    // ─── Auth endpoints ───────────────────────────────────────────────────────

    async login(loginDto: LoginDto): Promise<AuthResponseDto> {
        const { email, password } = loginDto;
        const emailLower = email.toLowerCase().trim();

        const user = await this.prisma.usuario.findUnique({
            where: { email: emailLower },
        });

        if (!user) {
            throw new UnauthorizedException('Credenciais inválidas');
        }

        if (!user.ativo) {
            throw new UnauthorizedException('Conta desativada. Entre em contato com o suporte.');
        }

        const authenticated = await this.verifyAndMigratePassword(
            user.id, emailLower, password, user.senhaHash,
        );

        if (!authenticated) {
            this.logger.warn(`Login failed for: ${emailLower}`);
            throw new UnauthorizedException('Credenciais inválidas');
        }

        this.logger.log(`User logged in: ${emailLower}`);

        return {
            accessToken: this.generateToken(user),
            user: {
                id: user.id,
                nome: user.nome,
                email: user.email,
                role: user.role,
                tema: user.tema,
                idioma: user.idioma,
                avatarUrl: user.avatarUrl,
            },
        };
    }

    async register(registerDto: RegisterDto): Promise<AuthResponseDto> {
        const { email, password, nome, telefone, tema, idioma } = registerDto;
        const emailLower = email.toLowerCase().trim();

        const existingUser = await this.prisma.usuario.findUnique({
            where: { email: emailLower },
        });

        if (existingUser) {
            throw new ConflictException('Email já cadastrado');
        }

        const senhaHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const id = uuidv4();

        const user = await this.prisma.usuario.create({
            data: {
                id,
                nome: nome.trim(),
                email: emailLower,
                telefone: telefone?.trim(),
                role: 'user',
                tema: tema as any,
                idioma: idioma as any,
                senhaHash,
            },
        });

        this.logger.log(`New user registered: ${emailLower}`);

        // Notify admins (push + in-app) — fire-and-forget
        void this.notifyAdminsNewUser({ id: user.id, nome: user.nome, email: user.email }).catch(
            (error) => this.logger.error(`Falha ao notificar admins do novo usuário: ${error}`),
        );

        return {
            accessToken: this.generateToken(user),
            user: {
                id: user.id,
                nome: user.nome,
                email: user.email,
                role: user.role,
                tema: user.tema,
                idioma: user.idioma,
                avatarUrl: user.avatarUrl,
            },
        };
    }

    async changePassword(
        userId: string,
        changePasswordDto: ChangePasswordDto,
    ): Promise<{ message: string }> {
        const { currentPassword, newPassword } = changePasswordDto;

        const user = await this.prisma.usuario.findUnique({
            where: { id: userId },
        });

        if (!user) {
            throw new BadRequestException('Usuário não encontrado');
        }

        const valid = await this.verifyAndMigratePassword(
            userId, user.email, currentPassword, user.senhaHash,
        );

        if (!valid) {
            throw new BadRequestException('Senha atual incorreta');
        }

        await this.saveBcryptHash(userId, newPassword);

        this.logger.log(`Password changed for user: ${user.email}`);

        return { message: 'Senha alterada com sucesso' };
    }

    async getProfile(userId: string) {
        const user = await this.prisma.usuario.findUnique({
            where: { id: userId },
            select: {
                id: true,
                nome: true,
                email: true,
                telefone: true,
                cpfCnpj: true,
                role: true,
                tema: true,
                idioma: true,
                endereco: true,
                receberNotificacoes: true,
                criadoEm: true,
                observacoes: true,
                avatarUrl: true,
                appNavegacaoPreferido: true,
            },
        });

        if (!user) {
            throw new BadRequestException('Usuário não encontrado');
        }

        return user;
    }

    async updateProfile(userId: string, updateData: UpdateProfileDto, file?: Express.Multer.File) {
        if (file) {
            const currentUser = await this.prisma.usuario.findUnique({
                where: { id: userId },
                select: { avatarUrl: true },
            });

            const contentType = uploadContentType(file);
            const fileName = imageUploadFileName(`${userId}_${Date.now()}`, contentType);

            await this.storageService.uploadFile('avatars', fileName, file.buffer, contentType);
            updateData.avatarUrl = this.storageService.getPublicUrl('avatars', fileName);

            if (currentUser?.avatarUrl) {
                try {
                    const oldPath = this.storageService.extractPathFromUrl(currentUser.avatarUrl, 'avatars');
                    if (oldPath && oldPath !== fileName) {
                        await this.storageService.deleteFile('avatars', [oldPath]);
                        this.logger.log(`Old avatar deleted: ${oldPath}`);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to delete old avatar: ${error.message}`);
                }
            }
        }

        return this.prisma.usuario.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                nome: true,
                email: true,
                telefone: true,
                role: true,
                tema: true,
                idioma: true,
                endereco: true,
                receberNotificacoes: true,
                cpfCnpj: true,
                observacoes: true,
                avatarUrl: true,
                appNavegacaoPreferido: true,
            },
        });
    }

    async uploadAvatar(userId: string, file: Express.Multer.File) {
        const currentUser = await this.prisma.usuario.findUnique({
            where: { id: userId },
            select: { avatarUrl: true },
        });

        const contentType = uploadContentType(file);
        const fileName = imageUploadFileName(`${userId}_${Date.now()}`, contentType);

        await this.storageService.uploadFile('avatars', fileName, file.buffer, contentType);
        const avatarUrl = this.storageService.getPublicUrl('avatars', fileName);

        const user = await this.prisma.usuario.update({
            where: { id: userId },
            data: { avatarUrl },
            select: { id: true, nome: true, email: true, avatarUrl: true },
        });

        if (currentUser?.avatarUrl) {
            try {
                const oldPath = this.storageService.extractPathFromUrl(currentUser.avatarUrl, 'avatars');
                if (oldPath && oldPath !== fileName) {
                    await this.storageService.deleteFile('avatars', [oldPath]);
                    this.logger.log(`Old avatar deleted: ${oldPath}`);
                }
            } catch (error) {
                this.logger.warn(`Failed to delete old avatar: ${error.message}`);
            }
        }

        return user;
    }

    async forgotPassword(forgotPasswordDto: ForgotPasswordDto): Promise<{ message: string }> {
        const { email } = forgotPasswordDto;
        const emailLower = email.toLowerCase().trim();

        const user = await this.prisma.usuario.findUnique({
            where: { email: emailLower },
        });

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expirationMinutes = this.configService.get<number>('auth.resetPasswordExpirationMinutes', 15);
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + expirationMinutes);

        await this.prisma.codigoRecuperacao.deleteMany({
            where: {
                OR: [
                    { email: emailLower },
                    { expiraEm: { lt: new Date() } },
                ],
            },
        });

        await this.prisma.codigoRecuperacao.create({
            data: { email: emailLower, codigo: code, expiraEm: expiresAt },
        });

        if (user) {
            const emailSent = await this.mailService.sendResetCode(
                user.email, code, user.nome, user.idioma,
            );
            if (emailSent) {
                this.logger.log(`Reset code sent to: ${emailLower}`);
            } else {
                this.logger.error(`Failed to send reset code email to: ${emailLower}`);
                throw new InternalServerErrorException('Erro ao enviar email de recuperação. Tente novamente mais tarde.');
            }
        } else {
            this.logger.warn(`Reset requested for non-existent email: ${emailLower}`);
        }

        return { message: 'Se o e-mail estiver cadastrado, você receberá um código' };
    }

    async verifyResetCode(verifyCodeDto: VerifyCodeDto): Promise<{ valid: boolean }> {
        const { email, codigo } = verifyCodeDto;
        const emailLower = email.toLowerCase().trim();

        const record = await this.prisma.codigoRecuperacao.findFirst({
            where: { email: emailLower, codigo, expiraEm: { gt: new Date() } },
        });

        if (!record) {
            throw new BadRequestException('Código inválido ou expirado');
        }

        return { valid: true };
    }

    async resetPassword(resetPasswordDto: ResetPasswordDto): Promise<{ message: string }> {
        const { email, codigo, newPassword } = resetPasswordDto;
        const emailLower = email.toLowerCase().trim();

        const record = await this.prisma.codigoRecuperacao.findFirst({
            where: { email: emailLower, codigo, expiraEm: { gt: new Date() } },
        });

        if (!record) {
            throw new BadRequestException('Código inválido ou expirado');
        }

        const user = await this.prisma.usuario.findUnique({
            where: { email: emailLower },
        });

        if (!user) {
            throw new BadRequestException('Usuário não encontrado');
        }

        await this.saveBcryptHash(user.id, newPassword);

        await this.prisma.codigoRecuperacao.delete({ where: { id: record.id } });

        this.logger.log(`Password successfully reset for: ${emailLower}`);

        return { message: 'Senha redefinida com sucesso' };
    }

    async deactivateOwnAccount(userId: string): Promise<{ message: string }> {
        const user = await this.prisma.usuario.findUnique({ where: { id: userId } });

        if (!user) {
            throw new BadRequestException('Usuário não encontrado');
        }

        await this.prisma.usuario.update({
            where: { id: userId },
            data: { ativo: false },
        });

        this.logger.log(`User self-deactivated: ${user.email}`);

        return { message: 'Conta desativada com sucesso' };
    }

    async deleteOwnAccount(userId: string): Promise<{ message: string }> {
        const user = await this.prisma.usuario.findUnique({ where: { id: userId } });

        if (!user) {
            throw new BadRequestException('Usuário não encontrado');
        }

        if (user.avatarUrl) {
            try {
                const avatarPath = this.storageService.extractPathFromUrl(user.avatarUrl, 'avatars');
                if (avatarPath) {
                    await this.storageService.deleteFile('avatars', [avatarPath]);
                }
            } catch (error) {
                this.logger.warn(`Failed to delete avatar for user ${userId}: ${error.message}`);
            }
        }

        await this.prisma.usuario.update({
            where: { id: userId },
            data: {
                nome: `${user.nome} (Usuário Excluído)`,
                email: `deleted_${userId}@deleted.yatsunami`,
                telefone: null,
                endereco: [],
                avatarUrl: null,
                expoPushToken: null,
                senhaHash: null,
                ativo: false,
            },
        });

        this.logger.log(`User permanently anonymized: ${user.email}`);

        return { message: 'Conta excluída com sucesso' };
    }
}

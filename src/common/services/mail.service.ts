import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(private configService: ConfigService) {
    this.fromEmail =
      this.configService.get<string>('mail.fromEmail') ||
      'no-reply@yatsunami.com.br';
    this.fromName =
      this.configService.get<string>('mail.fromName') || 'Yatsunami';

    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('mail.host'),
      port: this.configService.get<number>('mail.port'),
      secure: false, // true for 465, false for other ports
      auth: {
        user: this.configService.get<string>('mail.user'),
        pass: this.configService.get<string>('mail.password'),
      },
    });
  }

  async sendResetCode(
    email: string,
    code: string,
    name: string,
    language: string = 'pt-BR',
  ): Promise<boolean> {
    const expiration =
      this.configService.get<number>('auth.resetPasswordExpirationMinutes') ??
      15;

    // Debug log (temporary)
    const mailHost = this.configService.get<string>('mail.host');
    this.logger.log(
      `[Attempt] Sending to ${email} (${language}) via ${mailHost}`,
    );

    const subject =
      language === 'ja-JP'
        ? 'Yatsunami - パスワードの再設定'
        : 'Yatsunami - Recuperação de Senha';

    const html = this.getResetPasswordTemplate(
      code,
      name,
      language,
      expiration,
    );

    try {
      // `SentMessageInfo` é `any` no próprio @types/nodemailer; estreitamos
      // para o único campo que lemos.
      const info = (await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: subject,
        html: html,
      })) as { messageId?: string };

      this.logger.log(`Email sent: ${info.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private getResetPasswordTemplate(
    code: string,
    name: string,
    language: string,
    expiration: number,
  ): string {
    const isJp = language === 'ja-JP';

    const texts = {
      title: isJp ? 'パスワードの再設定' : 'Recuperação de Senha',
      greeting: isJp ? `${name} 様、` : `Olá, ${name}`,
      intro: isJp
        ? 'Yatsunamiアカウントのパスワード再設定がリクエストされました。'
        : 'Você solicitou a recuperação de senha para sua conta no Yatsunami.',
      codeLabel: isJp ? '確認コード：' : 'Seu código de verificação é:',
      expiry: isJp
        ? `このコードは${expiration}分間有効です。`
        : `Este código expira em ${expiration} minutos.`,
      ignore: isJp
        ? 'お心当たりがない場合は、このメールを無視してください。'
        : 'Se você não solicitou isso, por favor ignore este e-mail.',
      regards: isJp ? 'Yatsunamiチーム' : 'Atenciosamente,<br>Equipe Yatsunami',
    };

    return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; color: #333333;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-top: 20px; margin-bottom: 20px;">
                    
                    <!-- Header -->
                    <div style="background-color: #D32F2F; padding: 20px; text-align: center;">
                        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">Yatsunami</h1>
                    </div>

                    <!-- Content -->
                    <div style="padding: 30px 20px;">
                        <h2 style="color: #D32F2F; margin-top: 0; font-size: 20px;">${texts.title}</h2>
                        
                        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 20px;">
                            ${texts.greeting}
                        </p>
                        
                        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 20px;">
                            ${texts.intro}
                        </p>
                        
                        <p style="font-size: 14px; font-weight: bold; margin-bottom: 10px; color: #555;">
                            ${texts.codeLabel}
                        </p>

                        <!-- Code Box -->
                        <div style="background-color: #f8f9fa; border: 2px dashed #D32F2F; border-radius: 8px; padding: 15px; text-align: center; margin: 20px 0;">
                            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333; user-select: all; cursor: pointer;">
                                ${code}
                            </span>
                        </div>

                        <p style="font-size: 14px; color: #666; margin-bottom: 10px;">
                            ${texts.expiry}
                        </p>
                        
                        <p style="font-size: 14px; color: #999; margin-top: 30px; font-style: italic;">
                            ${texts.ignore}
                        </p>
                    </div>

                    <!-- Footer -->
                    <div style="background-color: #eeeeee; padding: 20px; text-align: center; font-size: 12px; color: #777;">
                        <p style="margin: 0;">${texts.regards}</p>
                        <p style="margin: 5px 0 0 0;">&copy; ${new Date().getFullYear()} Yatsunami</p>
                    </div>
                </div>
            </body>
            </html>
        `;
  }
}

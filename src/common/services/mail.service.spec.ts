import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

/**
 * Code review 2026-11: com `secure: false` e sem `requireTLS`, o Nodemailer só
 * sobe para TLS se o servidor anunciar STARTTLS. Quem estiver no meio do
 * caminho pode apagar o anúncio, e usuário/senha do SMTP e o código de
 * redefinição de senha seguiam em texto puro. Com `requireTLS`, o envio falha
 * em vez de degradar.
 */
describe('MailService — transporte SMTP', () => {
  const opcoesDoTransporte = (porta: number) => {
    const config = {
      get: (chave: string) =>
        ({
          'mail.host': 'smtp.exemplo',
          'mail.port': porta,
          'mail.user': 'u',
          'mail.password': 'p',
        })[chave],
    } as unknown as ConfigService;
    new MailService(config);
    const chamadas = (nodemailer.createTransport as jest.Mock).mock.calls;
    return chamadas[chamadas.length - 1][0] as {
      secure?: boolean;
      requireTLS?: boolean;
    };
  };

  it('exige STARTTLS na porta 587', () => {
    const opcoes = opcoesDoTransporte(587);

    expect(opcoes.secure).toBe(false);
    expect(opcoes.requireTLS).toBe(true);
  });

  it('usa TLS direto na porta 465', () => {
    expect(opcoesDoTransporte(465).secure).toBe(true);
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy, JwtPayload } from './jwt.strategy';
import { PrismaService } from '../../../prisma';

/**
 * O portão de entrada de toda requisição autenticada.
 *
 * Um token continua criptograficamente válido depois que a conta é desativada
 * ou apagada — nada no JWT muda. Quem barra é esta consulta ao banco, a cada
 * requisição. Se ela sumir numa reescrita, contas desativadas voltam a
 * funcionar até o token expirar, e nada acusa.
 *
 * Este comportamento era o único valor real do `app.e2e-spec.ts`, que precisava
 * de um banco de pé e de um JWT de admin colado numa variável de ambiente — e
 * que, sem elas, se pulava sozinho e passava sem testar nada.
 */

const PAYLOAD: JwtPayload = {
  sub: 'uuid-1',
  email: 'fulano@exemplo.com',
  role: 'CLIENTE',
};

const USUARIO = {
  id: 'uuid-1',
  nome: 'Fulano',
  email: 'fulano@exemplo.com',
  role: 'CLIENTE',
  ativo: true,
};

describe('JwtStrategy.validate', () => {
  let strategy: JwtStrategy;
  let findUnique: jest.Mock;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(USUARIO);
    const config = {
      get: () => 'segredo-de-teste',
    } as unknown as ConfigService;
    const prisma = { usuario: { findUnique } } as unknown as PrismaService;

    strategy = new JwtStrategy(config, prisma);
  });

  it('devolve o usuário quando a conta está ativa', async () => {
    await expect(strategy.validate(PAYLOAD)).resolves.toEqual(USUARIO);
  });

  /** Conta desativada: o token ainda é válido, o portão é este. */
  it('recusa conta desativada', async () => {
    findUnique.mockResolvedValue({ ...USUARIO, ativo: false });

    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  /** Conta apagada de vez: o token sobrevive ao registro. */
  it('recusa usuário que não existe mais', async () => {
    findUnique.mockResolvedValue(null);

    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  /**
   * A consulta é por `sub`, nunca pelo `email` ou `role` do token. Confiar nos
   * outros campos seria confiar no que o portador mandou.
   */
  it('busca pelo sub do token', async () => {
    await strategy.validate(PAYLOAD);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'uuid-1' } }),
    );
  });

  /** A senha não pode sair daqui: o retorno vira `request.user`. */
  it('não seleciona campos sensíveis', async () => {
    await strategy.validate(PAYLOAD);

    const select = (
      findUnique.mock.calls[0][0] as { select: Record<string, unknown> }
    ).select;
    expect(select).not.toHaveProperty('senha');
    expect(select).not.toHaveProperty('password');
    expect(select.ativo).toBe(true);
  });
});

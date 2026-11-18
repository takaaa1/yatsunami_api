import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

/**
 * Booleanos de `PATCH /users/:id`.
 *
 * O transform antigo (`value === 'true' || value === true`) convertia qualquer
 * coisa desconhecida em `false` — `"ativo": "invalid"` desativava a conta em
 * vez de ser recusado, porque `@IsBoolean()` só via o valor já convertido.
 */
async function converter(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateUserDto, payload);
  const erros = await validate(dto);
  return { dto, campos: erros.map((e) => e.property) };
}

describe('UpdateUserDto — booleanos', () => {
  it.each([
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
  ])('aceita %p como %p', async (entrada, esperado) => {
    const { dto, campos } = await converter({
      ativo: entrada,
      receberNotificacoes: entrada,
    });
    expect(campos).toEqual([]);
    expect(dto.ativo).toBe(esperado);
    expect(dto.receberNotificacoes).toBe(esperado);
  });

  it.each(['invalid', 1, 0, 'sim'])(
    'rejeita %p em vez de virar false',
    async (entrada) => {
      const { campos } = await converter({
        ativo: entrada,
        receberNotificacoes: entrada,
      });
      expect(campos.sort()).toEqual(['ativo', 'receberNotificacoes']);
    },
  );

  it('campo ausente continua ausente', async () => {
    const { dto, campos } = await converter({ nome: 'Ana' });
    expect(campos).toEqual([]);
    expect(dto.ativo).toBeUndefined();
    expect(dto.receberNotificacoes).toBeUndefined();
  });
});

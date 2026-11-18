import { ValidationPipe } from '@nestjs/common';
import { UpdateProductDto } from './update-product.dto';

/**
 * O app passa a mandar o `id` de cada variedade na edição, para a API
 * atualizar no lugar em vez de recriar (decisão D1 da verificação do review).
 * O `UpdateProductDto` herdava as variedades do DTO de criação, sem `id`, e o
 * `ValidationPipe` global usa `forbidNonWhitelisted`: o campo era recusado.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validar = (corpo: unknown) =>
  pipe.transform(corpo, {
    type: 'body',
    metatype: UpdateProductDto,
  }) as Promise<UpdateProductDto>;

const variedade = (extra: Record<string, unknown> = {}) => ({
  nome: { 'pt-BR': 'Grande', 'ja-JP': '大' },
  preco: 20,
  ...extra,
});

describe('UpdateProductDto — variedades', () => {
  it('aceita e preserva o id da variedade', async () => {
    const dto = await validar({ variedades: [variedade({ id: 11 })] });

    expect(dto.variedades?.[0]).toMatchObject({ id: 11, preco: 20 });
  });

  it('continua aceitando variedade sem id (nova, ou app antigo)', async () => {
    const dto = await validar({ variedades: [variedade()] });

    expect(dto.variedades?.[0].id).toBeUndefined();
  });

  it('recusa id que não é número', async () => {
    await expect(
      validar({ variedades: [variedade({ id: 'abc' })] }),
    ).rejects.toBeDefined();
  });
});

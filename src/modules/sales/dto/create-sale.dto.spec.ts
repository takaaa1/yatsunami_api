import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSaleDto } from './create-sale.dto';

/**
 * Validação de entrada de `POST /sales`.
 *
 * Quantidade, preço unitário e taxa de entrega negativos (ou quantidade zero)
 * passavam pelos decoradores e geravam vendas com total incoerente —
 * `resumirVenda` corta a linha em zero, mas grava o valor negativo.
 */
async function errosDe(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreateSaleDto, payload);
  const erros = await validate(dto);
  const caminhos: string[] = [];
  const visitar = (lista: typeof erros, prefixo: string) => {
    for (const e of lista) {
      const caminho = prefixo ? `${prefixo}.${e.property}` : e.property;
      if (e.constraints) caminhos.push(caminho);
      if (e.children?.length) visitar(e.children, caminho);
    }
  };
  visitar(erros, '');
  return caminhos;
}

const item = (sobrescrever: Record<string, unknown> = {}) => ({
  produtoId: 1,
  quantidade: 2,
  precoUnitario: 10,
  ...sobrescrever,
});

describe('CreateSaleDto', () => {
  it('aceita uma venda válida', async () => {
    expect(await errosDe({ itens: [item()], taxaEntrega: 5 })).toEqual([]);
  });

  it('aceita item gratuito (precoUnitario = 0) e taxa de entrega zero', async () => {
    expect(
      await errosDe({ itens: [item({ precoUnitario: 0 })], taxaEntrega: 0 }),
    ).toEqual([]);
  });

  it('aceita quantidade fracionária positiva', async () => {
    expect(await errosDe({ itens: [item({ quantidade: 0.5 })] })).toEqual([]);
  });

  it.each([0, -1])('rejeita quantidade %p', async (quantidade) => {
    expect(await errosDe({ itens: [item({ quantidade })] })).toEqual([
      'itens.0.quantidade',
    ]);
  });

  it('rejeita precoUnitario negativo', async () => {
    expect(await errosDe({ itens: [item({ precoUnitario: -10 })] })).toEqual([
      'itens.0.precoUnitario',
    ]);
  });

  it('rejeita taxaEntrega negativa', async () => {
    expect(await errosDe({ itens: [item()], taxaEntrega: -20 })).toEqual([
      'taxaEntrega',
    ]);
  });
});

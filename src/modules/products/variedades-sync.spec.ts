import { planejarVariedades } from './variedades-sync';

/**
 * Edição de variedades sem recriar tudo.
 *
 * Antes, todo `PATCH /products/:id` com `variedades` fazia `deleteMany` +
 * `create`. As FKs de `itens_pedido_encomenda`, `itens_pedido_direto`,
 * `itens_venda` e `produtos_encomenda` são `ON DELETE SET NULL`: cada edição
 * de produto (até trocar o preço) apagava a variedade de todo o histórico.
 * Agora cada variedade recebida é casada com a existente e atualizada no
 * lugar, mantendo o `id`.
 */
const nome = (pt: string, ja = pt) => ({ 'pt-BR': pt, 'ja-JP': ja });
const existentes = [
  { id: 10, nome: nome('Pequeno') },
  { id: 11, nome: nome('Grande') },
];

describe('planejarVariedades', () => {
  it('casa pelo id e atualiza no lugar', () => {
    const plano = planejarVariedades(existentes, [
      { id: 10, nome: nome('Pequeno'), preco: 12 },
      { id: 11, nome: nome('Grande'), preco: 20 },
    ]);

    expect(plano.atualizar.map((a) => a.id)).toEqual([10, 11]);
    expect(plano.criar).toEqual([]);
    expect(plano.remover).toEqual([]);
  });

  it('renomear mantém o id quando ele vem no corpo', () => {
    const plano = planejarVariedades(existentes, [
      { id: 10, nome: nome('Mini') },
      { id: 11, nome: nome('Grande') },
    ]);

    expect(plano.atualizar.map((a) => a.id)).toEqual([10, 11]);
    expect(plano.criar).toEqual([]);
  });

  it('sem id (build antigo do app), casa pelo nome em pt-BR', () => {
    const plano = planejarVariedades(existentes, [
      { nome: nome('  grande ') },
      { nome: nome('Pequeno') },
    ]);

    expect(plano.atualizar.map((a) => a.id)).toEqual([11, 10]);
    expect(plano.criar).toEqual([]);
    expect(plano.remover).toEqual([]);
  });

  it('variedade nova é criada', () => {
    const plano = planejarVariedades(existentes, [
      { id: 10, nome: nome('Pequeno') },
      { id: 11, nome: nome('Grande') },
      { nome: nome('Família') },
    ]);

    expect(plano.criar).toEqual([{ nome: nome('Família') }]);
  });

  it('variedade que saiu da lista vai para remoção', () => {
    const plano = planejarVariedades(existentes, [
      { id: 11, nome: nome('Grande') },
    ]);

    expect(plano.remover).toEqual([10]);
  });

  it('id de outro produto não é aceito: vira criação', () => {
    const plano = planejarVariedades(existentes, [
      { id: 999, nome: nome('Intrusa') },
    ]);

    expect(plano.atualizar).toEqual([]);
    expect(plano.criar).toEqual([{ nome: nome('Intrusa') }]);
    expect(plano.remover).toEqual([10, 11]);
  });

  it('a mesma existente não é casada duas vezes', () => {
    const plano = planejarVariedades(existentes, [
      { id: 10, nome: nome('Pequeno') },
      { nome: nome('Pequeno') },
    ]);

    expect(plano.atualizar.map((a) => a.id)).toEqual([10]);
    expect(plano.criar).toHaveLength(1);
    expect(plano.remover).toEqual([11]);
  });
});

import { Prisma } from '@prisma/client';
import { nomesDoItem } from './nomes-do-item';

/**
 * Histórico concreto (verificação do review, D1): todo item de venda, pedido
 * encomenda ou pedido direto guarda o nome do produto e da variedade no
 * momento em que foi criado, como já guarda o preço.
 */
const produto = {
  nome: { 'pt-BR': 'BENTO', 'ja-JP': '弁当' },
  variedades: [{ id: 9, nome: { 'pt-BR': 'Grande', 'ja-JP': '大' } }],
};

describe('nomesDoItem', () => {
  it('copia o nome do produto e o da variedade escolhida', () => {
    expect(nomesDoItem(produto, 9)).toEqual({
      produtoNome: produto.nome,
      variedadeNome: produto.variedades[0].nome,
    });
  });

  it('sem variedade grava NULL no banco (DbNull), não o JSON null', () => {
    expect(nomesDoItem(produto, null).variedadeNome).toBe(Prisma.DbNull);
    expect(nomesDoItem(produto, undefined).variedadeNome).toBe(Prisma.DbNull);
  });

  it('variedade que não é do produto não vira nome', () => {
    expect(nomesDoItem(produto, 999).variedadeNome).toBe(Prisma.DbNull);
  });
});

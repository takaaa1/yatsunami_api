import { Prisma } from '@prisma/client';

/**
 * Cópia dos nomes para gravar num item de venda, pedido encomenda ou pedido
 * direto — o "histórico concreto" (verificação do code review 2026-11, D1).
 *
 * O item já guardava o preço do momento (`precoUnitario`); agora guarda também
 * o nome do produto e o da variedade. Renomear, desativar ou excluir algo no
 * catálogo não muda o que o histórico mostra.
 *
 * Sem variedade, o campo vai como `Prisma.DbNull` (NULL na coluna): para um
 * campo `Json?`, `null` simples não é aceito e `JsonNull` gravaria o JSON
 * `null`.
 */
export function nomesDoItem(
  produto: {
    nome: Prisma.JsonValue;
    variedades?: { id: number; nome: Prisma.JsonValue }[];
  },
  variedadeId: number | null | undefined,
): {
  produtoNome: Prisma.InputJsonValue;
  variedadeNome: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  const variedade =
    variedadeId != null
      ? produto.variedades?.find((v) => v.id === variedadeId)
      : undefined;
  return {
    produtoNome: produto.nome as Prisma.InputJsonValue,
    variedadeNome:
      (variedade?.nome as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
  };
}

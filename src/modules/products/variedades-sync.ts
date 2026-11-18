/**
 * Plano de sincronização das variedades de um produto na edição.
 *
 * Substitui o antigo `deleteMany` + `create`, que trocava o `id` de todas as
 * variedades a cada edição — e, pelas FKs `ON DELETE SET NULL`, apagava a
 * variedade de todo o histórico de pedidos, vendas e formulários.
 *
 * Casamento, nesta ordem:
 * 1. pelo `id`, se ele pertence a este produto;
 * 2. sem `id` (builds do app anteriores a esta mudança não o enviam), pelo
 *    nome em pt-BR, sem caixa e sem espaços nas pontas;
 * 3. sem par: variedade nova.
 * Existentes que ninguém casou saem da lista (`remover`). Cada existente casa
 * no máximo uma vez.
 */
export interface PlanoVariedades<R> {
  atualizar: { id: number; dados: R }[];
  criar: R[];
  remover: number[];
}

const chaveDoNome = (nome: unknown): string => {
  if (!nome || typeof nome !== 'object') return '';
  const pt = (nome as Record<string, unknown>)['pt-BR'];
  return typeof pt === 'string' ? pt.trim().toLowerCase() : '';
};

export function planejarVariedades<R extends { id?: number; nome?: unknown }>(
  existentes: { id: number; nome: unknown }[],
  recebidas: R[],
): PlanoVariedades<R> {
  const livres = new Map(existentes.map((e) => [e.id, e]));
  const plano: PlanoVariedades<R> = { atualizar: [], criar: [], remover: [] };
  const semPar: R[] = [];

  // Primeiro todos os ids: um nome repetido não pode roubar a existente que
  // outra recebida reivindica pelo id.
  for (const r of recebidas) {
    if (r.id != null && livres.has(r.id)) {
      plano.atualizar.push({ id: r.id, dados: r });
      livres.delete(r.id);
    } else {
      semPar.push(r);
    }
  }

  for (const r of semPar) {
    const chave = r.id == null ? chaveDoNome(r.nome) : '';
    const par = chave
      ? [...livres.values()].find((e) => chaveDoNome(e.nome) === chave)
      : undefined;
    if (par) {
      plano.atualizar.push({ id: par.id, dados: r });
      livres.delete(par.id);
    } else {
      // `id` estranho a este produto é descartado: nunca se atualiza variedade
      // de outro produto pelo corpo da requisição.
      const { id: _ignorado, ...semId } = r;
      void _ignorado;
      plano.criar.push(semId as R);
    }
  }

  plano.remover = [...livres.keys()];
  return plano;
}

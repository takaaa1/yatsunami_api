/**
 * View-models consumidos pelo `PdfService`.
 *
 * Declaram apenas o que o gerador de PDF realmente lê — propositalmente mais
 * frouxos que os tipos do Prisma, porque os controllers passam registros com
 * `include`s variados e valores `Decimal` já serializados.
 */

/**
 * Campo traduzível. É uma coluna JSON no Prisma (`JsonValue`), então o tipo
 * é `unknown` de propósito — `getLocalizedText` faz a checagem em runtime.
 */
export type LocalizedField = unknown;

/** Valor numérico vindo do Prisma (`Decimal` serializa como string). */
export type NumericLike = number | string | { toString(): string };

export interface PdfSaleItem {
    quantidade: NumericLike | null;
    /** Pode vir nulo em registros antigos. */
    precoUnitario: NumericLike | null;
    produto?: { nome?: LocalizedField } | null;
    variedade?: { nome?: LocalizedField } | null;
    /** Nome já resolvido, quando o chamador monta o item manualmente. */
    nome?: LocalizedField;
    produtoId?: number;
    variedadeId?: number | null;
    /** `percentual` ou `valor`; ausente quando não há desconto no item. */
    tipoDesconto?: string | null;
    valorDesconto?: NumericLike | null;
}

export interface PdfSale {
    id: number;
    data: Date | string;
    total: NumericLike | null;
    observacoes?: string | null;
    descontoGeralTipo?: string | null;
    descontoGeralValor?: NumericLike | null;
    itens: PdfSaleItem[];
}

export interface PdfOrder {
    usuario?: { nome?: string | null } | null;
    itens: PdfSaleItem[];
}

/** Resumo consolidado de encomendas de uma data. */
export interface PdfOrderSummary {
    date: Date | string;
    orders: PdfOrder[];
}

/** Linha consolidada por produto+variedade no resumo. */
export interface ConsolidatedItem {
    nome: string;
    variedade: string;
    quantidade: number;
}

import { Prisma } from '@prisma/client';
import { DiscountType } from './dto/create-sale.dto';

/**
 * A regra de dinheiro da venda — uma definição só.
 *
 * Ela vivia em duas cópias que discordavam: `sales.service.ts`, que grava o
 * total, e `pdf.service.ts`, que desenhava as linhas do recibo com `Number`.
 * O recibo era o lado errado, e o erro era visível ao cliente: as linhas não
 * fechavam com o total impresso logo abaixo delas, que vem do banco.
 *
 * Os descontos saem **efetivos**, nunca nominais. Um desconto de R$ 50 num
 * item de R$ 10 tira R$ 10 — é o corte em zero que manda. Devolver os R$ 50 é
 * o que fazia as contas do recibo não fecharem.
 */

/** Valor numérico como chega do Prisma ou do DTO. */
export type ValorNumerico =
  | number
  | string
  | { toString(): string }
  | null
  | undefined;

export interface LinhaDeVenda {
  quantidade: ValorNumerico;
  precoUnitario: ValorNumerico;
  tipoDesconto?: string | null;
  valorDesconto?: ValorNumerico;
}

export interface AjustesDaVenda {
  descontoGeralTipo?: string | null;
  descontoGeralValor?: ValorNumerico;
  taxaEntrega?: ValorNumerico;
}

export interface ResumoDaVenda {
  /** Soma dos itens a preço cheio. */
  subtotal: Prisma.Decimal;
  /** Quanto os descontos de item de fato tiraram. */
  descontoItens: Prisma.Decimal;
  /** Quanto o desconto geral de fato tirou. */
  descontoGeral: Prisma.Decimal;
  taxaEntrega: Prisma.Decimal;
  total: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

// Alargados para `string`: `tipoDesconto` chega solto do Prisma e dos tipos do
// PDF, e comparar `string` com `enum` direto é erro de lint. A fonte da
// verdade continua sendo o enum.
const PERCENTUAL: string = DiscountType.PERCENTAGE;
const FIXO: string = DiscountType.FIXED;

/** `Decimal` tolerante: nulo, indefinido e texto inválido viram zero. */
function dec(valor: ValorNumerico): Prisma.Decimal {
  if (valor === null || valor === undefined || valor === '') return ZERO;
  // `Decimal` do Prisma serializa como string e alguns chamadores passam o
  // próprio objeto; `String()` cobre os três casos.
  try {
    return new Prisma.Decimal(
      typeof valor === 'number' ? valor : String(valor),
    );
  } catch {
    return ZERO;
  }
}

/**
 * Calcula o resumo de uma venda.
 *
 * Garante, para qualquer entrada:
 *
 *     subtotal − descontoItens − descontoGeral + taxaEntrega === total
 */
export function resumirVenda(
  itens: LinhaDeVenda[],
  ajustes: AjustesDaVenda = {},
): ResumoDaVenda {
  let subtotal = ZERO;
  let liquidoDosItens = ZERO;

  for (const linha of itens) {
    const preco = dec(linha.precoUnitario);
    const quantidade = dec(linha.quantidade);
    const valorDesconto = dec(linha.valorDesconto);
    const bruto = preco.mul(quantidade);

    let liquido = bruto;
    if (linha.tipoDesconto === PERCENTUAL) {
      liquido = bruto.sub(preco.mul(valorDesconto).div(100).mul(quantidade));
    } else if (linha.tipoDesconto === FIXO) {
      liquido = bruto.sub(valorDesconto.mul(quantidade));
    }

    // O corte é por item, antes da soma: um item exagerado não pode comer o
    // valor dos outros.
    if (liquido.lt(0)) liquido = ZERO;

    subtotal = subtotal.add(bruto);
    liquidoDosItens = liquidoDosItens.add(liquido);
  }

  const descontoItens = subtotal.sub(liquidoDosItens);

  const valorGeral = dec(ajustes.descontoGeralValor);
  let depoisDoGeral = liquidoDosItens;
  if (ajustes.descontoGeralTipo && valorGeral.gt(0)) {
    depoisDoGeral =
      ajustes.descontoGeralTipo === PERCENTUAL
        ? liquidoDosItens.sub(liquidoDosItens.mul(valorGeral).div(100))
        : liquidoDosItens.sub(valorGeral);
  }
  if (depoisDoGeral.lt(0)) depoisDoGeral = ZERO;

  const descontoGeral = liquidoDosItens.sub(depoisDoGeral);

  // A taxa entra depois do corte em zero: um desconto grande não pode engolir
  // o frete e fazer o estabelecimento pagar a entrega do próprio bolso.
  const taxaEntrega = dec(ajustes.taxaEntrega);

  return {
    subtotal,
    descontoItens,
    descontoGeral,
    taxaEntrega,
    total: depoisDoGeral.add(taxaEntrega),
  };
}

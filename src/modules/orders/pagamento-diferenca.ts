/**
 * Contas do pagamento da diferença via PIX — lógica pura, sem Prisma, para os
 * fluxos do `OrdersService` apenas consultarem. Regras e motivo em
 * `docs/PAGAMENTO-DIFERENCA-PIX.md` (raiz do workspace).
 *
 * Tudo é feito em **centavos inteiros**: somar e subtrair reais em `number`
 * acumula erro de ponto flutuante, e aqui o resultado vira cobrança ou reembolso.
 */

/** Decimal do Prisma, número ou a string que o Decimal serializa. */
export type Valor = number | string | { toString(): string } | null | undefined;

/** Qual QR o cliente escolheu pagar. */
export type EscolhaDoCliente = 'diferenca' | 'total';
export const ESCOLHAS_DO_CLIENTE: readonly EscolhaDoCliente[] = [
  'diferenca',
  'total',
];

/** `integral` é o primeiro pagamento, quando ainda não havia nada pago. */
export type TipoComprovante = 'integral' | EscolhaDoCliente;

const paraCentavos = (valor: Valor): number => {
  if (valor === null || valor === undefined) return 0;
  const n = Number(valor.toString());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const paraReais = (centavos: number): number => centavos / 100;

export interface EstadoDoPedido {
  totalValor: Valor;
  /** `null` quando nunca houve pagamento anterior. */
  valorPago: Valor;
}

export interface SituacaoDoPagamento {
  /** Houve pagamento revertido para edição — o QR da diferença existe. */
  temPagamentoAnterior: boolean;
  total: number;
  pago: number;
  /** Quanto falta pagar. Sem pagamento anterior, é o total. */
  aPagar: number;
  /** Quanto o pago excede o total — vira reembolso na confirmação. */
  excedente: number;
}

export function situacaoDoPagamento(
  pedido: EstadoDoPedido,
): SituacaoDoPagamento {
  const temPagamentoAnterior =
    pedido.valorPago !== null && pedido.valorPago !== undefined;
  const total = paraCentavos(pedido.totalValor);
  const pago = temPagamentoAnterior ? paraCentavos(pedido.valorPago) : 0;

  return {
    temPagamentoAnterior,
    total: paraReais(total),
    pago: paraReais(pago),
    aPagar: paraReais(Math.max(total - pago, 0)),
    excedente: paraReais(Math.max(pago - total, 0)),
  };
}

/**
 * Pagamento anterior já cobre o novo total: não há QR a mostrar, e o pedido vai
 * direto para análise.
 */
export function pagamentoJaCobre(pedido: EstadoDoPedido): boolean {
  const s = situacaoDoPagamento(pedido);
  return s.temPagamentoAnterior && s.aPagar === 0;
}

/**
 * Tipo e valor de um comprovante novo. **O valor nunca vem do app**: sai daqui,
 * a partir da escolha do cliente — um app adulterado não consegue declarar que
 * pagou mais do que o QR cobrava.
 *
 * Sem escolha (app antigo), vale a diferença: é o QR que a API devolve como
 * padrão, e portanto o que esse app exibiu.
 */
export function comprovanteNovo(
  pedido: EstadoDoPedido,
  escolha: EscolhaDoCliente | undefined,
): { tipo: TipoComprovante; valor: number } {
  const s = situacaoDoPagamento(pedido);
  if (!s.temPagamentoAnterior) return { tipo: 'integral', valor: s.total };
  if (escolha === 'total') return { tipo: 'total', valor: s.total };
  return { tipo: 'diferenca', valor: s.aPagar };
}

/**
 * Reembolso ao confirmar: tudo o que entrou menos o total.
 *
 * - Pagou a diferença → zero.
 * - Pagou o total de novo → o pagamento anterior inteiro.
 * - Total diminuiu, sem comprovante novo → pago − total.
 */
export function reembolsoNaConfirmacao(
  pedido: EstadoDoPedido,
  comprovantesConfirmadosAgora: Valor[],
): number {
  const entrou =
    paraCentavos(pedido.valorPago) +
    comprovantesConfirmadosAgora.reduce<number>(
      (soma, valor) => soma + paraCentavos(valor),
      0,
    );
  return paraReais(Math.max(entrou - paraCentavos(pedido.totalValor), 0));
}

/**
 * `valor_pago` gravado no revert: o total que estava confirmado, mais qualquer
 * reembolso ainda não feito — esse dinheiro continua com o restaurante.
 */
export function valorPagoNoRevert(pedido: {
  totalValor: Valor;
  reembolsoValor: Valor;
  reembolsadoEm: Date | string | null | undefined;
}): number {
  const reembolsoPendente = pedido.reembolsadoEm
    ? 0
    : paraCentavos(pedido.reembolsoValor);
  return paraReais(paraCentavos(pedido.totalValor) + reembolsoPendente);
}

/**
 * Data gravada em `vendas.data` quando um formulário é concluído.
 *
 * Entrega usa o ETA da rota (`horarioEstimadoEntrega`). Retirada guarda nesse
 * mesmo campo o horário escolhido pelo cliente, no dia de `dataEntrega`. Se a
 * rota apagou esse horário, o campo fica nulo e o default `now()` da venda
 * lançava a retirada no instante da conclusão — o caso do pedido 225,
 * formulário 24, venda 355 (07/10/2026 em vez de 17/09/2026).
 *
 * Sem horário, o fallback é meio-dia em São Paulo no dia do formulário. Meia-noite
 * UTC dessa coluna `DATE` apareceria como 21h do dia anterior no histórico.
 */
export function dataDaVendaDoFormulario(
  horarioEstimadoEntrega: Date | null | undefined,
  dataEntrega: Date,
): Date {
  if (horarioEstimadoEntrega) return horarioEstimadoEntrega;
  const dia = dataEntrega.toISOString().slice(0, 10);
  return new Date(`${dia}T12:00:00-03:00`);
}

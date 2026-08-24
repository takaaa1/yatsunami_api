/**
 * O fuso em que o negócio opera.
 *
 * Único, e de propósito: a operação é toda no Brasil. O app oferece ja-JP, mas
 * isso é preferência de leitura — não muda o horário em que a loja abre nem a
 * hora impressa num recibo.
 */
export const FUSO_DO_NEGOCIO = 'America/Sao_Paulo';

type Entrada = Date | string;

/**
 * Formata um **dia de calendário** — colunas `DATE`, como `dataEntrega`.
 *
 * Esses valores chegam como meia-noite UTC. Formatá-los no fuso do processo lê
 * o instante e imprime o **dia anterior** em qualquer fuso negativo: foi o
 * defeito do resumo em PDF, que saiu 26/08 para uma entrega de 27/08.
 */
export function diaDeCalendario(valor: Entrada): string {
  return new Date(valor).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

/**
 * Formata um **instante** — `venda.data`, `criadoEm`, qualquer momento no tempo.
 *
 * Aqui o fuso certo é o oposto: em UTC, uma venda das 18h em São Paulo sai
 * impressa como 21h, e uma das 21h30 pula para o dia seguinte.
 */
export function instanteLocal(valor: Entrada): string {
  return new Date(valor).toLocaleString('pt-BR', { timeZone: FUSO_DO_NEGOCIO });
}

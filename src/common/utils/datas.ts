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

/**
 * Deslocamento fixo do fuso do negócio. O Brasil não tem horário de verão
 * desde 2019, então `America/Sao_Paulo` é sempre GMT-3 — regra combinada:
 * todas as datas e horas da operação (Curitiba) são em GMT-3.
 */
export const DESLOCAMENTO_DO_NEGOCIO = '-03:00';
const DESLOCAMENTO_MS = -3 * 60 * 60 * 1000;

const DIA = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Início e fim de um **dia de Brasília** a partir de `AAAA-MM-DD`.
 *
 * Aceita também ISO completo (builds antigos do app mandavam
 * `toISOString()`) usando só a parte da data.
 */
export function limitesDoDia(valor: string): { inicio: Date; fim: Date } {
  const m = DIA.exec(valor);
  if (!m) throw new Error(`Data inválida: ${valor}`);
  const dia = `${m[1]}-${m[2]}-${m[3]}`;
  return {
    inicio: new Date(`${dia}T00:00:00.000${DESLOCAMENTO_DO_NEGOCIO}`),
    fim: new Date(`${dia}T23:59:59.999${DESLOCAMENTO_DO_NEGOCIO}`),
  };
}

/** Início e fim de um mês de Brasília (`mes` de 1 a 12). */
export function limitesDoMes(
  ano: number,
  mes: number,
): { inicio: Date; fim: Date } {
  const doisDigitos = (n: number) => String(n).padStart(2, '0');
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return {
    inicio: limitesDoDia(`${ano}-${doisDigitos(mes)}-01`).inicio,
    fim: limitesDoDia(`${ano}-${doisDigitos(mes)}-${doisDigitos(ultimoDia)}`)
      .fim,
  };
}

/** Mês e ano de um instante, no fuso de Brasília (`mes` de 1 a 12). */
export function mesAnoNoFuso(instante: Date): { ano: number; mes: number } {
  const local = new Date(instante.getTime() + DESLOCAMENTO_MS);
  return { ano: local.getUTCFullYear(), mes: local.getUTCMonth() + 1 };
}

/**
 * Instante a partir de data/hora **sem fuso** vinda de fora (nota fiscal, por
 * exemplo), lida como horário de Brasília. Só a data vira meio-dia de
 * Brasília, para não escorregar para o dia vizinho em nenhum fuso. Valor que
 * já traz fuso (`Z`, `-03:00`) é respeitado.
 *
 * Antes, `new Date('2026-03-01T00:00:00')` no servidor (UTC) gravava
 * meia-noite UTC — 21:00 do dia anterior em Brasília.
 */
export function instanteDeHorarioLocal(valor: string): Date {
  const v = valor.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return new Date(`${v}T12:00:00${DESLOCAMENTO_DO_NEGOCIO}`);
  }
  return new Date(`${v}${DESLOCAMENTO_DO_NEGOCIO}`);
}

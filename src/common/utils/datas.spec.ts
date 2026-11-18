import {
  diaDeCalendario,
  instanteLocal,
  FUSO_DO_NEGOCIO,
  limitesDoDia,
  limitesDoMes,
  mesAnoNoFuso,
  instanteDeHorarioLocal,
} from './datas';

/**
 * Duas espécies de data, e a diferença decide o fuso.
 *
 * - **dia de calendário** (`dataEntrega`, coluna `DATE`) chega como meia-noite
 *   UTC. Formatá-lo no fuso local imprime o **dia anterior** em qualquer fuso
 *   negativo — foi o defeito do resumo em PDF, que saiu 26/08 para uma entrega
 *   de 27/08;
 * - **instante** (`venda.data`, `criadoEm`) é um momento no tempo. Formatá-lo em
 *   UTC mostra a hora errada para quem lê: uma venda das 18h em São Paulo sai
 *   impressa como 21h, porque o contêiner roda em UTC.
 *
 * A regra é a mesma nos dois casos — **não deixar o fuso do processo decidir** —,
 * mas o fuso certo é oposto: UTC para o dia, `America/Sao_Paulo` para o
 * instante. O negócio opera só no Brasil; o idioma ja-JP é preferência de
 * leitura, não outro fuso.
 *
 * Os casos abaixo rodam com o `TZ` que a máquina tiver, e travam o resultado
 * independentemente dele.
 */

describe('diaDeCalendario', () => {
  it('não desloca o dia de um ISO à meia-noite UTC', () => {
    expect(diaDeCalendario('2026-08-27T00:00:00.000Z')).toBe('27/08/2026');
  });

  it('primeiro dia do mês não vira o mês anterior', () => {
    expect(diaDeCalendario('2026-09-01T00:00:00.000Z')).toBe('01/09/2026');
  });

  it('aceita Date', () => {
    expect(diaDeCalendario(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '01/01/2026',
    );
  });
});

describe('instanteLocal', () => {
  /**
   * 21h UTC é 18h em São Paulo. Sem fixar o fuso, o contêiner (que roda em UTC)
   * imprimiria 21h — três horas depois do que o operador viu na tela.
   */
  it('mostra a hora do Brasil, não a do processo', () => {
    expect(instanteLocal('2026-08-27T21:00:00.000Z')).toBe(
      '27/08/2026, 18:00:00',
    );
  });

  /**
   * O caso que mais dói: uma venda das 21h30 no Brasil é 00h30 UTC do **dia
   * seguinte**. Em UTC o recibo sairia com a data de amanhã.
   */
  it('venda da noite não pula para o dia seguinte', () => {
    expect(instanteLocal('2026-08-28T00:30:00.000Z')).toBe(
      '27/08/2026, 21:30:00',
    );
  });

  it('o fuso do negócio é o de São Paulo', () => {
    expect(FUSO_DO_NEGOCIO).toBe('America/Sao_Paulo');
  });
});

/**
 * Datas no fuso de Brasília (GMT-3), regra do negócio: a operação é toda em
 * Curitiba. O Brasil não tem horário de verão desde 2019, então o
 * deslocamento é fixo. Verificação do review (D2).
 */
describe('fuso de Brasília (GMT-3)', () => {
  it('limites do dia a partir de AAAA-MM-DD', () => {
    const { inicio, fim } = limitesDoDia('2026-11-10');
    expect(inicio.toISOString()).toBe('2026-11-10T03:00:00.000Z');
    expect(fim.toISOString()).toBe('2026-11-11T02:59:59.999Z');
  });

  it('aceita ISO completo de builds antigos usando só a parte da data', () => {
    expect(limitesDoDia('2026-11-10T17:37:00.000Z').inicio.toISOString()).toBe(
      '2026-11-10T03:00:00.000Z',
    );
  });

  it('recusa valor que não começa com data', () => {
    expect(() => limitesDoDia('ontem')).toThrow();
  });

  it('limites do mês', () => {
    const { inicio, fim } = limitesDoMes(2026, 11);
    expect(inicio.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(fim.toISOString()).toBe('2026-12-01T02:59:59.999Z');
  });

  it('mês/ano de um instante no fuso de Brasília (virada do mês)', () => {
    // 30/11 22:00 em Brasília = 01/12 01:00 UTC: é novembro.
    expect(mesAnoNoFuso(new Date('2026-12-01T01:00:00Z'))).toEqual({
      ano: 2026,
      mes: 11,
    });
  });

  it('data/hora sem fuso vinda de fora é lida como horário de Brasília', () => {
    expect(instanteDeHorarioLocal('2026-02-05T10:32:16').toISOString()).toBe(
      '2026-02-05T13:32:16.000Z',
    );
  });

  it('só a data vira meio-dia de Brasília (não cai no dia vizinho)', () => {
    expect(instanteDeHorarioLocal('2026-03-01').toISOString()).toBe(
      '2026-03-01T15:00:00.000Z',
    );
  });

  it('valor que já tem fuso é respeitado', () => {
    expect(
      instanteDeHorarioLocal('2026-08-14T19:03:03-03:00').toISOString(),
    ).toBe('2026-08-14T22:03:03.000Z');
  });
});

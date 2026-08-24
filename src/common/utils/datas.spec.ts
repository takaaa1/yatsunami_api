import { diaDeCalendario, instanteLocal, FUSO_DO_NEGOCIO } from './datas';

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

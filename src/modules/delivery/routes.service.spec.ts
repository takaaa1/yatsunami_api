import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { RoutesService } from './routes.service';

/**
 * Otimização de rota e cálculo de horários de chegada.
 *
 * 411 linhas sem teste. O que se guarda aqui é aritmética de tempo — o tipo de
 * coisa que erra em silêncio: um ETA errado não lança exceção, só faz o
 * entregador e o cliente discordarem do app.
 *
 * O caso mais delicado é o **tempo de parada seguir a parada reordenada**. O
 * Google devolve `waypoint_order`, e os tempos de serviço precisam ser
 * permutados junto. Indexar por posição em vez de pelo índice original daria a
 * cada parada o tempo de outra, e a soma continuaria "parecendo certa".
 */

const PADRAO = 300; // DEFAULT_SERVICE_STOP_SECONDS

const perna = (segundos: number, lat = 0, lng = 0) => ({
  duration: { value: segundos },
  end_location: { lat, lng },
});

const respostaDoGoogle = (
  waypointOrder: number[] | undefined,
  legs: ReturnType<typeof perna>[],
  status = 'OK',
) => ({
  data: {
    status,
    routes: [{ waypoint_order: waypointOrder, legs }],
  },
});

describe('RoutesService.optimizeRoute', () => {
  let service: RoutesService;
  let get: jest.Mock;

  /** Minuto em milissegundos, para leitura das diferenças. */
  const minutos = (n: number) => n * 60_000;

  beforeEach(async () => {
    get = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: HttpService, useValue: { get } },
        { provide: ConfigService, useValue: { get: () => 'chave-de-teste' } },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  it('sem destinos, devolve vazio sem chamar o Google', async () => {
    const r = await service.optimizeRoute('origem', []);

    expect(r.orderedDestinations).toEqual([]);
    expect(r.arrivalTimes).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('reordena as paradas conforme o Google, e o destino final fica por último', async () => {
    get.mockReturnValue(
      of(respostaDoGoogle([1, 0], [perna(60), perna(60), perna(60)])),
    );

    const r = await service.optimizeRoute('origem', ['A', 'B', 'RETORNO']);

    expect(r.orderedDestinations).toEqual(['B', 'A', 'RETORNO']);
  });

  /**
   * Defesa contra resposta malformada do Google. Se `waypoint_order` não vier,
   * ou vier com tamanho diferente do número de waypoints, a ordem original é
   * mantida — melhor uma rota não otimizada que uma rota embaralhada.
   */
  it.each([
    ['sem waypoint_order', undefined],
    ['com waypoint_order de tamanho errado', [0]],
  ])(
    'mantém a ordem original quando o Google responde %s',
    async (_n, ordem) => {
      get.mockReturnValue(
        of(respostaDoGoogle(ordem, [perna(60), perna(60), perna(60)])),
      );

      const r = await service.optimizeRoute('origem', ['A', 'B', 'RETORNO']);

      expect(r.orderedDestinations).toEqual(['A', 'B', 'RETORNO']);
    },
  );

  it('acumula deslocamento e parada nos horários de chegada', async () => {
    const partida = new Date('2026-08-21T09:00:00.000Z');
    get.mockReturnValue(
      of(respostaDoGoogle([0, 1], [perna(600), perna(600), perna(600)])),
    );

    const r = await service.optimizeRoute(
      'origem',
      ['A', 'B', 'RETORNO'],
      partida.toISOString(),
      [120, 180],
    );

    const base = partida.getTime();
    // A: 10 min de viagem
    expect(r.arrivalTimes[0].getTime()).toBe(base + minutos(10));
    // B: + 2 min parado em A + 10 min de viagem
    expect(r.arrivalTimes[1].getTime()).toBe(base + minutos(22));
    // RETORNO: + 3 min parado em B + 10 min de viagem
    expect(r.arrivalTimes[2].getTime()).toBe(base + minutos(35));
  });

  /**
   * O caso que mais importa deste arquivo.
   *
   * Os tempos de parada chegam na ordem original — `[A=2min, B=8min]`. O Google
   * inverte para `B, A`. O tempo gasto **em B** tem de ser 8 min, não 2.
   *
   * Se alguém indexar por posição em vez do índice original, a chegada ao
   * `RETORNO` sai 6 minutos errada e nada lança exceção.
   */
  it('o tempo de parada acompanha a parada quando a ordem muda', async () => {
    const partida = new Date('2026-08-21T09:00:00.000Z');
    get.mockReturnValue(
      of(respostaDoGoogle([1, 0], [perna(600), perna(600), perna(600)])),
    );

    const r = await service.optimizeRoute(
      'origem',
      ['A', 'B', 'RETORNO'],
      partida.toISOString(),
      [120, 480], // A = 2 min, B = 8 min
    );

    const base = partida.getTime();
    expect(r.orderedDestinations).toEqual(['B', 'A', 'RETORNO']);
    // B: 10 min de viagem
    expect(r.arrivalTimes[0].getTime()).toBe(base + minutos(10));
    // A: + 8 min parado em B + 10 min
    expect(r.arrivalTimes[1].getTime()).toBe(base + minutos(28));
    // RETORNO: + 2 min parado em A + 10 min
    expect(r.arrivalTimes[2].getTime()).toBe(base + minutos(40));
  });

  it('a última perna não soma tempo de parada', async () => {
    const partida = new Date('2026-08-21T09:00:00.000Z');
    get.mockReturnValue(of(respostaDoGoogle([0], [perna(600), perna(600)])));

    const r = await service.optimizeRoute(
      'origem',
      ['A', 'RETORNO'],
      partida.toISOString(),
      [3600], // uma hora parado em A
    );

    const base = partida.getTime();
    expect(r.arrivalTimes[0].getTime()).toBe(base + minutos(10));
    // 10 + 60 parado + 10; se a última perna somasse parada, seriam 140 min
    expect(r.arrivalTimes[1].getTime()).toBe(base + minutos(80));
  });

  describe('tempos de parada inválidos caem no padrão', () => {
    const partida = new Date('2026-08-21T09:00:00.000Z');

    beforeEach(() => {
      get.mockReturnValue(of(respostaDoGoogle([0], [perna(600), perna(600)])));
    });

    it.each([
      ['omitidos', undefined],
      ['em quantidade diferente das paradas', [10, 20, 30]],
      ['não numéricos', ['x' as unknown as number]],
      ['infinitos', [Number.POSITIVE_INFINITY]],
    ])('%s', async (_n, dwell) => {
      const r = await service.optimizeRoute(
        'origem',
        ['A', 'RETORNO'],
        partida.toISOString(),
        dwell,
      );

      const base = partida.getTime();
      expect(r.arrivalTimes[1].getTime()).toBe(
        base + minutos(20) + PADRAO * 1000,
      );
    });

    it('negativo vira zero, não subtrai tempo', async () => {
      const r = await service.optimizeRoute(
        'origem',
        ['A', 'RETORNO'],
        partida.toISOString(),
        [-600],
      );

      expect(r.arrivalTimes[1].getTime()).toBe(partida.getTime() + minutos(20));
    });
  });

  it('devolve as coordenadas de cada parada', async () => {
    get.mockReturnValue(
      of(
        respostaDoGoogle(
          [0],
          [perna(60, -25.4, -49.2), perna(60, -25.5, -49.3)],
        ),
      ),
    );

    const r = await service.optimizeRoute('origem', ['A', 'RETORNO']);

    expect(r.coordinates).toEqual([
      { lat: -25.4, lng: -49.2 },
      { lat: -25.5, lng: -49.3 },
    ]);
  });

  it('propaga erro quando o Google recusa a requisição', async () => {
    get.mockReturnValue(of(respostaDoGoogle([0], [], 'REQUEST_DENIED')));

    await expect(
      service.optimizeRoute('origem', ['A', 'RETORNO']),
    ).rejects.toThrow('REQUEST_DENIED');
  });

  /**
   * Separação deliberada: o Google recebe um horário de partida sempre no
   * futuro (ele exige isso para calcular trânsito), mas os horários devolvidos
   * são contados a partir do horário **pedido**. Sem isso, agendar uma rota
   * para amanhã devolveria chegadas de hoje.
   */
  it('conta as chegadas a partir do horário pedido, não do horário mandado ao Google', async () => {
    const amanha = new Date(Date.now() + 24 * 3600_000);
    get.mockReturnValue(of(respostaDoGoogle([0], [perna(600), perna(600)])));

    const r = await service.optimizeRoute(
      'origem',
      ['A', 'RETORNO'],
      amanha.toISOString(),
      [0],
    );

    expect(r.arrivalTimes[0].getTime()).toBe(amanha.getTime() + minutos(10));
    // E o que foi para o Google é um instante próximo de agora, não de amanhã.
    const url = String(get.mock.calls[0][0]);
    const enviado = Number(/departure_time=(\d+)/.exec(url)?.[1]) * 1000;
    expect(enviado).toBeLessThan(amanha.getTime());
  });
});

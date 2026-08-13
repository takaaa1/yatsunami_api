/**
 * Formato das paradas gravadas no campo JSON `RotaEntrega.nomesParadas`.
 *
 * O Prisma devolve `JsonValue` para esse campo, então sem um tipo explícito
 * todo acesso a parada vira `any` — foi essa falta de tipo que deixou passar
 * o `courierId` nulo e a confusão entre parada de entrega e parada de retorno.
 */
export interface RouteStop {
  address: string;
  /** Nome do cliente ou `Retorno` na volta ao restaurante. Opcional no formato legado. */
  name?: string;
  /** Endereço completo do cadastro do cliente, quando disponível. */
  fullAddress?: string;
  cep?: string;
  orderId?: number | null;
  orderIds?: number[];
  /** Rota do entregador (1, 2, ...). Ausente equivale a 1. */
  courierId?: number;
  latitude?: number;
  longitude?: number;
  /** Segundos de permanência no local (padrão 300). */
  serviceStopSeconds?: number;
  /** ISO-8601 — chegada estimada. */
  arrivalTime?: string;
  /** ISO-8601 — partida usada no cálculo da rota. */
  routeDepartureTime?: string;
}

/** Nome da parada de volta ao restaurante. Não é uma entrega. */
export const RETURN_STOP_NAME = 'Retorno';

/**
 * Converte o JSON cru do banco em paradas tipadas, descartando entradas
 * malformadas. Aceita o formato legado em que a parada era só o endereço.
 */
export function asRouteStops(value: unknown): RouteStop[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): RouteStop[] => {
    if (typeof entry === 'string') {
      return [{ address: entry, name: 'Cliente' }];
    }
    if (entry && typeof entry === 'object') {
      const stop = entry as Record<string, unknown>;
      const address = typeof stop.address === 'string' ? stop.address : '';
      if (!address) return [];
      return [{ ...(stop as unknown as RouteStop), address }];
    }
    return [];
  });
}

/** `courierId` da parada, com o default 1 usado em rota de entregador único. */
export function stopCourierId(stop: RouteStop): number {
  return Number(stop.courierId ?? 1);
}

/** Todos os `orderId`/`orderIds` da parada, sem duplicatas e sem valores vazios. */
export function stopOrderIds(stop: RouteStop): number[] {
  const ids: number[] = [];
  if (stop.orderId) ids.push(Number(stop.orderId));
  if (Array.isArray(stop.orderIds))
    ids.push(...stop.orderIds.map((id) => Number(id)));
  return Array.from(new Set(ids)).filter((id) => Number.isFinite(id) && id > 0);
}

/**
 * Recortes tipados das respostas das APIs do Google Maps usadas pelo roteirizador.
 *
 * Declara apenas os campos que o `RoutesService` consome — o objetivo é tirar
 * as respostas HTTP do território do `any`, não espelhar a API inteira.
 */

export interface LatLngLiteral {
  lat: number;
  lng: number;
}

/** Trecho entre dois pontos consecutivos da rota. */
export interface DirectionsLeg {
  /** Duração prevista; `value` em segundos. */
  duration: { value: number; text?: string };
  /** Duração com trânsito, quando `departure_time` é enviado. */
  duration_in_traffic?: { value: number; text?: string };
  distance?: { value: number; text?: string };
  start_location?: LatLngLiteral;
  end_location: LatLngLiteral;
}

export interface DirectionsRoute {
  /** Ordem otimizada dos waypoints, quando `optimize:true` é pedido. */
  waypoint_order?: number[];
  legs: DirectionsLeg[];
}

export interface DirectionsResponse {
  status: string;
  error_message?: string;
  routes: DirectionsRoute[];
}

export interface GeocodeResult {
  formatted_address: string;
  geometry: { location: LatLngLiteral };
}

export interface GeocodeResponse {
  status: string;
  error_message?: string;
  results: GeocodeResult[];
}

/** Retorno de `RoutesService.optimizeRoute`. */
export interface OptimizedRoute {
  /** Destinos na ordem otimizada pelo Google. */
  orderedDestinations: string[];
  /** Chegada estimada em cada destino, na mesma ordem. */
  arrivalTimes: Date[];
  /** Coordenadas de cada destino; ausente quando não há destinos. */
  coordinates?: LatLngLiteral[];
}

/** Resposta do Nominatim (OpenStreetMap), usado como alternativa ao Google. */
export interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

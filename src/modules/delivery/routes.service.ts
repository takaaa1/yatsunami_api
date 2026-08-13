import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class RoutesService {
    private readonly logger = new Logger(RoutesService.name);
    private readonly googleMapsKey: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) {
        this.googleMapsKey = (this.configService.get<string>('googleMapsKey') || '').trim();
        const key = this.googleMapsKey;
        this.logger.debug(`Google Maps Key loaded (Length: ${key.length})`);
        // Debugging raw key characters to catch invisible ones
        this.logger.debug(`Key Hex: ${Buffer.from(key).toString('hex')}`);
    }

    /** Tempo de parada padrão após cada entrega (exceto última perna até destino final), em segundos. */
    private static readonly DEFAULT_SERVICE_STOP_SECONDS = 300;

    /**
     * @param waypointDwellSeconds — um valor por waypoint (mesma ordem que `destinations` sem o último elemento).
     *   Após reordenação pelo Google, os tempos seguem a ordem otimizada. Se omitido ou tamanho incorreto, usa-se o padrão.
     */
    async optimizeRoute(
        origin: string,
        destinations: string[],
        departureTime?: string,
        waypointDwellSeconds?: number[],
    ) {
        if (!destinations.length) return { orderedDestinations: [], arrivalTimes: [] };

        const finalDestination = destinations[destinations.length - 1];
        const waypoints = destinations.slice(0, destinations.length - 1);

        const waypointsStr = waypoints.length
            ? `optimize:true|${waypoints.map((wp) => encodeURIComponent(wp)).join('|')}`
            : '';

        let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
            origin,
        )}&destination=${encodeURIComponent(
            finalDestination,
        )}&waypoints=${waypointsStr}&key=${this.googleMapsKey}`;

        let finalDepartureTimestamp = Date.now();
        if (departureTime) {
            const requestedTime = new Date(departureTime).getTime();
            // Google requires departure_time to be now or in the future
            finalDepartureTimestamp = requestedTime;
            url += `&departure_time=${Math.floor(Date.now() / 1000 + 120)}`; // Use a safe future time for Google Traffic optimization only
        } else {
            url += `&departure_time=now`;
        }

        this.logger.debug(`Google Maps Request URL: ${url.replace(/key=[^&]+/, 'key=REDACTED')}`);

        try {
            const { data } = await firstValueFrom(this.httpService.get(url));

            if (data.status !== 'OK') {
                this.logger.error(`Google Maps API error: ${data.status} - ${data.error_message || 'No error message'}`);
                if (data.status === 'NOT_FOUND') {
                    this.logger.error('Check your origin and destination addresses. One or more could not be geocoded.');
                }
                throw new Error(`Google Maps API error: ${data.status}`);
            }

            const route = data.routes[0];
            const optimizedOrder: number[] =
                waypoints.length === 0
                    ? []
                    : Array.isArray(route.waypoint_order) && route.waypoint_order.length === waypoints.length
                        ? route.waypoint_order
                        : waypoints.map((_, idx) => idx);
            const legs = route.legs; // Array of legs between waypoints

            const defaultDwell = RoutesService.DEFAULT_SERVICE_STOP_SECONDS;
            const inputDwellOk =
                Array.isArray(waypointDwellSeconds) && waypointDwellSeconds.length === waypoints.length;
            const orderedDwellSeconds: number[] =
                waypoints.length === 0
                    ? []
                    : optimizedOrder.map((idx) => {
                        const raw = inputDwellOk ? waypointDwellSeconds[idx] : defaultDwell;
                        const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultDwell;
                        return Math.max(0, n);
                    });

            // Reorder waypoints based on optimized order
            const orderedDestinations =
                waypoints.length === 0 ? [] : optimizedOrder.map((index) => waypoints[index]);
            orderedDestinations.push(finalDestination);

            // Calculate arrival times
            let currentTimestamp = finalDepartureTimestamp;
            const arrivalTimes: Date[] = [];
            const coordinates: { lat: number; lng: number }[] = [];

            // legs[0] is origin -> first waypoint
            // legs[1] is first -> second
            // ...
            // legs[len-1] is last waypoint -> destination

            // Note: Google Maps API with optimize:true returns the legs IN THE OPTIMIZED ORDER.
            // So we can just iterate through legs to get durations and coordinates.

            for (let j = 0; j < legs.length; j++) {
                const leg = legs[j];
                // leg.duration.value is in seconds
                currentTimestamp += leg.duration.value * 1000;
                arrivalTimes.push(new Date(currentTimestamp));

                // Capture coordinates for each stop
                coordinates.push({
                    lat: leg.end_location.lat,
                    lng: leg.end_location.lng,
                });

                // Tempo de parada na ordem otimizada (última perna = destino final, sem parada extra)
                if (j < legs.length - 1) {
                    const dwell = orderedDwellSeconds[j] ?? defaultDwell;
                    currentTimestamp += dwell * 1000;
                }
            }

            return { orderedDestinations, arrivalTimes, coordinates };
        } catch (error) {
            this.logger.error('Error optimizing route', error);
            throw error;
        }
    }

    /**
     * Mesma ordem de paradas que o Google percorre (sem optimize:true).
     * `destinations` = [parada1, ..., paradaFinal] (último é tipicamente retorno ao restaurante).
     * `waypointDwellSeconds`: um valor por waypoint (tamanho = destinations.length - 1).
     */
    async arrivalsForFixedOrder(
        origin: string,
        destinations: string[],
        departureTime?: string,
        waypointDwellSeconds?: number[],
    ): Promise<Date[]> {
        if (!destinations.length) return [];

        const finalDestination = destinations[destinations.length - 1];
        const waypoints = destinations.slice(0, destinations.length - 1);

        const waypointsStr = waypoints.length
            ? `${waypoints.map((wp) => encodeURIComponent(wp)).join('|')}`
            : '';

        let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
            origin,
        )}&destination=${encodeURIComponent(
            finalDestination,
        )}&key=${this.googleMapsKey}`;

        if (waypointsStr) {
            url += `&waypoints=${waypointsStr}`;
        }

        let finalDepartureTimestamp = Date.now();
        if (departureTime) {
            finalDepartureTimestamp = new Date(departureTime).getTime();
            url += `&departure_time=${Math.floor(Date.now() / 1000 + 120)}`;
        } else {
            url += `&departure_time=now`;
        }

        this.logger.debug(`Google Maps fixed-order URL: ${url.replace(/key=[^&]+/, 'key=REDACTED')}`);

        const { data } = await firstValueFrom(this.httpService.get(url));

        if (data.status !== 'OK') {
            this.logger.error(`Google Maps API error (fixed order): ${data.status} - ${data.error_message || ''}`);
            throw new Error(`Google Maps API error: ${data.status}`);
        }

        const legs = data.routes[0].legs as { duration: { value: number } }[];
        const defaultDwell = RoutesService.DEFAULT_SERVICE_STOP_SECONDS;
        const dwellOk =
            Array.isArray(waypointDwellSeconds) && waypointDwellSeconds.length === waypoints.length;

        let currentTimestamp = finalDepartureTimestamp;
        const arrivalTimes: Date[] = [];

        for (let j = 0; j < legs.length; j++) {
            const leg = legs[j];
            currentTimestamp += leg.duration.value * 1000;
            arrivalTimes.push(new Date(currentTimestamp));

            if (j < legs.length - 1) {
                const raw = dwellOk ? waypointDwellSeconds[j] : defaultDwell;
                const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultDwell;
                currentTimestamp += Math.max(0, n) * 1000;
            }
        }

        return arrivalTimes;
    }

    async getEtaForRemainingStops(originLat: number, originLng: number, destinations: string[]) {
        if (!destinations.length) return [];

        const origin = `${originLat},${originLng}`;
        const finalDestination = destinations[destinations.length - 1];
        const waypoints = destinations.slice(0, destinations.length - 1);

        const waypointsStr = waypoints.length
            ? `${waypoints.map((wp) => encodeURIComponent(wp)).join('|')}`
            : '';

        let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
            origin,
        )}&destination=${encodeURIComponent(
            finalDestination,
        )}&key=${this.googleMapsKey}`;

        if (waypointsStr) {
            url += `&waypoints=${waypointsStr}`;
        }

        try {
            const { data } = await firstValueFrom(this.httpService.get(url));

            if (data.status !== 'OK') {
                this.logger.error(`Google Maps API error (ETA): ${data.status}`);
                throw new Error(`Google Maps API error: ${data.status}`);
            }

            const route = data.routes[0];
            const legs = route.legs;
            let currentTimestamp = Date.now();
            const arrivalTimes: Date[] = [];

            for (let j = 0; j < legs.length; j++) {
                const leg = legs[j];
                currentTimestamp += leg.duration.value * 1000;
                arrivalTimes.push(new Date(currentTimestamp));

                // Add 5 minutes (300 seconds) service time for intermediate stops
                if (j < legs.length - 1) {
                    currentTimestamp += 300 * 1000;
                }
            }

            return arrivalTimes;
        } catch (error) {
            this.logger.error('Error getting dynamic ETAs', error);
            throw error;
        }
    }

    generateGoogleMapsLink(destinations: string[]): string {
        // https://www.google.com/maps/dir/?api=1&origin=...&destination=...&waypoints=...
        // Separador entre waypoints deve ser %7C (pipe codificado), limite ~2048 chars por URL.
        if (!destinations.length) return '';

        const origin = encodeURIComponent(destinations[0]);
        const destination = encodeURIComponent(destinations[destinations.length - 1]);

        let waypoints = '';
        if (destinations.length > 2) {
            waypoints =
                '&waypoints=' +
                destinations.slice(1, destinations.length - 1).map((d) => encodeURIComponent(d)).join('%7C');
        }

        return `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origin}&destination=${destination}${waypoints}`;
    }

    /**
     * Geocodifica um endereço via Google Maps Geocoding API.
     * Retorna null se não encontrado ou em caso de erro.
     */
    async geocodeAddress(address: string, cepFallback?: string): Promise<{
        formattedAddress: string;
        latitude: number;
        longitude: number;
    } | null> {
        const tryGoogle = async (query: string) => {
            const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=br&language=pt-BR&key=${this.googleMapsKey}`;
            const response = await firstValueFrom(this.httpService.get(url));
            const data = response.data;
            if (data.status !== 'OK' || !data.results?.length) return null;
            const r = data.results[0];
            return { formattedAddress: r.formatted_address, latitude: r.geometry.location.lat, longitude: r.geometry.location.lng };
        };

        const tryNominatim = async (query: string) => {
            const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&countrycodes=br&limit=1&addressdetails=1`;
            const response = await firstValueFrom(
                this.httpService.get(url, { headers: { 'User-Agent': 'Yatsunami-App/1.0' } })
            );
            const results = response.data;
            if (!Array.isArray(results) || !results.length) return null;
            const r = results[0];
            return {
                formattedAddress: r.display_name + ' (via OSM)',
                latitude: parseFloat(r.lat),
                longitude: parseFloat(r.lon),
            };
        };

        try {
            // Tentativa 1: Google — endereço completo
            const google1 = await tryGoogle(address);
            if (google1) return google1;
            this.logger.warn(`Google geocoding failed for "${address}"`);

            // Tentativa 2: OpenStreetMap — endereço completo (melhor cobertura de ruas locais)
            const osm1 = await tryNominatim(address);
            if (osm1) {
                this.logger.log(`OSM geocoding succeeded for "${address}"`);
                return osm1;
            }
            this.logger.warn(`OSM geocoding also failed for "${address}"`);

            // Tentativa 3: Google — só o CEP
            if (cepFallback) {
                const cepClean = cepFallback.replace(/\D/g, '');
                const cepFormatted = `${cepClean.slice(0, 5)}-${cepClean.slice(5)}`;
                const google2 = await tryGoogle(`CEP ${cepFormatted}, Brasil`);
                if (google2) {
                    return { ...google2, formattedAddress: `${google2.formattedAddress} (via CEP ${cepFormatted})` };
                }

                // Tentativa 4: OSM — só o CEP
                const osm2 = await tryNominatim(`${cepClean}, Curitiba, Brasil`);
                if (osm2) {
                    return { ...osm2, formattedAddress: `${osm2.formattedAddress} (via CEP ${cepFormatted})` };
                }
            }

            return null;
        } catch (e) {
            this.logger.error(`Geocoding error for "${address}": ${e.message}`);
            return null;
        }
    }
}

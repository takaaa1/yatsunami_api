import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutesService } from './routes.service';
import { CreateRouteDto } from './dto/create-route.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { ReorderStopsDto } from './dto/reorder-stops.dto';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { CronLockService } from '../../common/cron/cron-lock.service';
import { CRON_LOCK_KEYS } from '../../common/runtime/runtime.config';
import { ConfiguracaoFormularios, Prisma, RotaEntrega } from '@prisma/client';
import {
  asRestaurantAddress,
  formatRestaurantDestination,
  formatRestaurantOrigin,
} from '../configuracoes/restaurant-address.types';
import {
  RouteStop,
  asRouteStops,
  stopCourierId,
  stopOrderIds,
} from './route-stop.types';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  /** Controle de throttle da auto-recuperação de rastreio, por `formId_courierId`. */
  private readonly reactivationThrottle = new Map<string, number>();
  private static readonly REACTIVATION_THROTTLE_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routesService: RoutesService,
    private readonly configuracoesService: ConfiguracoesService,
    private readonly cronLockService: CronLockService,
  ) {}

  async createRoute(createRouteDto: CreateRouteDto) {
    const {
      formId,
      destinations,
      origin,
      departureTime,
      couriers = 1,
    } = createRouteDto;

    // destinations is now { address: string; name: string; orderId?: number }[]

    let originAddress = origin;
    // Config fetching only for origin address fallback
    let config: ConfiguracaoFormularios | null = null;
    if (!originAddress) {
      config = await this.configuracoesService.get();
    }

    if (!originAddress) {
      originAddress = formatRestaurantOrigin(
        asRestaurantAddress(config?.enderecoRestaurante),
      );

      if (!originAddress) {
        this.logger.error(
          'Restaurant address (origin) is not configured and no origin was provided.',
        );
        throw new BadRequestException(
          'Restaurant address not configured. Please set it in Admin Settings.',
        );
      }
    }

    // Validate destinations
    if (!destinations || destinations.length === 0) {
      throw new Error('No destinations provided for the route.');
    }

    // Filter out empty or too short addresses that definitely won't geocode
    const validDestinations = destinations.filter(
      (d) => d.address && d.address.trim().length > 5,
    );
    if (validDestinations.length === 0) {
      throw new Error(
        'No valid destination addresses found. Please check the order addresses.',
      );
    }

    // Extract addresses for optimization
    const destinationAddresses = validDestinations.map((d) => d.address);

    // Fetch restaurant address for final destination
    if (!config) config = await this.configuracoesService.get();
    let restaurantAddress = formatRestaurantDestination(
      asRestaurantAddress(config?.enderecoRestaurante),
    );

    if (!restaurantAddress) {
      this.logger.warn(
        'Restaurant address not configured for final destination. Using origin as fallback.',
      );
      restaurantAddress = originAddress;
    }

    // Multi-Courier Logic
    const clusters: {
      address: string;
      name: string;
      orderId?: number;
      orderIds?: number[];
      serviceStopSeconds?: number;
      lat?: number;
      lng?: number;
    }[][] = [];

    let orderedForAll: string[] = [];
    let coordsForAll: { lat: number; lng: number }[] = [];

    if (couriers > 1) {
      const perStopDwellAll = validDestinations.map((d) =>
        d.serviceStopSeconds != null && d.serviceStopSeconds > 0
          ? d.serviceStopSeconds
          : 300,
      );
      const globalWaypointDwell =
        destinationAddresses.length > 1
          ? perStopDwellAll.slice(0, destinationAddresses.length - 1)
          : undefined;

      // Get coordinates for all points
      const result = await this.routesService.optimizeRoute(
        originAddress,
        destinationAddresses,
        departureTime,
        globalWaypointDwell,
      );
      orderedForAll = result.orderedDestinations; // succinct list
      coordsForAll = result.coordinates || []; // matching coordinates

      // Map back to full objects
      const allPointsWithCoords = orderedForAll.map((addr, idx) => {
        const original = destinations.find((d) => d.address === addr);
        return {
          ...original,
          address: addr,
          name: original?.name || 'Cliente',
          orderId: original?.orderId,
          orderIds: original?.orderIds,
          serviceStopSeconds: original?.serviceStopSeconds,
          lat: coordsForAll[idx].lat,
          lng: coordsForAll[idx].lng,
        };
      });

      // K-Means Clustering
      const k = couriers;
      // Initialize centroids (pick k random points)
      if (allPointsWithCoords.length < k) {
        // Fewer points than couriers, just assign 1 per courier or all to 1
        clusters.push(allPointsWithCoords);
      } else {
        let centroids = allPointsWithCoords
          .slice(0, k)
          .map((p) => ({ lat: p.lat, lng: p.lng }));
        const assignments: number[] = new Array<number>(
          allPointsWithCoords.length,
        ).fill(0);

        // Iterations
        for (let iter = 0; iter < 10; iter++) {
          // Assign points to nearest centroid
          allPointsWithCoords.forEach((p, idx) => {
            let minDist = Infinity;
            let clusterIdx = 0;
            centroids.forEach((c, cIdx) => {
              const dist = Math.sqrt(
                Math.pow(p.lat - c.lat, 2) + Math.pow(p.lng - c.lng, 2),
              );
              if (dist < minDist) {
                minDist = dist;
                clusterIdx = cIdx;
              }
            });
            assignments[idx] = clusterIdx;
          });

          // Update centroids
          const newCentroids = Array(k)
            .fill(null)
            .map(() => ({ lat: 0, lng: 0, count: 0 }));
          allPointsWithCoords.forEach((p, idx) => {
            const cIdx = assignments[idx];
            newCentroids[cIdx].lat += p.lat;
            newCentroids[cIdx].lng += p.lng;
            newCentroids[cIdx].count++;
          });

          centroids = newCentroids.map((c) =>
            c.count === 0
              ? centroids[Math.floor(Math.random() * k)]
              : { lat: c.lat / c.count, lng: c.lng / c.count },
          );
        }

        // Build clusters
        for (let i = 0; i < k; i++) {
          clusters.push(
            allPointsWithCoords.filter((_, idx) => assignments[idx] === i),
          );
        }

        // Balance clusters to ensure even distribution of stops
        // Sort clusters by size (largest first)
        clusters.sort((a, b) => b.length - a.length);

        // Calculate target size for balanced distribution
        const totalStops = allPointsWithCoords.length;
        const targetSize = Math.ceil(totalStops / k);

        // Redistribute from larger clusters to smaller ones
        let redistributionNeeded = true;
        let iterations = 0;
        const maxIterations = 100;

        while (redistributionNeeded && iterations < maxIterations) {
          redistributionNeeded = false;
          iterations++;

          for (let i = 0; i < clusters.length; i++) {
            // Find the smallest cluster
            let smallestIdx = 0;
            let smallestSize = clusters[0].length;
            for (let j = 1; j < clusters.length; j++) {
              if (clusters[j].length < smallestSize) {
                smallestSize = clusters[j].length;
                smallestIdx = j;
              }
            }

            // If current cluster is larger than target and smallest is smaller
            if (
              clusters[i].length > targetSize &&
              clusters[smallestIdx].length < targetSize &&
              i !== smallestIdx
            ) {
              // Find the point in cluster[i] closest to cluster[smallestIdx] centroid
              const smallestCentroid =
                clusters[smallestIdx].length > 0
                  ? {
                      lat:
                        clusters[smallestIdx].reduce(
                          (sum, p) => sum + (p.lat || 0),
                          0,
                        ) / clusters[smallestIdx].length,
                      lng:
                        clusters[smallestIdx].reduce(
                          (sum, p) => sum + (p.lng || 0),
                          0,
                        ) / clusters[smallestIdx].length,
                    }
                  : { lat: 0, lng: 0 };

              let closestPointIdx = 0;
              let closestDist = Infinity;

              clusters[i].forEach((p, idx) => {
                const dist = Math.sqrt(
                  Math.pow((p.lat || 0) - smallestCentroid.lat, 2) +
                    Math.pow((p.lng || 0) - smallestCentroid.lng, 2),
                );
                if (dist < closestDist) {
                  closestDist = dist;
                  closestPointIdx = idx;
                }
              });

              // Move the point
              const pointToMove = clusters[i].splice(closestPointIdx, 1)[0];
              clusters[smallestIdx].push(pointToMove);
              redistributionNeeded = true;
            }
          }
        }

        this.logger.debug(
          `Balanced clusters after ${iterations} iterations: ${clusters.map((c) => c.length).join(', ')}`,
        );
      }
    } else {
      clusters.push(validDestinations);
    }

    // Process each cluster
    const allRoutesData: RouteStop[] = [];
    const allLinks: { courierId: number; url: string; label: string }[] = [];

    // Remove existing arrival times for this form to avoid stale data
    await this.prisma.pedidoEncomenda.updateMany({
      where: { dataEncomendaId: formId },
      data: { horarioEstimadoEntrega: null },
    });

    for (let i = 0; i < clusters.length; i++) {
      const clusterDestinations = clusters[i];
      if (clusterDestinations.length === 0) continue;

      const clusterAddrs = clusterDestinations.map((d) => d.address);
      // Add restaurant as final destination for each cluster
      const clusterWithRest = [...clusterAddrs, restaurantAddress];

      const waypointDwellSeconds = clusterDestinations.map((d) =>
        d.serviceStopSeconds != null && d.serviceStopSeconds > 0
          ? d.serviceStopSeconds
          : 300,
      );

      const {
        orderedDestinations: orderedAddresses,
        arrivalTimes,
        coordinates,
      } = await this.routesService.optimizeRoute(
        originAddress,
        clusterWithRest,
        departureTime,
        waypointDwellSeconds,
      );

      // Generate Links
      const CHUNK_SIZE = 10;
      for (let j = 0; j < orderedAddresses.length; j += CHUNK_SIZE) {
        const chunk = orderedAddresses.slice(j, j + CHUNK_SIZE);
        const linkOrigin = j === 0 ? originAddress : orderedAddresses[j - 1];
        const url = this.routesService.generateGoogleMapsLink([
          linkOrigin,
          ...chunk,
        ]);

        allLinks.push({
          courierId: i + 1,
          url: url,
          label: `Rota ${i + 1} - Parte ${Math.floor(j / CHUNK_SIZE) + 1}`,
        });
      }

      // Format Stops with arrival times
      const orderedStops = orderedAddresses.map((addr, index) => {
        const coord = (coordinates && coordinates[index]) || { lat: 0, lng: 0 };
        const arrivalTime = arrivalTimes[index]
          ? arrivalTimes[index].toISOString()
          : new Date().toISOString();

        if (
          index === orderedAddresses.length - 1 &&
          addr === restaurantAddress
        ) {
          return {
            address: addr,
            name: 'Retorno',
            orderId: null,
            latitude: coord.lat,
            longitude: coord.lng,
            courierId: i + 1,
            arrivalTime,
            serviceStopSeconds: 0,
            routeDepartureTime: departureTime,
          };
        }
        const original = destinations.find((d) => d.address === addr);
        return {
          address: addr,
          fullAddress: original?.fullAddress,
          cep: original?.cep,
          name: original?.name || 'Cliente',
          orderId: original?.orderId,
          orderIds: original?.orderIds,
          // Prefer pre-verified coordinates from user profile (geocoded at registration)
          // over routing-API coordinates (which may snap to wrong road)
          latitude: original?.latitude ?? coord.lat,
          longitude: original?.longitude ?? coord.lng,
          courierId: i + 1,
          arrivalTime,
          serviceStopSeconds: original?.serviceStopSeconds,
          routeDepartureTime: departureTime,
        };
      });

      allRoutesData.push(...orderedStops);

      // Sync ETAs
      await Promise.all(
        orderedStops.map(async (stop, index) => {
          const arrivalTime = arrivalTimes[index];

          const targetOrderIds: number[] = [];
          if (stop.orderId) targetOrderIds.push(stop.orderId);
          if (stop.orderIds && Array.isArray(stop.orderIds)) {
            targetOrderIds.push(...stop.orderIds.map((id) => Number(id)));
          }

          const uniqueOrderIds = Array.from(new Set(targetOrderIds)).filter(
            Boolean,
          );

          if (uniqueOrderIds.length > 0) {
            await this.prisma.pedidoEncomenda.updateMany({
              where: { id: { in: uniqueOrderIds } },
              data: { horarioEstimadoEntrega: arrivalTime },
            });
          }
        }),
      );
    }

    // Use actual arrival times from Google Maps API
    const horariosChegadaJson = allRoutesData.map(
      (stop) => stop.arrivalTime || new Date().toISOString(),
    );

    const route = await this.prisma.rotaEntrega.upsert({
      where: { formId },
      update: {
        links: allLinks as unknown as Prisma.InputJsonValue,
        nomesParadas: allRoutesData as unknown as Prisma.InputJsonValue,
        horariosChegada: horariosChegadaJson,
      },
      create: {
        formId,
        links: allLinks as unknown as Prisma.InputJsonValue,
        nomesParadas: allRoutesData as unknown as Prisma.InputJsonValue,
        horariosChegada: horariosChegadaJson,
      },
    });

    return route;
  }

  async getRoute(formId: number) {
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });

    if (!route) {
      throw new NotFoundException(`Route for form ${formId} not found`);
    }

    return route;
  }

  async reorderStops(formId: number, dto: ReorderStopsDto) {
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });
    if (!route) {
      throw new NotFoundException(`Route for form ${formId} not found`);
    }
    let nomesParadas: RouteStop[] = dto.nomesParadas;
    if (!nomesParadas || nomesParadas.length === 0) {
      throw new BadRequestException('nomesParadas must be a non-empty array');
    }
    // Garantir que a parada "Retorno" (volta ao restaurante) permaneça sempre por último
    const returnStopName = 'Retorno';
    const returnIdx = nomesParadas.findIndex(
      (s) => typeof s === 'object' && s?.name === returnStopName,
    );
    if (returnIdx !== -1 && returnIdx !== nomesParadas.length - 1) {
      const returnStop = nomesParadas[returnIdx];
      nomesParadas = nomesParadas.filter(
        (_: any, i: number) => i !== returnIdx,
      );
      nomesParadas.push(returnStop);
    }

    const baseDepartureTime = this.resolveDepartureTimeForReorder(
      route,
      nomesParadas,
    );
    const horariosChegada = await this.recalculateHorariosAfterReorder(
      nomesParadas,
      baseDepartureTime,
    );

    // Clear delivery completion state so indices match the new order
    await this.prisma.entregaConcluida.deleteMany({
      where: { formId },
    });
    const updated = await this.prisma.rotaEntrega.update({
      where: { formId },
      data: {
        nomesParadas: nomesParadas as unknown as Prisma.InputJsonValue,
        horariosChegada,
      },
    });

    await this.syncOrderEtasFromStops(nomesParadas, horariosChegada);

    return updated;
  }

  private paradaEndereco(s: RouteStop | string): string | null {
    if (typeof s === 'string') {
      const t = s.trim();
      return t.length > 5 ? t : null;
    }
    if (s && typeof s === 'object' && typeof s.address === 'string') {
      const t = s.address.trim();
      return t.length > 5 ? t : null;
    }
    return null;
  }

  private dwellFromParada(s: RouteStop): number {
    const d = s?.serviceStopSeconds;
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
      return d;
    }
    return 300;
  }

  private resolveDepartureTimeForReorder(
    route: RotaEntrega,
    nomesParadas: RouteStop[],
  ): string | undefined {
    const fromIncoming = nomesParadas.find(
      (s) => typeof s === 'object' && typeof s?.routeDepartureTime === 'string',
    )?.routeDepartureTime;
    if (fromIncoming) return fromIncoming;

    const fromStoredStops = asRouteStops(route?.nomesParadas).find(
      (s) => typeof s.routeDepartureTime === 'string',
    )?.routeDepartureTime;
    if (fromStoredStops) return fromStoredStops;

    const fromHorarios = Array.isArray(route?.horariosChegada)
      ? route.horariosChegada[0]
      : undefined;
    return typeof fromHorarios === 'string' ? fromHorarios : undefined;
  }

  /**
   * Agrupa paradas consecutivas com o mesmo entregador (para multi-rota: um Directions por trecho).
   */
  private buildCourierSegments(
    nomesParadas: RouteStop[],
  ): { courierId: number; indices: number[]; addresses: string[] }[] {
    const segments: {
      courierId: number;
      indices: number[];
      addresses: string[];
    }[] = [];
    let current: {
      courierId: number;
      indices: number[];
      addresses: string[];
    } | null = null;
    for (let i = 0; i < nomesParadas.length; i++) {
      const s = nomesParadas[i];
      const cid =
        typeof s === 'object' &&
        s !== null &&
        s.courierId != null &&
        Number.isFinite(Number(s.courierId))
          ? Number(s.courierId)
          : 1;
      const addr = this.paradaEndereco(s);
      if (!addr) {
        throw new BadRequestException(
          `Parada ${i + 1} sem endereço válido; não é possível recalcular horários após reordenar.`,
        );
      }
      if (!current || current.courierId !== cid) {
        current = { courierId: cid, indices: [], addresses: [] };
        segments.push(current);
      }
      current.indices.push(i);
      current.addresses.push(addr);
    }
    return segments;
  }

  private async resolveOriginAddressForRouting(): Promise<string> {
    const config = await this.configuracoesService.get();
    const originAddress = formatRestaurantOrigin(
      asRestaurantAddress(config?.enderecoRestaurante),
    );
    if (!originAddress.trim()) {
      throw new BadRequestException(
        'Endereço do restaurante não configurado — necessário para recalcular horários da rota.',
      );
    }
    return originAddress.trim();
  }

  private async recalculateHorariosAfterReorder(
    nomesParadas: RouteStop[],
    departureTime?: string,
  ): Promise<string[]> {
    const originAddress = await this.resolveOriginAddressForRouting();
    const segments = this.buildCourierSegments(nomesParadas);
    const horariosChegada: string[] = new Array<string>(nomesParadas.length);

    for (const seg of segments) {
      if (seg.addresses.length === 0) continue;

      const waypointDwell = seg.indices
        .slice(0, seg.addresses.length - 1)
        .map((fullIdx) => this.dwellFromParada(nomesParadas[fullIdx]));

      const times = await this.routesService.arrivalsForFixedOrder(
        originAddress,
        seg.addresses,
        departureTime,
        waypointDwell.length === seg.addresses.length - 1
          ? waypointDwell
          : undefined,
      );

      if (times.length !== seg.indices.length) {
        this.logger.error(
          `recalculateHorariosAfterReorder: segment courier ${seg.courierId} — ` +
            `Google retornou ${times.length} pernas, esperado ${seg.indices.length}`,
        );
        throw new BadRequestException(
          'Não foi possível recalcular os horários (resposta inesperada do Google Maps). Tente novamente.',
        );
      }

      for (let k = 0; k < seg.indices.length; k++) {
        horariosChegada[seg.indices[k]] = times[k].toISOString();
      }
    }

    const fallback = new Date().toISOString();
    for (let i = 0; i < horariosChegada.length; i++) {
      if (!horariosChegada[i]) {
        horariosChegada[i] = fallback;
      }
    }

    return horariosChegada;
  }

  private async syncOrderEtasFromStops(
    stops: RouteStop[],
    horariosChegada: string[],
  ): Promise<void> {
    await Promise.all(
      stops.map(async (stop, index) => {
        const arrivalIso = horariosChegada[index];
        if (!arrivalIso) return;

        const targetOrderIds: number[] = [];
        if (stop?.orderId) targetOrderIds.push(Number(stop.orderId));
        if (stop?.orderIds && Array.isArray(stop.orderIds)) {
          targetOrderIds.push(...stop.orderIds.map((id: number) => Number(id)));
        }
        const uniqueOrderIds = Array.from(new Set(targetOrderIds)).filter(
          Boolean,
        );
        if (uniqueOrderIds.length === 0) return;

        await this.prisma.pedidoEncomenda.updateMany({
          where: { id: { in: uniqueOrderIds } },
          data: { horarioEstimadoEntrega: new Date(arrivalIso) },
        });
      }),
    );
  }

  async deleteRoute(formId: number) {
    // Clear arrival times from orders before deleting route
    await this.prisma.pedidoEncomenda.updateMany({
      where: { dataEncomendaId: formId },
      data: { horarioEstimadoEntrega: null },
    });

    return this.prisma.rotaEntrega.delete({
      where: { formId },
    });
  }

  async updateLocation(updateLocationDto: UpdateLocationDto) {
    const { formId, latitude, longitude, userId } = updateLocationDto;
    // courierId nunca deve ficar nulo: registros órfãos (courier_id NULL) faziam a
    // limpeza automática afetar a rota inteira e nunca removiam a própria linha.
    const courierId = updateLocationDto.courierId ?? 1;

    if (userId) {
      this.logger.debug(
        `Location update from user ${userId} for form ${formId}, courier route ${courierId}`,
      );
    }

    // Find existing location entry for this courier/form
    // Each courier route (1, 2, etc.) has its own location record.
    // Inclui linhas legadas com courierId NULL para que sejam normalizadas.
    const existing = await this.prisma.entregadorLocalizacao.findFirst({
      where: {
        formId,
        OR: [{ courierId }, { courierId: null }],
      },
      orderBy: { atualizadoEm: 'desc' },
    });

    const location = existing
      ? await this.prisma.entregadorLocalizacao.update({
          where: { id: existing.id },
          data: {
            latitude,
            longitude,
            atualizadoEm: new Date(),
            courierId,
            ...(userId && { userId }),
          },
        })
      : await this.prisma.entregadorLocalizacao.create({
          data: {
            formId,
            latitude,
            longitude,
            courierId,
            userId,
          },
        });

    // Auto-recuperação: se o rastreio foi encerrado por engano (queda de sinal,
    // limpeza automática, app reiniciado) e a localização voltou a chegar,
    // os pedidos precisam voltar a aparecer como "em entrega" para os clientes.
    const reactivatedOrderIds = await this.reactivateSharingIfNeeded(
      formId,
      courierId,
    );

    return { ...location, reactivatedOrderIds };
  }

  /**
   * Restaura `emEntrega` dos pedidos da rota quando a localização volta a ser
   * recebida mas o compartilhamento consta como parado no banco.
   * Throttled por form+courier para não consultar a cada ping de localização.
   */
  private async reactivateSharingIfNeeded(
    formId: number,
    courierId: number,
  ): Promise<number[]> {
    const key = `${formId}_${courierId}`;
    const now = Date.now();
    const lastRun = this.reactivationThrottle.get(key) ?? 0;
    if (now - lastRun < DeliveryService.REACTIVATION_THROTTLE_MS) return [];
    this.reactivationThrottle.set(key, now);

    try {
      const route = await this.prisma.rotaEntrega.findUnique({
        where: { formId },
      });
      if (!route?.nomesParadas) return [];

      const orderIds = this.collectOrderIds(
        asRouteStops(route.nomesParadas),
        courierId,
      );
      if (orderIds.length === 0) return [];

      const stale = await this.prisma.pedidoEncomenda.findMany({
        where: {
          id: { in: orderIds },
          emEntrega: false,
          statusPagamento: { notIn: ['entregue', 'cancelado'] },
        },
        select: { id: true },
      });
      if (stale.length === 0) return [];

      const staleIds = stale.map((o) => o.id);
      await this.prisma.pedidoEncomenda.updateMany({
        where: { id: { in: staleIds } },
        data: { emEntrega: true },
      });
      this.logger.log(
        `Rastreio reativado automaticamente para form ${formId} / courier ${courierId} (${staleIds.length} pedidos)`,
      );
      return staleIds;
    } catch (error) {
      this.logger.error(
        `Falha ao reativar rastreio do form ${formId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /** Extrai os orderIds das paradas, opcionalmente filtrando por entregador. */
  private collectOrderIds(stops: RouteStop[], courierId?: number): number[] {
    const relevant =
      courierId !== undefined
        ? stops.filter((stop) => stopCourierId(stop) === Number(courierId))
        : stops;

    return Array.from(new Set(relevant.flatMap((stop) => stopOrderIds(stop))));
  }

  async markDeliveryComplete(formId: number, paradaIdx: number) {
    const result = await this.prisma.entregaConcluida.upsert({
      where: {
        formId_paradaIdx: {
          formId,
          paradaIdx,
        },
      },
      update: {},
      create: {
        formId,
        paradaIdx,
      },
    });

    // Sync Order Status: Mark all orders at this stop as 'entregue'
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });
    if (route?.nomesParadas) {
      const stops = asRouteStops(route.nomesParadas);
      const stop = stops[paradaIdx];
      const ids: number[] = stop ? stopOrderIds(stop) : [];
      if (ids.length > 0) {
        await this.prisma.pedidoEncomenda.updateMany({
          where: { id: { in: ids } },
          data: {
            statusPagamento: 'entregue',
            emEntrega: false,
          },
        });
      }
      return { ...result, orderIds: ids };
    }

    return { ...result, orderIds: [] as number[] };
  }

  async unmarkDeliveryComplete(formId: number, paradaIdx: number) {
    const result = await this.prisma.entregaConcluida.deleteMany({
      where: {
        formId,
        paradaIdx,
      },
    });

    // Sync Order Status: Revert all orders at this stop
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });
    if (route?.nomesParadas) {
      const stops = asRouteStops(route.nomesParadas);
      const stop = stops[paradaIdx];
      const ids: number[] = stop ? stopOrderIds(stop) : [];
      if (ids.length > 0) {
        const orders = await this.prisma.pedidoEncomenda.findMany({
          where: { id: { in: ids } },
        });
        for (const order of orders) {
          let restoredStatus = 'pendente';
          if (order.dataPagamento) {
            restoredStatus = 'confirmado';
          } else if (order.comprovanteUrl) {
            restoredStatus = 'aguardando_confirmacao';
          }
          await this.prisma.pedidoEncomenda.update({
            where: { id: order.id },
            data: { statusPagamento: restoredStatus, emEntrega: true },
          });
        }
      }
    }

    return result;
  }

  async getActiveTracking(formId: number, courierId: number) {
    // Check if there's an active location tracking for this form + courier
    // Consider "active" if there was an update within the last 60 seconds
    const ACTIVE_THRESHOLD_SECONDS = 60;

    const location = await this.prisma.entregadorLocalizacao.findFirst({
      where: {
        formId,
        courierId,
      },
      orderBy: { atualizadoEm: 'desc' },
    });

    if (!location) {
      return { isActive: false, userId: null, lastUpdate: null };
    }

    const now = new Date();
    const lastUpdate = new Date(location.atualizadoEm);
    const diffSeconds = (now.getTime() - lastUpdate.getTime()) / 1000;

    const isActive = diffSeconds < ACTIVE_THRESHOLD_SECONDS;

    let userName: string | null = null;
    if (location.userId && isActive) {
      const user = await this.prisma.usuario.findUnique({
        where: { id: location.userId },
        select: { nome: true },
      });
      userName = user?.nome ?? null;
    }

    return {
      isActive,
      userId: location.userId ?? null,
      userName,
      lastUpdate: location.atualizadoEm,
      secondsAgo: Math.floor(diffSeconds),
    };
  }

  async startRouteSharing(formId: number, courierId?: number, userId?: string) {
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });

    if (!route || !route.nomesParadas) {
      throw new NotFoundException(`Route for form ${formId} not found`);
    }

    const stops = asRouteStops(route.nomesParadas);

    // Filter stops by courierId if provided (normalize to number for comparison)
    const relevantStops =
      courierId !== undefined
        ? stops.filter((stop) => Number(stop.courierId) === Number(courierId))
        : stops;

    const orderIds = Array.from(
      new Set(
        relevantStops.flatMap((stop) => {
          const ids: number[] = [];
          if (stop.orderId) ids.push(Number(stop.orderId));
          if (Array.isArray(stop.orderIds))
            ids.push(...stop.orderIds.map((id: any) => Number(id)));
          return ids;
        }),
      ),
    ).filter(Boolean);

    let updatedOrderIds: number[] = [];
    if (orderIds.length > 0) {
      // Use emEntrega flag instead of statusPagamento
      const updatable = await this.prisma.pedidoEncomenda.findMany({
        where: {
          id: { in: orderIds },
          // Do not update already delivered or cancelled orders
          statusPagamento: { notIn: ['entregue', 'cancelado'] },
        },
        select: { id: true },
      });
      updatedOrderIds = updatable.map((o) => o.id);
      if (updatedOrderIds.length > 0) {
        await this.prisma.pedidoEncomenda.updateMany({
          where: { id: { in: updatedOrderIds } },
          data: { emEntrega: true },
        });
      }
    }

    this.logger.debug(
      `Route sharing started for form ${formId}, courier ${courierId || 'all'}, by user ${userId || 'unknown'}, orders: ${updatedOrderIds.length}`,
    );

    let userName: string | null = null;
    if (userId) {
      const user = await this.prisma.usuario.findUnique({
        where: { id: userId },
        select: { nome: true },
      });
      userName = user?.nome ?? null;
    }

    return {
      success: true,
      updatedCount: updatedOrderIds.length,
      orderIds: updatedOrderIds,
      courierId,
      userId,
      userName,
    };
  }

  async stopRouteSharing(formId: number, courierId?: number) {
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });

    if (!route || !route.nomesParadas) {
      throw new NotFoundException(`Route for form ${formId} not found`);
    }

    const stops = asRouteStops(route.nomesParadas);

    // Filter stops by courierId if provided (normalize to number for comparison)
    const relevantStops =
      courierId !== undefined
        ? stops.filter((stop) => Number(stop.courierId) === Number(courierId))
        : stops;

    const orderIds = Array.from(
      new Set(
        relevantStops.flatMap((stop) => {
          const ids: number[] = [];
          if (stop.orderId) ids.push(Number(stop.orderId));
          if (Array.isArray(stop.orderIds))
            ids.push(...stop.orderIds.map((id: any) => Number(id)));
          return ids;
        }),
      ),
    ).filter(Boolean);

    if (orderIds.length > 0) {
      await this.prisma.pedidoEncomenda.updateMany({
        where: { id: { in: orderIds } },
        data: { emEntrega: false },
      });
    }

    // Clear location record to indicate tracking stopped.
    // Sem courierId, o pedido é "parar tudo desta rota" — inclusive linhas legadas
    // com courier_id NULL, que antes ficavam órfãs e reativavam a limpeza a cada minuto.
    await this.prisma.entregadorLocalizacao.deleteMany({
      where:
        courierId !== undefined
          ? { formId, OR: [{ courierId }, { courierId: null }] }
          : { formId },
    });

    // Libera o throttle para que uma retomada de localização reative o rastreio na hora
    this.reactivationThrottle.delete(`${formId}_${courierId ?? 1}`);

    return { success: true, updatedCount: orderIds.length, orderIds };
  }

  async getDeliveryStatus(formId: number, courierId?: number) {
    // Get completed deliveries
    const completed = await this.prisma.entregaConcluida.findMany({
      where: { formId },
    });

    // Build location query - filter by courierId if provided
    const locationWhere: Prisma.EntregadorLocalizacaoWhereInput = { formId };
    if (courierId !== undefined) {
      locationWhere.courierId = courierId;
    }

    // Get latest location for the specific courier
    const location = await this.prisma.entregadorLocalizacao.findFirst({
      where: locationWhere,
      orderBy: { atualizadoEm: 'desc' },
    });

    return {
      completedStops: completed.map((c) => c.paradaIdx),
      latestLocation: location,
      courierId: courierId || (location?.courierId ?? null),
    };
  }
  async calculateDynamicETAs(formId: number, courierId?: number) {
    const route = await this.prisma.rotaEntrega.findUnique({
      where: { formId },
    });

    if (!route) return null;

    const completed = await this.prisma.entregaConcluida.findMany({
      where: { formId },
    });

    const completedIdxs = completed.map((c) => c.paradaIdx);
    const stops = asRouteStops(route.nomesParadas);

    // Find latest location. If courierId provided, use it.
    const whereClause: Prisma.EntregadorLocalizacaoWhereInput = { formId };
    if (courierId) {
      whereClause.courierId = courierId;
    }

    const location = await this.prisma.entregadorLocalizacao.findFirst({
      where: whereClause,
      orderBy: { atualizadoEm: 'desc' },
    });

    if (!location) {
      this.logger.debug(
        `No location found for dynamic ETA calculation for formId ${formId}`,
      );
      return null;
    }

    // Get indices of pending stops
    let pendingStops = stops
      .map((s, idx) => ({ ...s, originalIdx: idx }))
      .filter((s, idx) => !completedIdxs.includes(idx));

    // Filter by courier if multi-courier route and courierId is known
    if (courierId !== undefined) {
      pendingStops = pendingStops.filter(
        (s) => Number(s.courierId) === Number(courierId),
      );
    }

    if (pendingStops.length === 0) return [];

    const pendingAddresses = pendingStops.map((s) => s.address);

    try {
      const dynamicArrivalTimes =
        await this.routesService.getEtaForRemainingStops(
          Number(location.latitude),
          Number(location.longitude),
          pendingAddresses,
        );

      // Map back to original indices
      return pendingStops.map((s, idx) => ({
        paradaIdx: s.originalIdx,
        eta: dynamicArrivalTimes[idx],
      }));
    } catch (error) {
      this.logger.error('Failed to calculate dynamic ETAs', error);
      return null;
    }
  }

  /**
   * Remove apenas as linhas de localização abandonadas (app fechado, aparelho desligado).
   *
   * IMPORTANTE: esta rotina NÃO encerra a entrega. Antes ela chamava `stopRouteSharing`
   * com um limiar de 2 minutos — menor que a própria parada planejada de 5 min
   * (`serviceStopSeconds`) — então zerava `emEntrega` de toda a rota a cada parada do
   * entregador, fazendo o botão "Rastrear" sumir para os clientes sem nenhuma
   * possibilidade de recuperação automática. `emEntrega` agora só muda por ação
   * explícita do entregador, por conclusão da parada ou pela auto-recuperação
   * em `updateLocation`.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleStaleTracking() {
    await this.cronLockService.withLock(
      CRON_LOCK_KEYS.STALE_TRACKING,
      'handleStaleTracking',
      async () => {
        const STALE_THRESHOLD_MINUTES = 20;
        const staleDate = new Date();
        staleDate.setMinutes(staleDate.getMinutes() - STALE_THRESHOLD_MINUTES);

        const { count } = await this.prisma.entregadorLocalizacao.deleteMany({
          where: {
            atualizadoEm: { lt: staleDate },
          },
        });

        if (count > 0) {
          this.logger.log(
            `Removidas ${count} localizações abandonadas (sem atualização há ${STALE_THRESHOLD_MINUTES}min). ` +
              `Status de entrega dos pedidos preservado.`,
          );
        }
      },
    );
  }
}

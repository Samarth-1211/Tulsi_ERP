import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LatLng, nearestNeighbourOrder, routeLengthKm } from '../utils/route-geometry.util';

/** A town or village found on OpenStreetMap. */
export interface OsmPlace {
  name: string;
  state: string | null;
  district: string | null;
  lat: number;
  lng: number;
}

export interface RoadRoute {
  geometry: LatLng[];
  distanceKm: number;
  durationMin: number;
  /** osrm = real roads; straight = the service was unreachable, a straight line between stops. */
  source: 'osrm' | 'straight';
}

const NOMINATIM_GAP_MS = 1100; // Nominatim usage policy: at most 1 request per second
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
// Straight-line fallback: roads run ~25% longer than the crow flies, at ~45 km/h average.
const ROAD_FACTOR = 1.25;
const AVG_KMH = 45;
const INDIA_BBOX = '68.1,6.5,97.4,35.7';
const PHOTON_PLACE_TAGS = ['place:city', 'place:town', 'place:village', 'place:suburb', 'place:hamlet'];
const AREA_TYPES = new Set(['state', 'state_district', 'district', 'county', 'region']);
const PLACE_ORDER = ['city', 'town', 'municipality', 'village', 'suburb', 'city_district', 'hamlet'];
const placeRank = (type?: string) => {
  const i = PLACE_ORDER.indexOf(type ?? '');
  return i < 0 ? PLACE_ORDER.length : i;
};

/**
 * OpenStreetMap, free and key-less: Nominatim for locating lead cities, Photon
 * for the search box, OSRM for road routes. Base URLs are configurable
 * (NOMINATIM_URL, PHOTON_URL, OSRM_URL) so a busy deployment can point at its
 * own instance; the defaults are the public ones, which ask for a real
 * User-Agent, ≤1 req/s (Nominatim) and caching — all done here.
 */
@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);
  private readonly nominatimUrl: string;
  private readonly osrmUrl: string;
  private readonly photonUrl: string;
  private readonly userAgent: string;
  private nominatimQueue: Promise<unknown> = Promise.resolve();
  private lastNominatimAt = 0;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(config: ConfigService) {
    this.nominatimUrl = (config.get<string>('NOMINATIM_URL') || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
    this.osrmUrl = (config.get<string>('OSRM_URL') || 'https://router.project-osrm.org').replace(/\/$/, '');
    this.photonUrl = (config.get<string>('PHOTON_URL') || 'https://photon.komoot.io').replace(/\/$/, '');
    const contact = config.get<string>('SMTP_FROM_EMAIL')?.trim() || 'admin@localhost';
    this.userAgent = `TulsiERP/1.0 (${contact})`;
  }

  /** Towns and villages in India matching `query`, best first. Throws when OSM can't be reached. */
  async searchPlaces(query: string, limit = 5): Promise<OsmPlace[]> {
    const q = query.trim();
    if (!q) return [];
    return this.cached(`search:${limit}:${q.toLowerCase()}`, () =>
      this.throttledNominatim(async () => {
        const url = new URL(`${this.nominatimUrl}/search`);
        url.search = new URLSearchParams({
          q,
          countrycodes: 'in',
          featureType: 'settlement',
          format: 'jsonv2',
          addressdetails: '1',
          'accept-language': 'en',
          limit: String(limit),
        }).toString();
        const rows = await this.getJson<any[]>(url.toString());
        // A district or county shares the town's name but sits at its centre, often 20+ km away.
        return rows
          .filter((r) => !AREA_TYPES.has(r.addresstype))
          .sort((a, b) => placeRank(a.addresstype) - placeRank(b.addresstype))
          .map((r) => ({
          name: String(r.name || r.display_name?.split(',')[0] || q),
          state: r.address?.state ?? null,
          district: r.address?.state_district ?? r.address?.county ?? null,
          lat: Number(r.lat),
          lng: Number(r.lon),
        }));
      }),
    );
  }

  /**
   * Search-as-you-type for the From / To / stop box — Photon, which is built
   * for it (Nominatim's policy forbids autocomplete). Indian towns and villages
   * only, ranked toward `near` (the business's area) when given.
   */
  async suggestPlaces(query: string, near?: LatLng | null, limit = 6): Promise<OsmPlace[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const bias = near ? `${near[0].toFixed(2)},${near[1].toFixed(2)}` : '';
    return this.cached(`suggest:${bias}:${q.toLowerCase()}`, async () => {
      const params = new URLSearchParams({ q, limit: String(limit * 2), lang: 'en', bbox: INDIA_BBOX });
      PHOTON_PLACE_TAGS.forEach((tag) => params.append('osm_tag', tag));
      if (near) {
        params.set('lat', String(near[0]));
        params.set('lon', String(near[1]));
      }
      const body = await this.getJson<any>(`${this.photonUrl}/api/?${params}`);
      const seen = new Set<string>();
      return (body?.features ?? [])
        .filter((f: any) => f.properties?.countrycode === 'IN')
        // Cities and towns before villages ("jabal" → Jabalpur, not a hamlet called Jabal); stable otherwise.
        .sort((a: any, b: any) => placeRank(a.properties.osm_value) - placeRank(b.properties.osm_value))
        .map((f: any) => ({
          name: String(f.properties.name),
          state: f.properties.state ?? null,
          district: f.properties.county ?? f.properties.district ?? null,
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
        }))
        .filter((p: OsmPlace) => {
          const k = `${p.name.toLowerCase()}:${p.lat.toFixed(1)}:${p.lng.toFixed(1)}`;
          return !seen.has(k) && seen.add(k);
        })
        .slice(0, limit);
    });
  }

  /**
   * Shortest driving order for `stops`, keeping the first and last in place
   * (OSRM's trip service). Returns indices into `stops`; nearest-next by
   * straight line when OSRM is unreachable.
   */
  async bestOrder(stops: LatLng[]): Promise<{ order: number[]; source: 'osrm' | 'straight' }> {
    if (stops.length <= 3) return { order: stops.map((_, i) => i), source: 'osrm' };
    try {
      const coords = stops.map(([lat, lng]) => `${lng},${lat}`).join(';');
      const body = await this.getJson<any>(
        `${this.osrmUrl}/trip/v1/driving/${coords}?source=first&destination=last&roundtrip=false&overview=false`,
      );
      if (body?.code !== 'Ok' || !Array.isArray(body.waypoints)) throw new Error(`OSRM trip: ${body?.code ?? 'no trip'}`);
      // waypoints[i].waypoint_index = where input stop i comes in the trip.
      const order = (body.waypoints as { waypoint_index: number }[])
        .map((w, i) => ({ i, at: w.waypoint_index }))
        .sort((a, b) => a.at - b.at)
        .map((w) => w.i);
      return { order, source: 'osrm' };
    } catch (error) {
      this.logger.warn(`Trip optimisation unavailable, using nearest-next: ${error}`);
      return { order: nearestNeighbourOrder(stops), source: 'straight' };
    }
  }

  /** Driving route through `stops` in order; a straight line when OSRM is unreachable. */
  async route(stops: LatLng[]): Promise<RoadRoute> {
    const key = `route:${stops.map(([a, b]) => `${a.toFixed(4)},${b.toFixed(4)}`).join(';')}`;
    try {
      return await this.cached(key, async () => {
        const coords = stops.map(([lat, lng]) => `${lng},${lat}`).join(';');
        const body = await this.getJson<any>(`${this.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`);
        const r = body?.routes?.[0];
        if (body?.code !== 'Ok' || !r) throw new Error(`OSRM: ${body?.code ?? 'no route'}`);
        return {
          geometry: (r.geometry.coordinates as [number, number][]).map(([lng, lat]) => [lat, lng] as LatLng),
          distanceKm: r.distance / 1000,
          durationMin: r.duration / 60,
          source: 'osrm' as const,
        };
      });
    } catch (error) {
      this.logger.warn(`Road route unavailable, using a straight line: ${error}`);
      const distanceKm = routeLengthKm(stops) * ROAD_FACTOR;
      return { geometry: stops, distanceKm, durationMin: (distanceKm / AVG_KMH) * 60, source: 'straight' };
    }
  }

  private throttledNominatim<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.nominatimQueue.then(async () => {
      const wait = this.lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.lastNominatimAt = Date.now();
      }
    });
    this.nominatimQueue = run.catch(() => undefined);
    return run;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as T;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

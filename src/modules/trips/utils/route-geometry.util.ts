/** [lat, lng] in degrees. */
export type LatLng = [number, number];

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Where a point sits relative to a route: km off the road, and km along it to the nearest spot. */
export interface RoutePosition {
  offKm: number;
  alongKm: number;
}

/**
 * Nearest point of the route polyline to `p`. Each segment is projected onto
 * a local flat plane (fine at the few-hundred-km scale of a sales trip).
 */
export function positionOnRoute(route: LatLng[], p: LatLng): RoutePosition {
  if (route.length === 0) return { offKm: Infinity, alongKm: 0 };
  if (route.length === 1) return { offKm: haversineKm(route[0], p), alongKm: 0 };

  const kx = EARTH_KM * Math.cos(rad(p[0])) * (Math.PI / 180); // km per degree of longitude here
  const ky = EARTH_KM * (Math.PI / 180); // km per degree of latitude
  let best: RoutePosition = { offKm: Infinity, alongKm: 0 };
  let walked = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const ax = (a[1] - p[1]) * kx;
    const ay = (a[0] - p[0]) * ky;
    const bx = (b[1] - p[1]) * kx;
    const by = (b[0] - p[0]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    const segKm = Math.sqrt(len2);
    if (off < best.offKm) best = { offKm: off, alongKm: walked + t * segKm };
    walked += segKm;
  }
  return best;
}

/** Total length of the polyline in km. */
export function routeLengthKm(route: LatLng[]): number {
  let km = 0;
  for (let i = 0; i < route.length - 1; i++) km += haversineKm(route[i], route[i + 1]);
  return km;
}

/**
 * Thins a long polyline for storage / the map: keeps every point at least
 * `minKm` from the last kept one, plus the last point.
 */
export function thinRoute(route: LatLng[], minKm = 2): LatLng[] {
  if (route.length <= 2) return route;
  const out: LatLng[] = [route[0]];
  for (let i = 1; i < route.length - 1; i++) {
    if (haversineKm(out[out.length - 1], route[i]) >= minKm) out.push(route[i]);
  }
  out.push(route[route.length - 1]);
  return out.map(([lat, lng]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
}

/**
 * Spelling variants worth asking the map about when a typed city isn't found
 * ("Devas" → "Dewas", "Peethampur" → "Pithampur"). Order: most likely first.
 */
export function spellingVariants(name: string): string[] {
  const n = name.trim();
  const swaps: [RegExp, string][] = [
    [/v/gi, 'w'],
    [/w/gi, 'v'],
    [/([aeiou])([bcdfgjklmnpqrstvxz])(?=[aeiou])/i, '$1$2$2'], // Ujain → Ujjain (first one only)
    [/ee/gi, 'i'],
    [/i/gi, 'ee'],
    [/oo/gi, 'u'],
    [/u/gi, 'oo'],
    [/([bcdfgjklmnpqrstvwxz])\1/gi, '$1'],
    [/([kgcjtdpb])h/gi, '$1'],
    [/a$/i, ''],
    [/$/, 'a'],
  ];
  const seen = new Set([n.toLowerCase()]);
  const out: string[] = [];
  for (const [re, to] of swaps) {
    const v = n.replace(re, to);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v.charAt(0).toUpperCase() + v.slice(1));
    }
  }
  return out;
}

/**
 * Visiting order for stops when the routing service can't optimise: first and
 * last stay put, the middle ones by nearest-next. Returns indices into `points`.
 */
export function nearestNeighbourOrder(points: LatLng[]): number[] {
  if (points.length <= 3) return points.map((_, i) => i);
  const last = points.length - 1;
  const left = new Set(points.map((_, i) => i).slice(1, last));
  const order = [0];
  while (left.size) {
    const here = points[order[order.length - 1]];
    let best = -1;
    for (const i of left) if (best < 0 || haversineKm(here, points[i]) < haversineKm(here, points[best])) best = i;
    order.push(best);
    left.delete(best);
  }
  order.push(last);
  return order;
}

// A side trip off the main road: there and back, ~30% longer than the crow flies, ~40 km/h.
const DETOUR_ROAD_FACTOR = 1.3;
const DETOUR_KMH = 40;

/** Rough extra driving for a side trip to a city `offKm` from the road (shown as "about"). */
export function detourEstimate(offKm: number): { extraKm: number; extraMin: number } {
  const extraKm = 2 * offKm * DETOUR_ROAD_FACTOR;
  return { extraKm, extraMin: (extraKm / DETOUR_KMH) * 60 };
}

/**
 * Where a city sits on the trip: around the start or the end (closer to that
 * end than to the road itself — e.g. Mhow on an Indore → Delhi trip), or
 * genuinely on the way.
 */
export function routeZone(pos: RoutePosition, routeKm: number): 'start' | 'end' | 'route' {
  if (pos.alongKm < pos.offKm) return 'start';
  if (routeKm - pos.alongKm < pos.offKm) return 'end';
  return 'route';
}

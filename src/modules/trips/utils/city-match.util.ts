import { phoneticKey } from '../../../common/utils/phonetic-key.util';
import { OsmPlace } from '../services/osm.service';
import { LatLng, haversineKm } from './route-geometry.util';

const LATIN = /^[\x20-\x7E]+$/;

/** Same name when spoken: "Devas" ≈ "Dewas" ≈ "देवास". */
export function soundsSame(a: string, b: string): boolean {
  const ka = phoneticKey(a).trim();
  return ka.length > 0 && ka === phoneticKey(b).trim();
}

/** "INDORE " → "Indore", "dr. ambedkar nagar" → "Dr. Ambedkar Nagar"; Devanagari unchanged. */
export function tidyCityName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!LATIN.test(n)) return n;
  return n.toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

/** A wholesaler's leads come from its own region: a "match" farther than this from its base is a namesake. */
export const MAX_KM_FROM_BASE = 400;

/**
 * Which search result (if any) is the city the user typed.
 *  - With a state, results outside it are ignored.
 *  - With a base (the middle of the org's located cities, or its own city),
 *    results more than MAX_KM_FROM_BASE away are ignored and the nearest wins
 *    — so "इंदौर" can't land on a village called Indor in another state.
 *  - For the typed name itself, OSM's best match is trusted (it also matches
 *    official alternate names: "Mhow" finds Dr. Ambedkar Nagar).
 *  - For a spelling variant we made up, the result must sound like what was
 *    typed — otherwise "Devas" could land on any town spelt "Dewa…".
 */
export function pickPlace(
  typed: string,
  results: OsmPlace[],
  opts: { isVariant: boolean; state?: string | null; base?: LatLng | null },
): OsmPlace | null {
  let candidates = opts.state ? results.filter((r) => r.state?.toLowerCase() === opts.state!.toLowerCase()) : results;
  if (opts.base) {
    const km = (r: OsmPlace) => haversineKm(opts.base!, [r.lat, r.lng]);
    candidates = candidates.filter((r) => km(r) <= MAX_KM_FROM_BASE);
    // Same-name towns: the one nearest the business. OSM's order is kept otherwise.
    if (opts.isVariant) candidates = [...candidates].sort((a, b) => km(a) - km(b));
  }
  if (opts.isVariant) candidates = candidates.filter((r) => soundsSame(r.name, typed));
  return candidates[0] ?? null;
}

/** Middle of a set of points (component-wise median — one far-off city doesn't drag it). */
export function medianPoint(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const mid = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  return [mid(points.map((p) => p[0])), mid(points.map((p) => p[1]))];
}

/** Latin-script names first, so "इंदौर" finds an already-located "Indore" to merge into. */
export function latinFirst<T extends { name: string }>(cities: T[]): T[] {
  return [...cities].sort((a, b) => Number(!LATIN.test(a.name)) - Number(!LATIN.test(b.name)));
}

/**
 * The name to keep: OSM's spelling when it is the same name spelt right
 * ("Devas"/"देवास" → "Dewas"), otherwise what the user typed ("Mhow" stays
 * Mhow rather than becoming "Dr. Ambedkar Nagar").
 */
export function correctedName(typed: string, place: OsmPlace): string {
  return LATIN.test(place.name) && soundsSame(place.name, typed) ? tidyCityName(place.name) : tidyCityName(typed);
}

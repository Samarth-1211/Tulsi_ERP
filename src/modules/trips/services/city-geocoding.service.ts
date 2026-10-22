import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { City, CityGeoStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { OsmService } from './osm.service';
import { correctedName, latinFirst, medianPoint, pickPlace, soundsSame, tidyCityName } from '../utils/city-match.util';
import { LatLng, spellingVariants } from '../utils/route-geometry.util';

const SWEEP_MS = 20_000;
const CITIES_PER_SWEEP = 10;
const MAX_ATTEMPTS = 3;
const MAX_VARIANTS = 6;
const LOCATED: CityGeoStatus[] = [CityGeoStatus.FOUND, CityGeoStatus.MANUAL];

type Tx = Prisma.TransactionClient;

/**
 * Puts the org's lead cities on the map (OpenStreetMap) and fixes their
 * spelling. Every 20 s it takes a few PENDING cities and, in order:
 *  1. if it sounds like a city the org already has located ("Devas" ≈ Dewas),
 *     merges into it — no lookup needed;
 *  2. searches OSM for the name, preferring the org's state;
 *  3. tries spelling variants that sound the same.
 * A corrected spelling renames the city (or merges it into the existing one),
 * keeps the typed spelling as an alias and renames its leads. Three misses →
 * NOT_FOUND, for an Admin to place by hand.
 */
@Injectable()
export class CityGeocodingService {
  private readonly logger = new Logger(CityGeocodingService.name);
  private running = false;
  /** Org id → its own city on the map (only needed until it has located lead cities). */
  private readonly orgBase = new Map<string, LatLng | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly osm: OsmService,
  ) {}

  @Interval(SWEEP_MS)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.prisma.city.findMany({
        where: { geoStatus: CityGeoStatus.PENDING, geoAttempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
        take: CITIES_PER_SWEEP * 5,
      });
      for (const city of latinFirst(pending).slice(0, CITIES_PER_SWEEP)) await this.locate(city);
      await this.renameLeadsToCityNames();
    } catch (error) {
      // OSM unreachable: leave the cities PENDING and try again next sweep.
      this.logger.warn(`City geocoding paused: ${error}`);
    } finally {
      this.running = false;
    }
  }

  /** Finds one city; network errors propagate so the sweep can back off. */
  async locate(city: City): Promise<void> {
    const sibling = await this.findSoundAlike(city);
    if (sibling) {
      await this.prisma.$transaction((tx) => this.merge(tx, city, sibling));
      this.logger.log(`City "${city.name}" merged into "${sibling.name}"`);
      return;
    }

    const { state, base } = await this.regionOf(city.orgId);
    const queries: { q: string; isVariant: boolean }[] = [
      { q: city.name, isVariant: false },
      ...spellingVariants(city.name)
        .slice(0, MAX_VARIANTS)
        .map((q) => ({ q, isVariant: true })),
    ];

    let place = null;
    for (const { q, isVariant } of queries) {
      place = pickPlace(city.name, await this.osm.searchPlaces(state ? `${q}, ${state}` : q), { isVariant, state, base });
      if (place) break;
    }
    // A lead just across the state border: only near the business, never a namesake far away.
    if (!place && state && base) place = pickPlace(city.name, await this.osm.searchPlaces(city.name), { isVariant: false, base });

    if (!place) {
      const attempts = city.geoAttempts + 1;
      await this.prisma.city.update({
        where: { id: city.id },
        data: { geoAttempts: attempts, geoStatus: attempts >= MAX_ATTEMPTS ? CityGeoStatus.NOT_FOUND : CityGeoStatus.PENDING },
      });
      return;
    }

    await this.place(city, correctedName(city.name, place), { lat: place.lat, lng: place.lng, state: place.state }, CityGeoStatus.FOUND);
  }

  // ─────────── Admin: GET /cities, PATCH /cities/:id, POST /cities/:id/locate ───────────

  async list(actor: AuthenticatedUser) {
    const [cities, counts] = await Promise.all([
      this.prisma.city.findMany({ where: { orgId: actor.orgId }, orderBy: { name: 'asc' } }),
      this.prisma.lead.groupBy({ by: ['city'], where: { orgId: actor.orgId, deletedAt: null, city: { not: null } }, _count: { _all: true } }),
    ]);
    const byKey = new Map<string, number>();
    for (const c of counts) {
      const k = c.city!.trim().toLowerCase();
      byKey.set(k, (byKey.get(k) ?? 0) + c._count._all);
    }
    return cities.map((c) => ({
      id: c.id,
      name: c.name,
      state: c.state,
      lat: c.lat,
      lng: c.lng,
      geoStatus: c.geoStatus,
      aliases: c.aliases,
      leads: [c.key, ...c.aliases].reduce((sum, k) => sum + (byKey.get(k) ?? 0), 0),
    }));
  }

  /** An Admin renames and/or places a city by hand; renaming onto an existing city merges them. */
  async update(actor: AuthenticatedUser, id: string, dto: { name?: string; lat?: number; lng?: number }) {
    const city = await this.prisma.city.findFirst({ where: { id, orgId: actor.orgId } });
    if (!city) throw new NotFoundException('City not found');
    if ((dto.lat === undefined) !== (dto.lng === undefined)) throw new BadRequestException('Send lat and lng together');
    const name = dto.name?.trim() ? tidyCityName(dto.name) : city.name;
    const coords = dto.lat !== undefined ? { lat: dto.lat, lng: dto.lng!, state: city.state } : { lat: city.lat, lng: city.lng, state: city.state };
    const merged = await this.place(city, name, coords, coords.lat !== null ? CityGeoStatus.MANUAL : city.geoStatus);
    await this.renameLeadsToCityNames();
    return merged;
  }

  /** Look the city up on the map again (after fixing a typo in a lead, say). */
  async retry(actor: AuthenticatedUser, id: string) {
    const { count } = await this.prisma.city.updateMany({
      where: { id, orgId: actor.orgId },
      data: { geoStatus: CityGeoStatus.PENDING, geoAttempts: 0 },
    });
    if (count === 0) throw new NotFoundException('City not found');
    void this.sweep();
    return { id, geoStatus: CityGeoStatus.PENDING };
  }

  // ─────────── Internals ───────────

  /** Applies a name + location to a city, merging into another city that already has that name. */
  private async place(
    city: City,
    name: string,
    coords: { lat: number | null; lng: number | null; state: string | null },
    status: CityGeoStatus,
  ) {
    const key = name.toLowerCase();
    return this.prisma.$transaction(async (tx) => {
      if (key !== city.key) {
        const existing = await tx.city.findUnique({ where: { orgId_key: { orgId: city.orgId, key } } });
        if (existing) {
          const into = existing.lat === null && coords.lat !== null
            ? await tx.city.update({ where: { id: existing.id }, data: { ...coords, geoStatus: status, geocodedAt: new Date() } })
            : existing;
          return this.merge(tx, city, into);
        }
      }
      return tx.city.update({
        where: { id: city.id },
        data: {
          name,
          key,
          ...coords,
          geoStatus: status,
          geocodedAt: new Date(),
          aliases: key !== city.key ? [...new Set([...city.aliases, city.key])] : city.aliases,
        },
      });
    });
  }

  /** Folds `from` into `into`: its spellings become aliases, saved trips point at `into`. */
  private async merge(tx: Tx, from: City, into: City) {
    const aliases = [...new Set([...into.aliases, from.key, ...from.aliases])].filter((a) => a !== into.key);
    await tx.$executeRaw`UPDATE trips SET "cityIds" = array_replace("cityIds", ${from.id}, ${into.id}) WHERE "orgId" = ${from.orgId}`;
    await tx.city.delete({ where: { id: from.id } });
    return tx.city.update({ where: { id: into.id }, data: { aliases } });
  }

  /** A located city of the same org whose name sounds the same. */
  private async findSoundAlike(city: City): Promise<City | null> {
    const located = await this.prisma.city.findMany({
      where: { orgId: city.orgId, id: { not: city.id }, geoStatus: { in: LOCATED } },
    });
    return located.find((c) => soundsSame(c.name, city.name)) ?? null;
  }

  /**
   * Where the business is: its state, and a base point — the middle of its
   * located cities, or (before any) its own city from the organization profile.
   */
  private async regionOf(orgId: string): Promise<{ state: string | null; base: LatLng | null }> {
    const state = await this.preferredState(orgId);
    const located = await this.prisma.city.findMany({
      where: { orgId, geoStatus: { in: LOCATED }, lat: { not: null } },
      select: { lat: true, lng: true },
    });
    let base = medianPoint(located.map((c) => [c.lat!, c.lng!] as LatLng));
    if (!base) {
      if (!this.orgBase.has(orgId)) {
        const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { city: true } });
        const home = org?.city?.trim()
          ? (await this.osm.searchPlaces(state ? `${org.city.trim()}, ${state}` : org.city.trim(), 1))[0]
          : undefined;
        this.orgBase.set(orgId, home ? [home.lat, home.lng] : null);
      }
      base = this.orgBase.get(orgId) ?? null;
    }
    return { state, base };
  }

  /** The org's state, else the state most of its located cities are in. */
  private async preferredState(orgId: string): Promise<string | null> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { state: true } });
    // A full state name only — an abbreviation ("MP") matches nothing OSM returns.
    if (org?.state && org.state.trim().length > 3) return org.state.trim();
    const states = await this.prisma.city.groupBy({
      by: ['state'],
      where: { orgId, state: { not: null }, geoStatus: { in: LOCATED } },
      _count: { _all: true },
      orderBy: { _count: { state: 'desc' } },
      take: 1,
    });
    return states[0]?.state ?? null;
  }

  /** Leads typed with an old spelling (or casing) take their city's current name. */
  private renameLeadsToCityNames() {
    return this.prisma.$executeRaw`
      UPDATE "Lead" l SET city = c.name
      FROM cities c
      WHERE l."orgId" = c."orgId" AND l.city IS NOT NULL AND l.city <> c.name
        AND c."geoStatus" IN ('FOUND'::"CityGeoStatus", 'MANUAL'::"CityGeoStatus")
        AND (lower(trim(l.city)) = c.key OR lower(trim(l.city)) = ANY(c.aliases))`;
  }
}

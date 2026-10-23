import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { City, LeadStatus, NotificationType, Prisma, Role, TaskStatus, TaskType, Trip, TripLeadFilter, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { leadVisibilityWhere } from '../../../common/utils/lead-scope.util';
import { phoneticKey } from '../../../common/utils/phonetic-key.util';
import { businessDayEndInstant } from '../../../common/utils/business-date.util';
import { OsmService, OsmPlace } from './osm.service';
import { medianPoint, soundsSame } from '../utils/city-match.util';
import { LatLng, detourEstimate, positionOnRoute, routeZone, thinRoute } from '../utils/route-geometry.util';
import { CreateTripDto, PlanTripDto, TripStopDto, UpdateTripDto } from '../dto/trip.dto';

const OPEN: LeadStatus[] = [LeadStatus.NEW, LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS];
const DEFAULT_CORRIDOR_KM = 20;
const MAX_TRIP_LEADS = 1000;
// Visit tasks are due at 11:00 IST on the trip day (the date column is UTC midnight).
const VISIT_TIME_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function statusesFor(filter: TripLeadFilter = TripLeadFilter.OPEN, includeLost = false): LeadStatus[] {
  const base =
    filter === TripLeadFilter.CONVERTED ? [LeadStatus.CONVERTED] : filter === TripLeadFilter.ALL ? [...OPEN, LeadStatus.CONVERTED] : OPEN;
  return includeLost ? [...base, LeadStatus.LOST] : base;
}

/** Leads of one city for the trip filter: open, already customers, lost (when included), follow-ups due today. */
export interface CityLeadStats {
  total: number;
  open: number;
  converted: number;
  lost: number;
  due: number;
}

const emptyStats = (): CityLeadStats => ({ total: 0, open: 0, converted: 0, lost: 0, due: 0 });
// Detour suggestions: lead cities up to this far off the road (beyond it, it's a different trip).
const MAX_DETOUR_OFF_KM = 120;
const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;

const TRIP_LEAD_SELECT = {
  id: true,
  name: true,
  phone: true,
  altPhone: true,
  city: true,
  address: true,
  pincode: true,
  status: true,
  buyingFor: true,
  requirementNotes: true,
  nextFollowUpAt: true,
  lastActivityAt: true,
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.LeadSelect;

const TRIP_INCLUDE = {
  createdBy: { select: { id: true, name: true, role: true } },
  members: { select: { user: { select: { id: true, name: true, role: true } } }, orderBy: { createdAt: 'asc' } },
  _count: { select: { tasks: true } },
} satisfies Prisma.TripInclude;

type TripWithPeople = Prisma.TripGetPayload<{ include: typeof TRIP_INCLUDE }>;

/**
 * Trip planner: which lead cities lie on the road between the stops, their
 * leads, and saved trips shared with colleagues.
 *
 * Lead visibility follows the usual scope (Admin: org, Manager: own + team,
 * Caller: own). A saved trip shows everyone it is shared with the leads its
 * planner can see — sharing is how a Manager hands a route to a caller or a
 * delivery partner.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly osm: OsmService,
  ) {}

  // ─────────── Planning ───────────

  /** From / To / stop search: the org's own lead cities first, then towns from OpenStreetMap. */
  async places(actor: AuthenticatedUser, q?: string) {
    const term = q?.trim() ?? '';
    if (term.length < 2) return [];
    const key = phoneticKey(term).trim();
    const lower = term.toLowerCase();
    const located = await this.prisma.city.findMany({ where: { orgId: actor.orgId, lat: { not: null } }, orderBy: { name: 'asc' } });
    const own = located
      .filter((c) => c.name.toLowerCase().includes(lower) || phoneticKey(c.name).trim().startsWith(key))
      .slice(0, 5)
      .map((c) => ({ name: c.name, state: c.state, district: null, lat: c.lat!, lng: c.lng!, cityId: c.id, source: 'org' as const }));

    let found: OsmPlace[] = [];
    try {
      found = await this.osm.suggestPlaces(term, medianPoint(located.map((c) => [c.lat!, c.lng!] as LatLng)));
    } catch {
      // OpenStreetMap unreachable — the org's own cities still work.
    }
    const extra = found
      .filter((p) => !own.some((o) => soundsSame(o.name, p.name) && Math.abs(o.lat - p.lat) < 0.2 && Math.abs(o.lng - p.lng) < 0.2))
      .map((p) => ({ ...p, cityId: null, source: 'osm' as const }));
    return [...own, ...extra].slice(0, 8);
  }

  /** GET /trips/cities — every located lead city with its counts (the "how many leads where" map). */
  async cities(actor: AuthenticatedUser, filter?: TripLeadFilter, includeLost = false) {
    const { cities, stats } = await this.cityStats(actor, filter, includeLost);
    const withLeads = cities.filter((c) => (stats.get(c.id)?.total ?? 0) > 0);
    return {
      cities: withLeads
        .filter((c) => c.lat !== null)
        .map((c) => ({ id: c.id, name: c.name, state: c.state, lat: c.lat, lng: c.lng, leads: stats.get(c.id)! }))
        .sort((a, b) => b.leads.total - a.leads.total),
      notOnMap: withLeads.filter((c) => c.lat === null).map((c) => ({ id: c.id, name: c.name, geoStatus: c.geoStatus, leads: stats.get(c.id)! })),
    };
  }

  /**
   * POST /trips/plan — the road between the stops, the lead cities within
   * `corridorKm` of it in travel order (each marked as around the start, on
   * the way, or around the end), and farther cities worth a detour with
   * their rough extra km / minutes.
   */
  async plan(actor: AuthenticatedUser, dto: PlanTripDto) {
    const corridorKm = dto.corridorKm ?? DEFAULT_CORRIDOR_KM;
    const route = await this.osm.route(dto.stops.map((s) => [s.lat, s.lng] as LatLng));
    const { cities, stats } = await this.cityStats(actor, dto.leadFilter, dto.includeLost);

    const placed = cities
      .filter((c) => c.lat !== null && (stats.get(c.id)?.total ?? 0) > 0)
      .map((c) => ({ c, pos: positionOnRoute(route.geometry, [c.lat!, c.lng!]) }));
    const along = placed.filter(({ pos }) => pos.offKm <= corridorKm).sort((a, b) => a.pos.alongKm - b.pos.alongKm);
    const detours = placed
      .filter(({ pos }) => pos.offKm > corridorKm && pos.offKm <= MAX_DETOUR_OFF_KM)
      .map(({ c, pos }) => ({ c, pos, ...detourEstimate(pos.offKm) }))
      // Most leads for the extra driving first.
      .sort((a, b) => stats.get(b.c.id)!.total / b.extraKm - stats.get(a.c.id)!.total / a.extraKm);

    const totals = along.reduce((t, { c }) => {
      const s = stats.get(c.id)!;
      return { ...t, cities: t.cities + 1, leads: t.leads + s.total, due: t.due + s.due };
    }, { cities: 0, leads: 0, due: 0 });

    return {
      route: {
        distanceKm: round(route.distanceKm, 1),
        durationMin: round(route.durationMin),
        source: route.source,
        geometry: thinRoute(route.geometry),
      },
      cities: along.map(({ c, pos }) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        lat: c.lat,
        lng: c.lng,
        offKm: round(pos.offKm, 1),
        alongKm: round(pos.alongKm),
        zone: routeZone(pos, route.distanceKm),
        leads: stats.get(c.id)!,
      })),
      detours: detours.map(({ c, pos, extraKm, extraMin }) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        lat: c.lat,
        lng: c.lng,
        offKm: round(pos.offKm, 1),
        alongKm: round(pos.alongKm),
        extraKm: round(extraKm),
        extraMin: round(extraMin),
        leads: stats.get(c.id)!,
      })),
      totals,
      // Lead cities not on the map yet can't be placed on a route — the page says how many.
      notOnMap: cities.filter((c) => c.lat === null && (stats.get(c.id)?.total ?? 0) > 0).length,
    };
  }

  /**
   * POST /trips/optimise — the stops in the shortest driving order (first and
   * last stay put), with the route before and after so the page can show the saving.
   */
  async optimise(stops: TripStopDto[]) {
    const points = stops.map((s) => [s.lat, s.lng] as LatLng);
    const [{ order, source }, before] = await Promise.all([this.osm.bestOrder(points), this.osm.route(points)]);
    const ordered = order.map((i) => stops[i]);
    const after = await this.osm.route(ordered.map((s) => [s.lat, s.lng] as LatLng));
    const summary = (r: { distanceKm: number; durationMin: number }) => ({ distanceKm: round(r.distanceKm, 1), durationMin: round(r.durationMin) });
    return { stops: this.cleanStops(ordered), source, before: summary(before), after: summary(after) };
  }

  /** POST /trips/leads — the actor's leads in the picked cities, grouped by city in the given order. */
  leads(actor: AuthenticatedUser, cityIds: string[], filter?: TripLeadFilter, includeLost = false) {
    return this.leadsIn(actor, cityIds, filter, includeLost);
  }

  // ─────────── Saved trips ───────────

  async list(actor: AuthenticatedUser) {
    const trips = await this.prisma.trip.findMany({
      where: {
        orgId: actor.orgId,
        ...(actor.role === Role.ADMIN ? {} : { OR: [{ createdById: actor.userId }, { members: { some: { userId: actor.userId } } }] }),
      },
      include: TRIP_INCLUDE,
      orderBy: [{ tripDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 100,
    });
    return trips.map((t) => this.present(actor, t));
  }

  async get(actor: AuthenticatedUser, id: string) {
    const trip = await this.load(actor, id, 'view');
    const cities = await this.prisma.city.findMany({ where: { id: { in: trip.cityIds }, orgId: actor.orgId } });
    const byId = new Map(cities.map((c) => [c.id, c]));
    return {
      ...this.present(actor, trip),
      cities: trip.cityIds
        .map((cid) => byId.get(cid))
        .filter((c): c is City => !!c)
        .map((c) => ({ id: c.id, name: c.name, state: c.state, lat: c.lat, lng: c.lng })),
    };
  }

  async create(actor: AuthenticatedUser, dto: CreateTripDto) {
    const route = await this.osm.route(dto.stops.map((s) => [s.lat, s.lng] as LatLng));
    const trip = await this.prisma.trip.create({
      data: {
        orgId: actor.orgId,
        createdById: actor.userId,
        name: dto.name.trim(),
        tripDate: dto.tripDate ? new Date(dto.tripDate.slice(0, 10)) : null,
        notes: dto.notes?.trim() || null,
        stops: this.cleanStops(dto.stops),
        corridorKm: dto.corridorKm ?? DEFAULT_CORRIDOR_KM,
        leadFilter: dto.leadFilter ?? TripLeadFilter.OPEN,
        includeLost: dto.includeLost ?? false,
        cityIds: await this.ownCityIds(actor.orgId, dto.cityIds),
        distanceKm: round(route.distanceKm, 1),
        durationMin: round(route.durationMin),
        routeSource: route.source,
        geometry: thinRoute(route.geometry),
      },
      include: TRIP_INCLUDE,
    });
    return this.present(actor, trip);
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateTripDto) {
    await this.load(actor, id, 'edit');
    const route = dto.stops ? await this.osm.route(dto.stops.map((s) => [s.lat, s.lng] as LatLng)) : null;
    const trip = await this.prisma.trip.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.tripDate !== undefined ? { tripDate: dto.tripDate ? new Date(dto.tripDate.slice(0, 10)) : null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.corridorKm !== undefined ? { corridorKm: dto.corridorKm } : {}),
        ...(dto.leadFilter !== undefined ? { leadFilter: dto.leadFilter } : {}),
        ...(dto.includeLost !== undefined ? { includeLost: dto.includeLost } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.cityIds !== undefined ? { cityIds: await this.ownCityIds(actor.orgId, dto.cityIds) } : {}),
        ...(dto.stops && route
          ? {
              stops: this.cleanStops(dto.stops),
              distanceKm: round(route.distanceKm, 1),
              durationMin: round(route.durationMin),
              routeSource: route.source,
              geometry: thinRoute(route.geometry),
            }
          : {}),
      },
      include: TRIP_INCLUDE,
    });
    return this.present(actor, trip);
  }

  async remove(actor: AuthenticatedUser, id: string) {
    await this.load(actor, id, 'edit');
    await this.prisma.trip.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** People the trip can be shared with: anyone active in the org but the caller. */
  shareCandidates(actor: AuthenticatedUser) {
    return this.prisma.user.findMany({
      where: { orgId: actor.orgId, deletedAt: null, status: UserStatus.ACTIVE, id: { not: actor.userId }, role: { not: Role.SUPER_ADMIN } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

  /** POST /trips/:id/share — replaces who the trip is shared with; newly added people are notified. */
  async share(actor: AuthenticatedUser, id: string, userIds: string[]) {
    const trip = await this.load(actor, id, 'edit');
    const wanted = [...new Set(userIds)].filter((u) => u !== trip.createdById);
    const valid = await this.prisma.user.findMany({
      where: { id: { in: wanted }, orgId: actor.orgId, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true },
    });
    if (valid.length !== wanted.length) throw new BadRequestException('Some of these people are not active members of your organization');

    const before = new Set(trip.members.map((m) => m.user.id));
    const added = wanted.filter((u) => !before.has(u));
    const sharer = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    await this.prisma.$transaction([
      this.prisma.tripMember.deleteMany({ where: { tripId: id, userId: { notIn: wanted } } }),
      this.prisma.tripMember.createMany({ data: wanted.map((userId) => ({ tripId: id, userId })), skipDuplicates: true }),
      ...(added.length
        ? [
            this.prisma.notification.createMany({
              data: added.map((userId) => ({
                orgId: actor.orgId,
                userId,
                type: NotificationType.TRIP_SHARED,
                title: `Trip shared with you: ${trip.name}`,
                message: `${sharer?.name ?? 'A colleague'} shared a trip${
                  trip.tripDate ? ` for ${trip.tripDate.toISOString().slice(0, 10)}` : ''
                } with ${trip.cityIds.length} cit${trip.cityIds.length === 1 ? 'y' : 'ies'} on the way. Open Trips to see the route and leads.`,
              })),
            }),
          ]
        : []),
    ]);
    return this.get(actor, id);
  }

  /** GET /trips/:id/leads — the trip's leads as its planner sees them. */
  async tripLeads(actor: AuthenticatedUser, id: string) {
    const trip = await this.load(actor, id, 'view');
    return this.leadsIn(await this.plannerScope(actor, trip), trip.cityIds, trip.leadFilter, trip.includeLost);
  }

  /**
   * POST /trips/:id/tasks — one site-visit task per trip lead, due on the trip
   * day, for the planner or someone the trip is shared with (people it is
   * shared with can only take it on themselves). Leads that already have an
   * open visit task from this trip for that person are skipped.
   */
  async saveAsTasks(actor: AuthenticatedUser, id: string, userId?: string) {
    const trip = await this.load(actor, id, 'view');
    const canEdit = this.canEdit(actor, trip);
    const target = userId ?? actor.userId;
    const allowed = canEdit ? [trip.createdById, ...trip.members.map((m) => m.user.id)] : [actor.userId];
    if (!allowed.includes(target)) {
      throw new ForbiddenException(canEdit ? 'Share the trip with this person first' : 'You can only save the visits as your own tasks');
    }

    const groups = await this.leadsIn(await this.plannerScope(actor, trip), trip.cityIds, trip.leadFilter, trip.includeLost);
    const leads = groups.flatMap((g) => g.leads.map((l) => ({ ...l, cityName: g.city.name })));
    const existing = await this.prisma.task.findMany({
      where: { tripId: id, userId: target, status: TaskStatus.PENDING, leadId: { in: leads.map((l) => l.id) } },
      select: { leadId: true },
    });
    const skip = new Set(existing.map((t) => t.leadId));
    const toCreate = leads.filter((l) => !skip.has(l.id));
    const dueAt = trip.tripDate ? new Date(trip.tripDate.getTime() + VISIT_TIME_OFFSET_MS) : null;

    const created = toCreate.length
      ? await this.prisma.task.createManyAndReturn({
          data: toCreate.map((l) => ({
            orgId: actor.orgId,
            userId: target,
            createdById: actor.userId,
            title: `Visit ${l.name || l.phone} (${l.cityName})`,
            description: [l.phone, l.address, l.requirementNotes, `Trip: ${trip.name}`].filter(Boolean).join('\n'),
            taskType: TaskType.SITE_VISIT,
            dueAt,
            leadId: l.id,
            tripId: id,
          })),
          select: { id: true },
        })
      : [];

    if (created.length && target !== actor.userId) {
      await this.prisma.notification.create({
        data: {
          orgId: actor.orgId,
          userId: target,
          type: NotificationType.TASK_ASSIGNED,
          title: `${created.length} site visit${created.length === 1 ? '' : 's'} for ${trip.name}`,
          message: `Visit tasks for every lead on the trip${dueAt ? `, due ${trip.tripDate!.toISOString().slice(0, 10)}` : ''}. Find them under Tasks.`,
          taskId: created[0].id,
        },
      });
    }
    return { created: created.length, skipped: skip.size, userId: target };
  }

  // ─────────── Internals ───────────

  /** Lead counts per org city for the filter, matching lead.city to a city by name or old spelling. */
  private async cityStats(actor: AuthenticatedUser, filter?: TripLeadFilter, includeLost = false) {
    const base: Prisma.LeadWhereInput = {
      orgId: actor.orgId,
      deletedAt: null,
      city: { not: null },
      ...leadVisibilityWhere(actor),
    };
    const [cities, byStatus, due] = await Promise.all([
      this.prisma.city.findMany({ where: { orgId: actor.orgId } }),
      this.prisma.lead.groupBy({
        by: ['city', 'status'],
        where: { ...base, status: { in: statusesFor(filter, includeLost) } },
        _count: { _all: true },
      }),
      this.prisma.lead.groupBy({
        by: ['city'],
        where: { ...base, status: { in: OPEN }, nextFollowUpAt: { lte: businessDayEndInstant() } },
        _count: { _all: true },
      }),
    ]);

    const cityByKey = new Map<string, City>();
    for (const c of cities) [c.key, ...c.aliases].forEach((k) => cityByKey.set(k, c));
    const stats = new Map<string, CityLeadStats>();
    const statsFor = (city: string | null) => {
      const c = city ? cityByKey.get(city.trim().toLowerCase()) : undefined;
      if (!c) return null;
      if (!stats.has(c.id)) stats.set(c.id, emptyStats());
      return stats.get(c.id)!;
    };

    for (const row of byStatus) {
      const s = statsFor(row.city);
      if (!s) continue;
      const n = row._count._all;
      s.total += n;
      if (row.status === LeadStatus.CONVERTED) s.converted += n;
      else if (row.status === LeadStatus.LOST) s.lost += n;
      else s.open += n;
    }
    for (const row of due) {
      const s = statsFor(row.city);
      if (s) s.due += row._count._all;
    }
    return { cities, stats };
  }

  private async leadsIn(scope: AuthenticatedUser, cityIds: string[], filter?: TripLeadFilter, includeLost = false) {
    if (cityIds.length === 0) return [];
    const cities = await this.prisma.city.findMany({ where: { id: { in: cityIds }, orgId: scope.orgId } });
    const byId = new Map(cities.map((c) => [c.id, c]));
    const ordered = cityIds.map((id) => byId.get(id)).filter((c): c is City => !!c);
    const names = ordered.flatMap((c) => [c.name, ...c.aliases]);

    const leads = await this.prisma.lead.findMany({
      where: {
        orgId: scope.orgId,
        deletedAt: null,
        status: { in: statusesFor(filter, includeLost) },
        AND: [leadVisibilityWhere(scope), { OR: names.map((n) => ({ city: { equals: n, mode: 'insensitive' as const } })) }],
      },
      select: TRIP_LEAD_SELECT,
      orderBy: { createdAt: 'desc' },
      take: MAX_TRIP_LEADS,
    });

    return ordered.map((c) => {
      const keys = new Set([c.key, ...c.aliases]);
      return {
        city: { id: c.id, name: c.name, lat: c.lat, lng: c.lng },
        leads: leads.filter((l) => l.city && keys.has(l.city.trim().toLowerCase())),
      };
    });
  }

  private async load(actor: AuthenticatedUser, id: string, need: 'view' | 'edit'): Promise<TripWithPeople> {
    const trip = await this.prisma.trip.findFirst({ where: { id, orgId: actor.orgId }, include: TRIP_INCLUDE });
    const member = trip?.members.some((m) => m.user.id === actor.userId);
    if (!trip || (!this.canEdit(actor, trip) && !member)) throw new NotFoundException('Trip not found');
    if (need === 'edit' && !this.canEdit(actor, trip)) throw new ForbiddenException('Only the person who planned this trip (or an Admin) can change it');
    return trip;
  }

  private canEdit(actor: AuthenticatedUser, trip: Pick<Trip, 'createdById'>): boolean {
    return trip.createdById === actor.userId || actor.role === Role.ADMIN;
  }

  /** The planner's lead scope; the actor's own when the planner has left. */
  private async plannerScope(actor: AuthenticatedUser, trip: Trip): Promise<AuthenticatedUser> {
    const planner = await this.prisma.user.findFirst({
      where: { id: trip.createdById, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true, email: true, role: true },
    });
    return planner ? { userId: planner.id, email: planner.email, role: planner.role, orgId: trip.orgId } : actor;
  }

  private present(actor: AuthenticatedUser, trip: TripWithPeople) {
    const { members, _count, ...rest } = trip;
    return { ...rest, members: members.map((m) => m.user), taskCount: _count.tasks, canEdit: this.canEdit(actor, trip) };
  }

  private cleanStops(stops: TripStopDto[]) {
    return stops.map((s) => ({ name: s.name.trim(), lat: s.lat, lng: s.lng }));
  }

  /** Drops ids that aren't this org's cities, keeping the order. */
  private async ownCityIds(orgId: string, ids: string[]) {
    const own = new Set((await this.prisma.city.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } })).map((c) => c.id));
    return [...new Set(ids)].filter((id) => own.has(id));
  }
}

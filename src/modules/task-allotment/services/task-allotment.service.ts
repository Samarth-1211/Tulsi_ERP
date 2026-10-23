import { Injectable, NotFoundException } from '@nestjs/common';
import { AllotmentEligibility, AllotmentPriority, AllotmentStatus, FollowUpStatus, LeadStatus, NotificationType, OrgSettings, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { businessDateOnly, businessDayEndInstant } from '../../../common/utils/business-date.util';
import { CLOSED_LEAD_STATUSES } from '../../lead-ingestion/services/lead-dedup.service';
import { UpdateTaskAllotmentSettingsDto } from '../dto/update-task-allotment-settings.dto';
import { AllotmentCandidate, rankCandidates } from '../utils/allotment-ranking.util';

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ANSWER = 'NO_ANSWER';
// Upper bound on leads scored for one batch — far above a caller's 30-day load.
const MAX_CANDIDATES = 2000;
// Leads the caller hasn't started working yet: these come before any old lead.
const UNTOUCHED_LEAD_STATUSES: LeadStatus[] = [LeadStatus.NEW, LeadStatus.ASSIGNED];

const SETTINGS_SELECT = {
  autoAllotEnabled: true,
  autoAllotBatchSize: true,
  autoAllotLookbackDays: true,
  autoAllotRestDays: true,
  autoAllotIncludeLost: true,
  autoAllotEligibility: true,
  autoAllotPriority: true,
  autoAllotThenBy: true,
  updatedAt: true,
} satisfies Prisma.OrgSettingsSelect;

type AllotmentSettings = Pick<OrgSettings, keyof Omit<typeof SETTINGS_SELECT, 'updatedAt'>>;

const LAST_FOLLOW_UP = {
  orderBy: { createdAt: 'desc' },
  take: 1,
  select: { note: true, outcome: true, createdAt: true },
} satisfies Prisma.Lead$followUpsArgs;

/**
 * Automated Task Allotment.
 *
 * Once a lead holder has no untouched leads (NEW / ASSIGNED) and no follow-ups
 * due today, the first GET /task-allotment/me of the day builds their batch:
 * up to autoAllotBatchSize of their own leads from the last
 * autoAllotLookbackDays that qualify (OrgSettings.autoAllotEligibility),
 * ranked by the org's chosen priority. A batch is built once per user per
 * business day; logging a follow-up or changing the lead's status marks its
 * row DONE (LeadsService), and rows left PENDING expire the next day.
 */
@Injectable()
export class TaskAllotmentService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────── Settings (Admin) ───────────

  async getSettings(actor: AuthenticatedUser) {
    const row = await this.prisma.orgSettings.upsert({
      where: { orgId: actor.orgId },
      create: { orgId: actor.orgId },
      update: {},
      select: SETTINGS_SELECT,
    });
    return row;
  }

  async updateSettings(actor: AuthenticatedUser, dto: UpdateTaskAllotmentSettingsDto) {
    const row = await this.prisma.orgSettings.upsert({
      where: { orgId: actor.orgId },
      create: { orgId: actor.orgId, ...dto },
      update: dto,
      select: SETTINGS_SELECT,
    });
    return row;
  }

  // ─────────── The lead holder's own batch ───────────

  /**
   * GET /task-allotment/me — today's batch, built now if the day's work is
   * done and no batch exists yet. `workLeft` says what still comes first.
   */
  async forMe(actor: AuthenticatedUser) {
    const today = businessDateOnly();
    const settings = await this.loadSettings(actor.orgId);

    await this.prisma.taskAllotment.updateMany({
      where: { userId: actor.userId, status: AllotmentStatus.PENDING, allotDate: { lt: today } },
      data: { status: AllotmentStatus.EXPIRED },
    });

    const workLeft = await this.workLeft(actor);
    const dayDone = workLeft.untouchedLeads === 0 && workLeft.dueFollowUps === 0;
    if (settings.autoAllotEnabled && dayDone) await this.buildBatch(actor, settings, today);

    const items = await this.prisma.taskAllotment.findMany({
      // A lead moved to someone else since leaves this list with it.
      where: { userId: actor.userId, allotDate: today, lead: { deletedAt: null, assignedToId: actor.userId } },
      orderBy: { rank: 'asc' },
      select: {
        id: true,
        rank: true,
        status: true,
        outcome: true,
        completedAt: true,
        lead: {
          select: {
            id: true,
            name: true,
            phone: true,
            city: true,
            status: true,
            buyingFor: true,
            requirementNotes: true,
            createdAt: true,
            lastActivityAt: true,
            followUps: LAST_FOLLOW_UP,
            _count: { select: { followUps: true } },
          },
        },
      },
    });

    return {
      enabled: settings.autoAllotEnabled,
      dayDone,
      workLeft,
      batchSize: settings.autoAllotBatchSize,
      items: items.map(({ lead: { followUps, _count, ...lead }, ...item }) => ({
        ...item,
        lead: {
          ...lead,
          attempts: _count.followUps,
          lastFollowUp: followUps[0] ?? null,
        },
      })),
    };
  }

  /** PATCH /task-allotment/:id/skip — the holder passes on one of today's leads. */
  async skip(actor: AuthenticatedUser, id: string) {
    const { count } = await this.prisma.taskAllotment.updateMany({
      where: { id, userId: actor.userId, status: AllotmentStatus.PENDING },
      data: { status: AllotmentStatus.SKIPPED, completedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('No pending allotted lead with this id');
    return { id, status: AllotmentStatus.SKIPPED };
  }

  // ─────────── Overview (Admin: org; Manager: self + team) ───────────

  /**
   * GET /task-allotment/overview — per lead holder: today's batch progress
   * and, over the look-back window, how many allotted leads went on to convert.
   */
  async overview(actor: AuthenticatedUser) {
    const today = businessDateOnly();
    const settings = await this.loadSettings(actor.orgId);
    const since = new Date(today.getTime() - settings.autoAllotLookbackDays * DAY_MS);

    const people = await this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        deletedAt: null,
        status: UserStatus.ACTIVE,
        role: { in: [Role.MANAGER, Role.CALLER] },
        ...(actor.role === Role.MANAGER ? { OR: [{ id: actor.userId }, { managerId: actor.userId }] } : {}),
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    const ids = people.map((p) => p.id);
    if (ids.length === 0) return { date: today, sinceDate: since, people: [] };

    const [todayRows, periodRows, converted] = await Promise.all([
      this.prisma.taskAllotment.groupBy({
        by: ['userId', 'status'],
        where: { orgId: actor.orgId, allotDate: today, userId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.taskAllotment.groupBy({
        by: ['userId', 'status'],
        where: { orgId: actor.orgId, allotDate: { gte: since }, userId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ userId: string; count: bigint }[]>`
        SELECT ta."userId", COUNT(DISTINCT ta."leadId") AS count
        FROM task_allotments ta JOIN "Lead" l ON l.id = ta."leadId"
        WHERE ta."orgId" = ${actor.orgId} AND ta."allotDate" >= ${since}::date
          AND ta."userId" IN (${Prisma.join(ids)})
          AND l.status = 'CONVERTED'::"LeadStatus" AND l."convertedAt" >= ta."createdAt"
        GROUP BY ta."userId"`,
    ]);

    const tally = (rows: typeof todayRows, userId: string) => {
      const counts = { allotted: 0, pending: 0, done: 0, skipped: 0, expired: 0 };
      for (const r of rows) {
        if (r.userId !== userId) continue;
        counts.allotted += r._count._all;
        counts[r.status.toLowerCase() as Lowercase<AllotmentStatus>] += r._count._all;
      }
      return counts;
    };
    const convertedBy = new Map(converted.map((c) => [c.userId, Number(c.count)]));

    return {
      date: today,
      sinceDate: since,
      people: people.map((p) => ({
        ...p,
        today: tally(todayRows, p.id),
        period: { ...tally(periodRows, p.id), converted: convertedBy.get(p.id) ?? 0 },
      })),
    };
  }

  // ─────────── Internals ───────────

  /** Untouched leads and follow-ups due by tonight — the work that comes before any old lead. */
  private async workLeft(actor: AuthenticatedUser) {
    const own = { orgId: actor.orgId, deletedAt: null, assignedToId: actor.userId };
    const [untouchedLeads, dueFollowUps] = await Promise.all([
      this.prisma.lead.count({ where: { ...own, status: { in: UNTOUCHED_LEAD_STATUSES } } }),
      this.prisma.followUp.count({
        where: {
          orgId: actor.orgId,
          status: FollowUpStatus.PENDING,
          nextFollowUpAt: { lte: businessDayEndInstant() },
          lead: { ...own, status: { notIn: CLOSED_LEAD_STATUSES } },
        },
      }),
    ]);
    return { untouchedLeads, dueFollowUps };
  }

  /**
   * Writes today's batch unless the user already has one. A per-user advisory
   * lock keeps two parallel page loads from building it twice.
   */
  private async buildBatch(actor: AuthenticatedUser, settings: AllotmentSettings, today: Date) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`task-allotment:${actor.userId}`}))`;
      const existing = await tx.taskAllotment.count({ where: { userId: actor.userId, allotDate: today } });
      if (existing > 0) return;

      const candidates = await this.findCandidates(tx, actor, settings);
      const picks = rankCandidates(candidates, settings.autoAllotPriority, settings.autoAllotThenBy, settings.autoAllotBatchSize);
      if (picks.length === 0) return;

      await tx.taskAllotment.createMany({
        data: picks.map((c, i) => ({ orgId: actor.orgId, userId: actor.userId, leadId: c.id, allotDate: today, rank: i + 1 })),
        skipDuplicates: true,
      });
      // Bell, device push and (per org settings) email.
      await tx.notification.create({
        data: {
          orgId: actor.orgId,
          userId: actor.userId,
          type: NotificationType.TASK_ALLOTTED,
          title: "Today's follow-up list is ready",
          message: `${picks.length} older lead${picks.length === 1 ? '' : 's'} were allotted to you to call again. Find them under Follow-ups.`,
        },
      });
    });
  }

  /**
   * The user's own leads that qualify for a batch: came in within the
   * look-back window, already contacted and still in the pipeline (or LOST,
   * when included), quiet for at least autoAllotRestDays, with no callback
   * scheduled, and — for
   * NOT_CONNECTED — whose last follow-up was a NO_ANSWER.
   */
  private async findCandidates(tx: Tx, actor: AuthenticatedUser, settings: AllotmentSettings): Promise<AllotmentCandidate[]> {
    const now = Date.now();
    const statuses: LeadStatus[] = settings.autoAllotIncludeLost ? [LeadStatus.IN_PROGRESS, LeadStatus.LOST] : [LeadStatus.IN_PROGRESS];
    const quietSince = new Date(now - settings.autoAllotRestDays * DAY_MS);

    const leads = await tx.lead.findMany({
      where: {
        orgId: actor.orgId,
        deletedAt: null,
        assignedToId: actor.userId,
        status: { in: statuses },
        createdAt: { gte: new Date(now - settings.autoAllotLookbackDays * DAY_MS) },
        AND: [
          { OR: [{ firstResponseAt: { not: null } }, { followUps: { some: {} } }] },
          { OR: [{ lastActivityAt: null }, { lastActivityAt: { lte: quietSince } }] },
          { followUps: { none: { status: FollowUpStatus.PENDING } } },
        ],
      },
      select: {
        id: true,
        createdAt: true,
        lastActivityAt: true,
        followUps: LAST_FOLLOW_UP,
        _count: { select: { followUps: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATES,
    });

    return leads
      .filter((l) => settings.autoAllotEligibility !== AllotmentEligibility.NOT_CONNECTED || l.followUps[0]?.outcome === NO_ANSWER)
      .map((l) => ({
        id: l.id,
        createdAt: l.createdAt,
        lastContactAt: l.lastActivityAt,
        attempts: l._count.followUps,
      }));
  }

  /** The org's allotment settings, with schema defaults when the row is missing. */
  private async loadSettings(orgId: string): Promise<AllotmentSettings> {
    const row = await this.prisma.orgSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    return (
      row ?? {
        autoAllotEnabled: true,
        autoAllotBatchSize: 15,
        autoAllotLookbackDays: 30,
        autoAllotRestDays: 2,
        autoAllotIncludeLost: false,
        autoAllotEligibility: AllotmentEligibility.NOT_CONNECTED,
        autoAllotPriority: AllotmentPriority.SMART,
        autoAllotThenBy: AllotmentPriority.LONGEST_SILENT,
      }
    );
  }
}

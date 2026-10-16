import { Injectable, Logger } from '@nestjs/common';
import { AllocationMode, LeadSource, LeadStatus, LeaveStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { businessDateOnly } from '../../../common/utils/business-date.util';

type Tx = Prisma.TransactionClient;

export interface TeamSplitTeam {
  managerId: string | null;
  managerName: string | null;
  members: { id: string; name: string }[];
}

/** Who one uploaded lead goes to, and the team that puts them in (their Manager's, or their own if they are one). */
export interface UploadAssignee {
  userId: string;
  name: string;
  team: TeamSplitTeam;
}

/** Hands out the assignees for one Excel upload, lead by lead. */
export interface UploadSplitter {
  next(): UploadAssignee | null;
}

/** The Managers an Excel upload was shared with, and whether each one's part is spread across their callers too. */
export interface UploadManagerPick {
  ids: string[];
  withTeams: boolean;
}

/**
 * Hands out assignees for one Excel upload: every team gets an equal share
 * of the leads whatever its size, and within a team the leads rotate across
 * its members. A team is a Manager's callers, the Manager with their callers,
 * or the Manager alone — see createTeamSplitter.
 */
export class TeamSplitter implements UploadSplitter {
  private turn = 0;
  private readonly memberTurn: number[];

  constructor(readonly teams: TeamSplitTeam[]) {
    this.memberTurn = teams.map(() => 0);
  }

  /** The next lead's assignee, or null when there's no one to hand leads to. */
  next(): UploadAssignee | null {
    if (this.teams.length === 0) return null;
    const teamIndex = this.turn++ % this.teams.length;
    const team = this.teams[teamIndex];
    const member = team.members[this.memberTurn[teamIndex]++ % team.members.length];
    return { userId: member.id, name: member.name, team };
  }
}

/** One person's part of a custom split: how many of the sheet's leads they get. */
export interface UploadQuota extends UploadAssignee {
  count: number;
}

/**
 * Hands out an Excel upload's leads by the numbers the uploader gave each
 * person. Whoever is furthest behind their number goes next, so everyone's
 * leads come from across the whole sheet, and a sheet that turns out short
 * leaves everyone short in proportion rather than the last person empty-handed.
 */
export class QuotaSplitter implements UploadSplitter {
  private readonly given: number[];

  constructor(private readonly quotas: UploadQuota[]) {
    this.given = quotas.map(() => 0);
  }

  /** The next lead's assignee, or null once everyone has their number. */
  next(): UploadAssignee | null {
    let pick = -1;
    let leastFilled = 1;
    this.quotas.forEach((quota, i) => {
      const filled = this.given[i] / quota.count;
      if (filled < leastFilled) {
        leastFilled = filled;
        pick = i;
      }
    });
    if (pick < 0) return null;
    this.given[pick]++;
    const { userId, name, team } = this.quotas[pick];
    return { userId, name, team };
  }
}

/**
 * Automatic lead allocation.
 *
 * New leads go round robin to the org's active users of
 * OrgSettings.allocationTargetRole (default MANAGER): whoever has waited
 * longest since their last lead (User.lastLeadAssignedAt, nulls first). The
 * pick runs inside the caller's transaction with a row lock on the chosen
 * user, so parallel webhooks never hand the same turn to two leads.
 */
@Injectable()
export class LeadAllocationService {
  private readonly logger = new Logger(LeadAllocationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The org's allocation settings, with schema defaults when the row is missing. */
  async getSettings(orgId: string, tx: Tx = this.prisma) {
    const settings = await tx.orgSettings.findUnique({ where: { orgId } });
    return {
      allocationMode: settings?.allocationMode ?? AllocationMode.ROUND_ROBIN,
      allocationTargetRole: settings?.allocationTargetRole ?? Role.MANAGER,
      allocateOnlyCheckedIn: settings?.allocateOnlyCheckedIn ?? false,
      autoReallocateLostLeads: settings?.autoReallocateLostLeads ?? false,
    };
  }

  /**
   * Picks the next round-robin assignee and advances their cursor. Must run
   * inside a transaction. Candidates: same org, target role, ACTIVE, not
   * soft-deleted, not on approved leave today, and — when
   * allocateOnlyCheckedIn is on — checked in today. Returns null when nobody
   * is eligible (the lead stays NEW and unassigned).
   */
  async pickRoundRobin(tx: Tx, orgId: string): Promise<string | null> {
    const { allocationTargetRole, allocateOnlyCheckedIn } = await this.getSettings(orgId, tx);
    const today = businessDateOnly();

    const pick = (skipLocked: boolean) => tx.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM "User" u
      WHERE u."orgId" = ${orgId}
        AND u.role = ${allocationTargetRole}::"Role"
        AND u.status = ${UserStatus.ACTIVE}::"UserStatus"
        AND u."deletedAt" IS NULL
        AND (${allocateOnlyCheckedIn} = false OR EXISTS (
          SELECT 1 FROM "Attendance" a
          WHERE a."userId" = u.id AND a.date = ${today}::date AND a.status = 'CHECKED_IN'::"AttendanceStatus"
        ))
        AND NOT EXISTS (
          SELECT 1 FROM leave_requests l
          WHERE l."userId" = u.id AND l.status = ${LeaveStatus.APPROVED}::"LeaveStatus"
            AND l."startDate" <= ${today}::date AND l."endDate" >= ${today}::date
        )
      ORDER BY u."lastLeadAssignedAt" ASC NULLS FIRST, u.id ASC
      LIMIT 1
      ${skipLocked ? Prisma.sql`FOR UPDATE OF u SKIP LOCKED` : Prisma.sql`FOR UPDATE OF u`}`;

    // SKIP LOCKED lets a parallel allocation take the next person in line
    // instead of re-reading the same row once the first one commits. When
    // every candidate is locked (e.g. a single manager), wait for the lock.
    let [row] = await pick(true);
    if (!row) [row] = await pick(false);
    if (!row) {
      this.logger.warn(`No eligible ${allocationTargetRole} to auto-assign a lead in org ${orgId}`);
      return null;
    }

    await tx.user.update({ where: { id: row.id }, data: { lastLeadAssignedAt: new Date() } });
    return row.id;
  }

  /**
   * Builds the splitter for one Excel upload. Anyone on approved leave today
   * is left out, and a team with no one available sits this upload out.
   * Teams — and members within a team — that have received the fewest
   * uploaded leads so far go first, so shares stay even across uploads too.
   *
   * @param managers The Managers the uploader picked: each gets an equal
   *   share, kept to themselves or (`withTeams`) rotated across themselves
   *   and their active callers. Omitted when the sheet goes to everyone —
   *   then the teams are every Manager's active callers.
   */
  async createTeamSplitter(orgId: string, managers?: UploadManagerPick): Promise<TeamSplitter> {
    const people = await this.prisma.user.findMany({
      where: {
        orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        OR: !managers
          ? [{ role: Role.CALLER }]
          : [
              { role: Role.MANAGER, id: { in: managers.ids } },
              ...(managers.withTeams ? [{ role: Role.CALLER, managerId: { in: managers.ids } }] : []),
            ],
      },
      select: { id: true, name: true, role: true, managerId: true, manager: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });

    const unavailable = await this.getUnavailableUserIds(people.map((p) => p.id));
    const available = people.filter((p) => !unavailable.has(p.id));
    if (available.length === 0) return new TeamSplitter([]);

    const uploadedSoFar = await this.prisma.lead.groupBy({
      by: ['assignedToId'],
      where: { orgId, source: LeadSource.CSV_IMPORT, assignedToId: { in: available.map((p) => p.id) } },
      _count: { _all: true },
    });
    const countByUser = new Map(uploadedSoFar.map((c) => [c.assignedToId as string, c._count._all]));
    const countOf = (id: string) => countByUser.get(id) ?? 0;

    // A picked Manager belongs to their own team. Callers without a manager
    // still get leads, as a team of their own.
    const teamsByManager = new Map<string | null, TeamSplitTeam>();
    for (const p of available) {
      const isManager = p.role === Role.MANAGER;
      const managerId = isManager ? p.id : p.managerId;
      let team = teamsByManager.get(managerId);
      if (!team) {
        team = { managerId, managerName: isManager ? p.name : (p.manager?.name ?? null), members: [] };
        teamsByManager.set(managerId, team);
      }
      team.members.push({ id: p.id, name: p.name });
    }

    const teams = [...teamsByManager.values()];
    const teamTotal = (t: TeamSplitTeam) => t.members.reduce((sum, m) => sum + countOf(m.id), 0);
    for (const team of teams) {
      team.members.sort((a, b) => countOf(a.id) - countOf(b.id) || a.id.localeCompare(b.id));
    }
    teams.sort((a, b) => teamTotal(a) - teamTotal(b) || (a.managerId ?? '').localeCompare(b.managerId ?? ''));

    return new TeamSplitter(teams);
  }

  /**
   * Picks who a LOST lead should be handed to instead — used by the manual
   * "shuffle" action and (with autoReallocateLostLeads on) the instant a lead
   * is marked LOST. Excludes whoever just lost it and picks whoever in the
   * pool (the lead's current holder's role) has the fewest open leads.
   *
   * @param teamManagerId When set (a Manager's own shuffle), only that
   *   Manager's direct reports are eligible — the lead never leaves the team.
   */
  async selectReassignee(
    orgId: string,
    excludeUserId: string,
    role: Role,
    teamManagerId?: string | null,
  ): Promise<string | null> {
    const pool = await this.prisma.user.findMany({
      where: {
        orgId,
        role,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        id: { not: excludeUserId },
        ...(teamManagerId ? { managerId: teamManagerId } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const unavailable = await this.getUnavailableUserIds(pool.map((u) => u.id));
    const candidates = pool.map((u) => u.id).filter((id) => !unavailable.has(id));
    if (candidates.length === 0) {
      this.logger.warn(`No other eligible ${role} to reassign a lost lead to in org ${orgId}`);
      return null;
    }

    const openLeadCounts = await this.prisma.lead.groupBy({
      by: ['assignedToId'],
      where: {
        orgId,
        deletedAt: null,
        assignedToId: { in: candidates },
        status: { in: [LeadStatus.NEW, LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS] },
      },
      _count: { _all: true },
    });
    const countByUserId = new Map(openLeadCounts.map((c) => [c.assignedToId as string, c._count._all]));
    return candidates.reduce((least, id) =>
      (countByUserId.get(id) ?? 0) < (countByUserId.get(least) ?? 0) ? id : least,
    );
  }

  /** Users on approved leave today don't receive new leads. */
  private async getUnavailableUserIds(userIds: string[]): Promise<Set<string>> {
    const today = businessDateOnly();
    const onLeave = await this.prisma.leaveRequest.findMany({
      where: {
        userId: { in: userIds },
        status: LeaveStatus.APPROVED,
        startDate: { lte: today },
        endDate: { gte: today },
      },
      select: { userId: true },
    });
    return new Set(onLeave.map((l) => l.userId));
  }
}

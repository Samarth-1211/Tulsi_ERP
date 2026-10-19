import { Injectable } from '@nestjs/common';
import { LeadStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { managerLeadScope } from '../../../common/utils/lead-scope.util';
import {
  businessDateOnly,
  businessDayEndInstant,
  businessDayStartInstant,
  businessStartOfMonth,
} from '../../../common/utils/business-date.util';

const OPEN_LEAD_STATUSES: LeadStatus[] = [LeadStatus.NEW, LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS];

/** Role-specific landing stats for GET /dashboard/me. */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async forUser(actor: AuthenticatedUser) {
    switch (actor.role) {
      case Role.SUPER_ADMIN:
        return { role: actor.role, ...(await this.platformStats()) };
      case Role.ADMIN:
        return { role: actor.role, ...(await this.adminStats(actor)) };
      case Role.MANAGER:
        return { role: actor.role, ...(await this.managerStats(actor)) };
      case Role.CALLER:
        return { role: actor.role, ...(await this.callerStats(actor)) };
      default:
        return { role: actor.role, attendance: await this.myAttendance(actor) };
    }
  }

  private async platformStats() {
    const [organizations, activeOrganizations, users] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.organization.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { deletedAt: null, role: { not: Role.SUPER_ADMIN } } }),
    ]);
    return { organizations, activeOrganizations, users };
  }

  private async adminStats(actor: AuthenticatedUser) {
    const leadWhere: Prisma.LeadWhereInput = { orgId: actor.orgId, deletedAt: null };
    const [total, unassigned, newToday, byStatus, bySource, usersByRole, checkedInToday] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.lead.count({ where: { ...leadWhere, assignedToId: null, status: { in: OPEN_LEAD_STATUSES } } }),
      this.prisma.lead.count({ where: { ...leadWhere, createdAt: this.todayRange() } }),
      this.prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['source'], where: leadWhere, _count: { _all: true } }),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { orgId: actor.orgId, deletedAt: null, status: UserStatus.ACTIVE },
        _count: { _all: true },
      }),
      this.prisma.attendance.count({ where: { orgId: actor.orgId, date: businessDateOnly() } }),
    ]);

    return {
      leads: {
        total,
        unassigned,
        newToday,
        byStatus: this.toCounts(byStatus, 'status'),
        bySource: this.toCounts(bySource, 'source'),
      },
      users: this.toCounts(usersByRole, 'role'),
      attendance: { checkedInToday },
    };
  }

  private async managerStats(actor: AuthenticatedUser) {
    const leadWhere: Prisma.LeadWhereInput = { orgId: actor.orgId, deletedAt: null, ...managerLeadScope(actor.userId) };
    const team = await this.prisma.user.findMany({
      where: { orgId: actor.orgId, managerId: actor.userId, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });

    const [total, byStatus, followUpsToday, todayRows] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
      this.prisma.lead.count({
        where: { ...leadWhere, status: { in: OPEN_LEAD_STATUSES }, nextFollowUpAt: this.todayRange() },
      }),
      this.prisma.attendance.findMany({
        where: { orgId: actor.orgId, date: businessDateOnly(), userId: { in: team.map((m) => m.id) } },
        select: { userId: true, status: true, checkInAt: true, checkOutAt: true },
      }),
    ]);

    const rowByUser = new Map(todayRows.map((r) => [r.userId, r]));
    return {
      leads: { total, followUpsToday, byStatus: this.toCounts(byStatus, 'status') },
      team: {
        size: team.length,
        checkedInToday: todayRows.length,
        members: team.map((m) => {
          const row = rowByUser.get(m.id);
          return {
            ...m,
            attendance: row ? row.status : null, // not checked in yet today
            checkInAt: row?.checkInAt ?? null,
            checkOutAt: row?.checkOutAt ?? null,
          };
        }),
      },
      attendance: await this.myAttendance(actor),
    };
  }

  private async callerStats(actor: AuthenticatedUser) {
    const leadWhere: Prisma.LeadWhereInput = { orgId: actor.orgId, deletedAt: null, assignedToId: actor.userId };
    const [total, byStatus, followUpsToday] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
      this.prisma.lead.findMany({
        where: { ...leadWhere, status: { in: OPEN_LEAD_STATUSES }, nextFollowUpAt: { lte: businessDayEndInstant() } },
        select: { id: true, name: true, phone: true, status: true, nextFollowUpAt: true },
        orderBy: { nextFollowUpAt: 'asc' },
        take: 50,
      }),
    ]);

    return {
      leads: { total, byStatus: this.toCounts(byStatus, 'status') },
      followUpsToday,
      attendance: await this.myAttendance(actor),
    };
  }

  /** Today's row plus days present this month. "Absent" = no row for a day. */
  private async myAttendance(actor: AuthenticatedUser) {
    const [today, presentThisMonth] = await Promise.all([
      this.prisma.attendance.findUnique({
        where: { userId_date: { userId: actor.userId, date: businessDateOnly() } },
        select: { status: true, checkInAt: true, checkOutAt: true, workedMinutes: true },
      }),
      this.prisma.attendance.count({
        where: { userId: actor.userId, date: { gte: businessStartOfMonth(), lte: businessDateOnly() } },
      }),
    ]);
    // No row yet today means "not checked in yet", not absent — the day isn't over.
    return { today: today ?? { status: null }, presentThisMonth };
  }

  private todayRange(): Prisma.DateTimeFilter {
    return { gte: businessDayStartInstant(), lte: businessDayEndInstant() };
  }

  private toCounts<K extends string>(rows: Array<Record<K, string> & { _count: { _all: number } }>, key: K) {
    return Object.fromEntries(rows.map((r) => [r[key], r._count._all]));
  }
}

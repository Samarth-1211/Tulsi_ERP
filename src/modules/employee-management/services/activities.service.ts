import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EmployeeActivity, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { managerLeadScope } from '../../../common/utils/lead-scope.util';
import {
  businessDateOnly,
  businessDaysBetween,
  businessDayEndInstant,
  businessDayStartInstant,
} from '../../../common/utils/business-date.util';
import { LogActivityDto } from '../dto/log-activity.dto';

const MAX_REPORT_RANGE_DAYS = 366;

const startOfDay = businessDayStartInstant;
const endOfDay = businessDayEndInstant;

@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async log(actor: AuthenticatedUser, dto: LogActivityDto): Promise<EmployeeActivity> {
    const todayAttendance = await this.prisma.attendance.findUnique({
      where: { userId_date: { userId: actor.userId, date: businessDateOnly() } },
    });
    if (!todayAttendance?.checkInAt) {
      throw new BadRequestException('You must check in before logging any activity for today');
    }
    if (todayAttendance.checkOutAt) {
      throw new BadRequestException('You have already checked out for today — no more activity can be logged');
    }

    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: {
          id: dto.leadId,
          orgId: actor.orgId,
          // A Manager can only log work against their own or their team's leads.
          ...(actor.role === Role.MANAGER ? managerLeadScope(actor.userId) : {}),
        },
      });
      if (!lead) {
        throw new NotFoundException('leadId does not reference a lead in your organization');
      }
    }

    return this.prisma.employeeActivity.create({
      data: {
        orgId: actor.orgId,
        userId: actor.userId,
        type: dto.type,
        description: dto.description,
        leadId: dto.leadId,
      },
    });
  }

  async getMine(actor: AuthenticatedUser, dateStr?: string) {
    return this.getForUser(actor.userId, dateStr);
  }

  async getForEmployee(actor: AuthenticatedUser, employeeId: string, dateStr?: string) {
    const employee = await this.prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee || employee.orgId !== actor.orgId) {
      throw new NotFoundException('Employee not found');
    }

    const isSelf = employee.id === actor.userId;
    const isPrivilegedViewer = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);
    const isManagerOfEmployee = actor.role === Role.MANAGER && employee.managerId === actor.userId;

    if (!isSelf && !isPrivilegedViewer && !isManagerOfEmployee) {
      throw new ForbiddenException('You do not have permission to view this employee activity log');
    }

    return this.getForUser(employeeId, dateStr);
  }

  async getTeamForDate(actor: AuthenticatedUser, dateStr?: string) {
    if (actor.role !== Role.MANAGER) {
      throw new ForbiddenException('Only Managers can request team activity');
    }

    const directReports = await this.prisma.user.findMany({
      where: { orgId: actor.orgId, managerId: actor.userId, status: UserStatus.ACTIVE },
      orderBy: { name: 'asc' },
    });

    return this.groupByUser(directReports, dateStr);
  }

  async getOrgForDate(actor: AuthenticatedUser, dateStr?: string) {
    if (!([Role.ADMIN, Role.SUPER_ADMIN] as Role[]).includes(actor.role)) {
      throw new ForbiddenException('Only Admins can request org-wide activity');
    }

    const orgMembers = await this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        role: { in: [Role.MANAGER, Role.CALLER] },
      },
      orderBy: [{ managerId: 'asc' }, { name: 'asc' }],
    });

    return this.groupByUser(orgMembers, dateStr);
  }

  private async groupByUser(
    members: { id: string; name: string; role: Role; managerId: string | null }[],
    dateStr?: string,
  ) {
    const date = dateStr ? startOfDay(dateStr) : startOfDay();
    const activities = await this.prisma.employeeActivity.findMany({
      where: { userId: { in: members.map((m) => m.id) }, occurredAt: { gte: date, lte: endOfDay(date) } },
      orderBy: { occurredAt: 'desc' },
      include: { lead: { select: { id: true, name: true } } },
    });
    const byUserId = new Map<string, typeof activities>();
    for (const activity of activities) {
      const list = byUserId.get(activity.userId) ?? [];
      list.push(activity);
      byUserId.set(activity.userId, list);
    }

    return members.map((member) => ({
      userId: member.id,
      name: member.name,
      role: member.role,
      managerId: member.managerId,
      activities: byUserId.get(member.id) ?? [],
    }));
  }

  /**
   * Day-by-day report of attendance + logged activity for one employee over
   * an arbitrary date range — the data source for the Daily/Weekly/Monthly
   * employee report. Weekly/monthly rollups are computed client-side from
   * this same per-day list so the aggregation logic lives in one place.
   */
  async getReport(actor: AuthenticatedUser, employeeId: string | undefined, fromStr: string, toStr: string) {
    const targetId = employeeId ?? actor.userId;

    const employee = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, role: true, managerId: true, orgId: true },
    });
    if (!employee || employee.orgId !== actor.orgId) {
      throw new NotFoundException('Employee not found');
    }

    const isSelf = employee.id === actor.userId;
    const isPrivilegedViewer = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);
    const isManagerOfEmployee = actor.role === Role.MANAGER && employee.managerId === actor.userId;
    if (!isSelf && !isPrivilegedViewer && !isManagerOfEmployee) {
      throw new ForbiddenException('You do not have permission to view this employee report');
    }

    const from = businessDateOnly(fromStr);
    const to = businessDateOnly(toStr);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('`from` must be on or before `to`');
    }
    const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (spanDays > MAX_REPORT_RANGE_DAYS) {
      throw new BadRequestException(`Date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`);
    }

    const [attendances, activities] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { userId: targetId, date: { gte: from, lte: to } },
      }),
      this.prisma.employeeActivity.findMany({
        where: { userId: targetId, occurredAt: { gte: businessDayStartInstant(from), lte: businessDayEndInstant(to) } },
        include: { lead: { select: { id: true, name: true } } },
        orderBy: { occurredAt: 'asc' },
      }),
    ]);

    const attendanceByDay = new Map(attendances.map((a) => [a.date.toISOString(), a]));
    const activitiesByDay = new Map<string, typeof activities>();
    for (const activity of activities) {
      const key = businessDateOnly(activity.occurredAt).toISOString();
      const list = activitiesByDay.get(key) ?? [];
      list.push(activity);
      activitiesByDay.set(key, list);
    }

    const days = businessDaysBetween(from, to).map((date) => {
      const key = date.toISOString();
      const attendance = attendanceByDay.get(key);
      return {
        date: key,
        // Absent = no attendance row for the day (never stored).
        present: Boolean(attendance),
        attendance: attendance
          ? {
              status: attendance.status,
              checkInAt: attendance.checkInAt,
              checkOutAt: attendance.checkOutAt,
              workedMinutes: attendance.workedMinutes,
              summary: attendance.summary,
            }
          : null,
        activities: activitiesByDay.get(key) ?? [],
      };
    });

    const presentDays = days.filter((d) => d.present).length;
    return {
      employee: { id: employee.id, name: employee.name, role: employee.role },
      from: from.toISOString(),
      to: to.toISOString(),
      summary: { totalDays: days.length, presentDays, absentDays: days.length - presentDays },
      days,
    };
  }

  private async getForUser(userId: string, dateStr?: string) {
    const date = dateStr ? startOfDay(dateStr) : startOfDay();
    return this.prisma.employeeActivity.findMany({
      where: { userId, occurredAt: { gte: date, lte: endOfDay(date) } },
      orderBy: { occurredAt: 'desc' },
      include: { lead: { select: { id: true, name: true } } },
    });
  }
}

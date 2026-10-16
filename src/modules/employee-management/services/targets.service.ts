import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EmployeeActivityType, LeadStatus, Prisma, Target, TargetMetric, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { BUSINESS_TIMEZONE } from '../../../common/utils/business-date.util';
import { SetTargetDto } from '../dto/set-target.dto';

const BUSINESS_TZ_OFFSET_MS = 330 * 60_000; // IST, UTC+5:30 (no DST)

/** Roles a target can be set for — everyone who sells, not the Admins who run the org. */
const TARGETABLE_ROLES: Role[] = [Role.MANAGER, Role.CALLER];

interface TargetProgress {
  userId: string;
  fullName: string;
  role: Role;
  periodYear: number;
  periodMonth: number;
  metric: TargetMetric | null;
  targetValue: number | null;
  actualValue: number | null;
}

type TargetEmployee = { id: string; name: string; role: Role };

/** The current year/month in the business timezone (not the server's). */
function currentBusinessPeriod(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month') };
}

/** The real instants a business-timezone calendar month starts and ends at. */
function businessMonthRange(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BUSINESS_TZ_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BUSINESS_TZ_OFFSET_MS),
  };
}

@Injectable()
export class TargetsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sets (or replaces) one employee's target for a month. A Manager sets
   * targets for their direct reports; an Admin for any Manager or sales
   * executive in the org.
   */
  async setTarget(actor: AuthenticatedUser, dto: SetTargetDto): Promise<Target> {
    const employee = await this.assertCanSetTarget(actor, dto.userId);

    return this.prisma.target.upsert({
      where: {
        userId_periodYear_periodMonth: {
          userId: employee.id,
          periodYear: dto.periodYear,
          periodMonth: dto.periodMonth,
        },
      },
      create: {
        orgId: actor.orgId,
        userId: employee.id,
        periodYear: dto.periodYear,
        periodMonth: dto.periodMonth,
        metric: dto.metric,
        targetValue: dto.targetValue,
        setById: actor.userId,
      },
      update: {
        metric: dto.metric,
        targetValue: dto.targetValue,
        setById: actor.userId,
      },
    });
  }

  async getMyProgress(actor: AuthenticatedUser, year?: number, month?: number): Promise<TargetProgress> {
    const employee = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    return this.buildProgress(employee, actor.orgId, year, month);
  }

  /** Current-month target vs actual for one employee — caller is responsible for the access check. */
  async getProgressForEmployee(userId: string, fullName: string, orgId: string): Promise<TargetProgress> {
    const employee = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { ...(await this.buildProgress(employee, orgId)), fullName };
  }

  /**
   * Target vs actual for everyone the caller sets targets for: a Manager's
   * direct reports, or — for an Admin — every active Manager and sales
   * executive in the org.
   */
  async getTeamProgress(actor: AuthenticatedUser, year?: number, month?: number): Promise<TargetProgress[]> {
    const isAdmin = ([Role.ADMIN, Role.SUPER_ADMIN] as Role[]).includes(actor.role);
    if (actor.role !== Role.MANAGER && !isAdmin) {
      throw new ForbiddenException("Only Managers and Admins can view their team's targets");
    }

    const members = await this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        ...(isAdmin ? { role: { in: TARGETABLE_ROLES } } : { managerId: actor.userId }),
      },
      orderBy: { name: 'asc' },
    });

    return Promise.all(members.map((member) => this.buildProgress(member, actor.orgId, year, month)));
  }

  private async buildProgress(
    employee: TargetEmployee,
    orgId: string,
    year?: number,
    month?: number,
  ): Promise<TargetProgress> {
    const current = currentBusinessPeriod();
    const periodYear = year ?? current.year;
    const periodMonth = month ?? current.month;

    const base = {
      userId: employee.id,
      fullName: employee.name,
      role: employee.role,
      periodYear,
      periodMonth,
    };

    const target = await this.prisma.target.findUnique({
      where: { userId_periodYear_periodMonth: { userId: employee.id, periodYear, periodMonth } },
    });

    if (!target) {
      return { ...base, metric: null, targetValue: null, actualValue: null };
    }

    const actualValue = await this.countActual(employee.id, orgId, target.metric, periodYear, periodMonth);
    return { ...base, metric: target.metric, targetValue: target.targetValue, actualValue };
  }

  /**
   * CALLS: calls the employee logged as daily activities that month.
   * CONVERSIONS: leads assigned to them that were converted that month (and
   * still are) — by when they converted, not when the lead was last edited.
   */
  private countActual(
    userId: string,
    orgId: string,
    metric: TargetMetric,
    year: number,
    month: number,
  ): Promise<number> {
    const { start, end } = businessMonthRange(year, month);
    const inMonth: Prisma.DateTimeFilter = { gte: start, lt: end };

    if (metric === TargetMetric.CALLS) {
      return this.prisma.employeeActivity.count({
        where: { orgId, userId, type: EmployeeActivityType.CALL, occurredAt: inMonth },
      });
    }

    return this.prisma.lead.count({
      where: { orgId, assignedToId: userId, status: LeadStatus.CONVERTED, convertedAt: inMonth },
    });
  }

  private async assertCanSetTarget(actor: AuthenticatedUser, employeeId: string) {
    const isAdmin = ([Role.ADMIN, Role.SUPER_ADMIN] as Role[]).includes(actor.role);
    if (actor.role !== Role.MANAGER && !isAdmin) {
      throw new ForbiddenException('Only Managers and Admins can set targets');
    }

    const employee = await this.prisma.user.findFirst({
      where: {
        id: employeeId,
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        role: { in: TARGETABLE_ROLES },
        ...(isAdmin ? {} : { managerId: actor.userId }),
      },
    });

    if (!employee) {
      throw new NotFoundException(
        isAdmin ? 'Employee not found in your organization' : 'Employee not found under your management',
      );
    }

    return employee;
  }
}

/** Parses the optional ?year=&month= query of the target endpoints. */
export function parseTargetPeriod(year?: string, month?: string): { year?: number; month?: number } {
  const y = year ? Number(year) : undefined;
  const m = month ? Number(month) : undefined;
  if (y !== undefined && (!Number.isInteger(y) || y < 2020 || y > 2100)) {
    throw new BadRequestException('year must be a whole number from 2020');
  }
  if (m !== undefined && (!Number.isInteger(m) || m < 1 || m > 12)) {
    throw new BadRequestException('month must be a whole number from 1 to 12');
  }
  return { year: y, month: m };
}

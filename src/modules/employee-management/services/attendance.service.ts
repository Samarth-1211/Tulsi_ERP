import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Attendance, AttendanceStatus, LeaveStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { businessDateOnly, businessStartOfMonth } from '../../../common/utils/business-date.util';
import { CheckInDto } from '../dto/check-in.dto';
import { CheckOutDto } from '../dto/check-out.dto';
import { AttendanceListQueryDto, AttendanceRangeQueryDto } from '../dto/attendance-range-query.dto';

const startOfDay = businessDateOnly;
const startOfMonth = businessStartOfMonth;

/** Used when an org has no OrgSettings row yet (schema default). */
const DEFAULT_CHECKOUT_SUMMARY_MIN_LENGTH = 20;

// Everyone except SUPER_ADMIN checks in and out.
export const ATTENDANCE_ROLES: Role[] = [
  Role.ADMIN,
  Role.MANAGER,
  Role.CALLER,
  Role.DELIVERY_PARTNER,
  Role.WAREHOUSE_STAFF,
];

const USER_SUMMARY = { select: { id: true, name: true, role: true, managerId: true } } as const;

/**
 * Daily check-in / check-out. One row per user per org-local day; "absent"
 * means no row for that day and is computed in reports, never stored.
 */
@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async checkIn(actor: AuthenticatedUser, dto: CheckInDto): Promise<Attendance> {
    this.assertCanMarkAttendance(actor);
    const today = startOfDay();

    const onApprovedLeave = await this.prisma.leaveRequest.findFirst({
      where: {
        userId: actor.userId,
        status: LeaveStatus.APPROVED,
        startDate: { lte: today },
        endDate: { gte: today },
      },
    });
    if (onApprovedLeave) {
      throw new BadRequestException('You are on approved leave today, so attendance cannot be checked in');
    }

    try {
      return await this.prisma.attendance.create({
        data: {
          orgId: actor.orgId,
          userId: actor.userId,
          date: today,
          checkInAt: new Date(),
          checkInLat: dto.lat,
          checkInLng: dto.lng,
          status: AttendanceStatus.CHECKED_IN,
        },
      });
    } catch (error) {
      // @@unique([userId, date]) — one check-in per org-local day.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already checked in for today');
      }
      throw error;
    }
  }

  /** Checking out requires a work summary of at least OrgSettings.checkoutSummaryMinLength characters. */
  async checkOut(actor: AuthenticatedUser, dto: CheckOutDto): Promise<Attendance> {
    this.assertCanMarkAttendance(actor);

    const settings = await this.prisma.orgSettings.findUnique({
      where: { orgId: actor.orgId },
      select: { checkoutSummaryMinLength: true },
    });
    const minLength = settings?.checkoutSummaryMinLength ?? DEFAULT_CHECKOUT_SUMMARY_MIN_LENGTH;
    const summary = (dto.summary ?? '').trim();
    if (summary.length < minLength) {
      throw new BadRequestException(`A work summary of at least ${minLength} characters is required to check out`);
    }

    const existing = await this.prisma.attendance.findUnique({
      where: { userId_date: { userId: actor.userId, date: startOfDay() } },
    });
    if (!existing) {
      throw new BadRequestException('You have not checked in today yet');
    }
    if (existing.checkOutAt) {
      throw new ConflictException('You have already checked out for today');
    }

    const now = new Date();
    // Conditional on checkOutAt still being null, so a double-submitted
    // check-out can't record the day twice.
    const { count } = await this.prisma.attendance.updateMany({
      where: { id: existing.id, checkOutAt: null },
      data: {
        checkOutAt: now,
        checkOutLat: dto.lat,
        checkOutLng: dto.lng,
        summary,
        workedMinutes: Math.max(0, Math.round((now.getTime() - existing.checkInAt.getTime()) / 60_000)),
        status: AttendanceStatus.CHECKED_OUT,
      },
    });
    if (count === 0) {
      throw new ConflictException('You have already checked out for today');
    }

    return this.prisma.attendance.findUniqueOrThrow({ where: { id: existing.id } });
  }

  async getToday(actor: AuthenticatedUser): Promise<Attendance | null> {
    return this.prisma.attendance.findUnique({
      where: { userId_date: { userId: actor.userId, date: startOfDay() } },
    });
  }

  async getMyAttendance(actor: AuthenticatedUser, query: AttendanceRangeQueryDto): Promise<Attendance[]> {
    return this.prisma.attendance.findMany({
      where: { userId: actor.userId, date: this.dateRange(query) },
      orderBy: { date: 'desc' },
    });
  }

  /**
   * GET /attendance?userId&from&to — ADMIN: whole org; MANAGER: own team only
   * (their direct reports, plus themselves).
   */
  async list(actor: AuthenticatedUser, query: AttendanceListQueryDto) {
    const where: Prisma.AttendanceWhereInput = { orgId: actor.orgId, date: this.dateRange(query) };

    if (actor.role === Role.MANAGER) {
      if (query.userId && query.userId !== actor.userId) {
        await this.assertManagerOf(actor, query.userId);
        where.userId = query.userId;
      } else if (query.userId) {
        where.userId = actor.userId;
      } else {
        where.OR = [{ userId: actor.userId }, { user: { managerId: actor.userId } }];
      }
    } else if (actor.role === Role.ADMIN) {
      if (query.userId) where.userId = query.userId;
    } else {
      throw new ForbiddenException('Only Admins and Managers can list attendance');
    }

    return this.prisma.attendance.findMany({
      where,
      orderBy: [{ date: 'desc' }, { checkInAt: 'asc' }],
      include: { user: USER_SUMMARY },
    });
  }

  async getEmployeeAttendance(actor: AuthenticatedUser, employeeId: string, query: AttendanceRangeQueryDto) {
    const employee = await this.prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee || employee.orgId !== actor.orgId) {
      throw new NotFoundException('Employee not found');
    }

    const isSelf = employee.id === actor.userId;
    const isAdmin = actor.role === Role.ADMIN;
    const isManagerOfEmployee = actor.role === Role.MANAGER && employee.managerId === actor.userId;
    if (!isSelf && !isAdmin && !isManagerOfEmployee) {
      throw new ForbiddenException('You do not have permission to view this employee attendance');
    }

    return this.prisma.attendance.findMany({
      where: { userId: employeeId, date: this.dateRange(query) },
      orderBy: { date: 'desc' },
    });
  }

  /** Manager's team for one day; members without a row are ABSENT (or not checked in yet, today). */
  async getTeamAttendanceForDate(actor: AuthenticatedUser, dateStr?: string) {
    if (actor.role !== Role.MANAGER) {
      throw new ForbiddenException('Only Managers can request team attendance');
    }
    const members = await this.prisma.user.findMany({
      where: { orgId: actor.orgId, managerId: actor.userId, status: UserStatus.ACTIVE, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return this.dayRollup(members, dateStr);
  }

  /** Org-wide attendance for one day — every active user who checks in. */
  async getOrgAttendanceForDate(actor: AuthenticatedUser, dateStr?: string) {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only Admins can request org-wide attendance');
    }
    const members = await this.prisma.user.findMany({
      where: { orgId: actor.orgId, status: UserStatus.ACTIVE, deletedAt: null, role: { in: ATTENDANCE_ROLES } },
      orderBy: [{ managerId: 'asc' }, { name: 'asc' }],
    });
    return this.dayRollup(members, dateStr);
  }

  private async dayRollup(
    members: { id: string; name: string; role: Role; managerId: string | null }[],
    dateStr?: string,
  ) {
    const date = startOfDay(dateStr ?? new Date());
    const isToday = date.getTime() === startOfDay().getTime();

    const rows = await this.prisma.attendance.findMany({
      where: { userId: { in: members.map((u) => u.id) }, date },
    });
    const byUserId = new Map(rows.map((a) => [a.userId, a]));

    return members.map((member) => {
      const record = byUserId.get(member.id);
      return {
        userId: member.id,
        name: member.name,
        role: member.role,
        managerId: member.managerId,
        // No row = absent; today it may simply mean "not checked in yet".
        status: record?.status ?? (isToday ? null : AttendanceStatus.ABSENT),
        checkInAt: record?.checkInAt ?? null,
        checkOutAt: record?.checkOutAt ?? null,
        workedMinutes: record?.workedMinutes ?? null,
        summary: record?.summary ?? null,
      };
    });
  }

  private assertCanMarkAttendance(actor: AuthenticatedUser) {
    if (!ATTENDANCE_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Super Admins do not mark attendance');
    }
  }

  private async assertManagerOf(actor: AuthenticatedUser, userId: string) {
    const member = await this.prisma.user.findFirst({
      where: { id: userId, orgId: actor.orgId, managerId: actor.userId },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException('You can only view attendance for your own team');
    }
  }

  private dateRange(query: AttendanceRangeQueryDto): Prisma.DateTimeFilter {
    return {
      gte: query.from ? startOfDay(query.from) : startOfMonth(),
      lte: query.to ? startOfDay(query.to) : startOfDay(),
    };
  }
}

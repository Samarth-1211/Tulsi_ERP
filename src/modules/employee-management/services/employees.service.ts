import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { LeadStatus, NotificationType, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { stripDeletedMarker } from '../../../common/services/user-deletion.service';
import { EmailDeliveryStatus } from '../../mail/mail.service';
import { EmailChangeService } from '../../verification/email-change.service';
import { AttendanceService } from './attendance.service';
import { TargetsService } from './targets.service';
import { UpdateProfileDto, UpdateEmployeeCodeDto, ChangeEmailDto, ChangePasswordDto } from '../dto/update-profile.dto';

const SALT_ROUNDS = 12;

interface EmployeeSummary {
  userId: string;
  name: string;
  role: Role;
  leadsAssigned: number;
  activeWorkload: number;
  totalConversions: number;
  statusBreakdown: Record<LeadStatus, number>;
}

interface TeamMemberSummary {
  userId: string;
  name: string;
  role: Role;
  activeLeadCount: number;
}

interface EmployeeProfile {
  userId: string;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  employeeCode: string | null;
  photoUrl: string | null;
  joiningDate: Date;
  isActive: boolean;
  isVerified: boolean;
  isTemporaryPassword: boolean;
  managerId: string | null;
  managerName: string | null;
  /** Set once the account has been deleted — its history stays viewable to Admins. */
  deletedAt: Date | null;
}

const ALL_STATUSES: LeadStatus[] = [
  LeadStatus.NEW,
  LeadStatus.ASSIGNED,
  LeadStatus.IN_PROGRESS,
  LeadStatus.CONVERTED,
  LeadStatus.LOST,
];

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendanceService: AttendanceService,
    private readonly targetsService: TargetsService,
    private readonly emailChangeService: EmailChangeService,
  ) {}

  async getSummary(actor: AuthenticatedUser, employeeId: string): Promise<EmployeeSummary> {
    const employee = await this.prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee || employee.orgId !== actor.orgId) {
      throw new NotFoundException('Employee not found');
    }

    const isSelf = employee.id === actor.userId;
const isPrivilegedViewer: boolean = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);
    const isManagerOfEmployee = actor.role === Role.MANAGER && employee.managerId === actor.userId;

    if (!isSelf && !isPrivilegedViewer && !isManagerOfEmployee) {
      throw new ForbiddenException('You do not have permission to view this employee summary');
    }

    const leadsByStatus = await this.prisma.lead.groupBy({
      by: ['status'],
      where: { assignedToId: employeeId, orgId: actor.orgId, deletedAt: null },
      _count: { _all: true },
    });

    const statusBreakdown = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
    for (const row of leadsByStatus as { status: LeadStatus; _count: { _all: number } }[]) {
      statusBreakdown[row.status] = row._count._all;
    }

    return {
      userId: employee.id,
      name: employee.name,
      role: employee.role,
      leadsAssigned: Object.values(statusBreakdown).reduce((sum, n) => sum + n, 0),
      activeWorkload: statusBreakdown[LeadStatus.IN_PROGRESS],
      totalConversions: statusBreakdown[LeadStatus.CONVERTED],
      statusBreakdown,
    };
  }

  async getTeamSummary(actor: AuthenticatedUser): Promise<TeamMemberSummary[]> {
    if (actor.role !== Role.MANAGER) {
      throw new ForbiddenException('Only Managers can request a team summary');
    }

    const directReports = await this.prisma.user.findMany({
      where: { orgId: actor.orgId, managerId: actor.userId, status: UserStatus.ACTIVE, deletedAt: null },
    });

    const results: TeamMemberSummary[] = [];

    for (const member of directReports) {
      const activeLeadCount = await this.prisma.lead.count({
        where: {
          orgId: actor.orgId,
          assignedToId: member.id,
          deletedAt: null,
          status: { in: [LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS] },
        },
      });

      results.push({
        userId: member.id,
        name: member.name,
        role: member.role,
        activeLeadCount,
      });
    }

    return results;
  }

  async getProfile(actor: AuthenticatedUser, employeeId: string): Promise<EmployeeProfile> {
    const employee = await this.prisma.user.findUnique({
      where: { id: employeeId },
      include: { manager: { select: { name: true } } },
    });
    if (!employee || employee.orgId !== actor.orgId) {
      throw new NotFoundException('Employee not found');
    }

    const isSelf = employee.id === actor.userId;
    const isPrivilegedViewer = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);
    const isManagerOfEmployee = actor.role === Role.MANAGER && employee.managerId === actor.userId;

    if (!isSelf && !isPrivilegedViewer && !isManagerOfEmployee) {
      throw new ForbiddenException('You do not have permission to view this employee profile');
    }

    return {
      userId: employee.id,
      name: employee.name,
      email: stripDeletedMarker(employee.email),
      role: employee.role,
      phone: employee.phone,
      employeeCode: employee.employeeCode && stripDeletedMarker(employee.employeeCode),
      photoUrl: employee.photoUrl,
      joiningDate: employee.createdAt,
      isActive: employee.status === UserStatus.ACTIVE,
      isVerified: employee.isVerified,
      isTemporaryPassword: employee.isTemporaryPassword,
      managerId: employee.managerId,
      managerName: employee.manager ? employee.manager.name : null,
      deletedAt: employee.deletedAt,
    };
  }

  /**
   * Everything about one employee in a single payload, for the Admin's user
   * detail page: profile, lead pipeline plus the assigned leads themselves,
   * leave history, this month's target, direct reports
   * and tasks. Attendance and day-by-day activity are date-range driven, so
   * they stay on their own endpoints (GET /attendance/:id, GET
   * /activities/report). Same access rule as getProfile, which enforces it.
   */
  async getOverview(actor: AuthenticatedUser, employeeId: string) {
    const profile = await this.getProfile(actor, employeeId);

    const [leads, leaveRequests, target, directReports, tasks] =
      await Promise.all([
        this.prisma.lead.findMany({
          where: { orgId: actor.orgId, assignedToId: employeeId, deletedAt: null },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            city: true,
            customerType: true,
            source: true,
            status: true,
            nextFollowUpAt: true,
            lastActivityAt: true,
            convertedAt: true,
            assignedAt: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
        }),
        this.prisma.leaveRequest.findMany({
          where: { userId: employeeId, orgId: actor.orgId },
          include: { reviewedBy: { select: { id: true, name: true } } },
          orderBy: { startDate: 'desc' },
        }),
        this.targetsService.getProgressForEmployee(employeeId, profile.name, actor.orgId),
        this.prisma.user.findMany({
          where: { orgId: actor.orgId, managerId: employeeId, deletedAt: null },
          select: { id: true, name: true, email: true, role: true, status: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.task.findMany({
          where: { userId: employeeId, orgId: actor.orgId },
          select: {
            id: true,
            title: true,
            taskType: true,
            priority: true,
            status: true,
            dueAt: true,
            completedAt: true,
            createdAt: true,
            lead: { select: { id: true, name: true } },
          },
          orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
          take: 200,
        }),
      ]);

    const statusBreakdown = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
    for (const lead of leads) {
      statusBreakdown[lead.status] += 1;
    }
    const now = new Date();
    const openStatuses: LeadStatus[] = [LeadStatus.NEW, LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS];

    return {
      profile,
      leadSummary: {
        total: leads.length,
        activeWorkload: statusBreakdown[LeadStatus.IN_PROGRESS],
        conversions: statusBreakdown[LeadStatus.CONVERTED],
        overdueFollowUps: leads.filter(
          (l) => l.nextFollowUpAt && l.nextFollowUpAt < now && openStatuses.includes(l.status),
        ).length,
        statusBreakdown,
      },
      leads,
      leaveRequests,
      target,
      directReports,
      tasks,
    };
  }

  async updateMyProfile(actor: AuthenticatedUser, dto: UpdateProfileDto): Promise<EmployeeProfile> {
    await this.prisma.user.update({
      where: { id: actor.userId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.photoUrl !== undefined ? { photoUrl: dto.photoUrl } : {}),
      },
    });

    await this.prisma.notification.create({
      data: {
        orgId: actor.orgId,
        userId: actor.userId,
        type: NotificationType.GENERIC,
        title: 'Profile updated',
        message: 'Your profile details were updated.',
      },
    });

    return this.getProfile(actor, actor.userId);
  }

  /**
   * Switches the login email and sends a verification link to the new address;
   * the account shows as unverified until it is clicked. Re-submitting the
   * current address while still unverified just resends the link.
   */
  async changeEmail(
    actor: AuthenticatedUser,
    dto: ChangeEmailDto,
  ): Promise<EmployeeProfile & { emailDelivery: EmailDeliveryStatus }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });

    const passwordMatches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (dto.newEmail === user.email.toLowerCase() && user.isVerified) {
      throw new BadRequestException('This is already your verified email address');
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.newEmail },
    });
    if (existing && existing.id !== actor.userId) {
      throw new ConflictException('A user with this email already exists in your organization');
    }

    const { emailDelivery } = await this.emailChangeService.changeEmail(actor.userId, dto.newEmail);

    await this.prisma.notification.create({
      data: {
        orgId: actor.orgId,
        userId: actor.userId,
        type: NotificationType.GENERIC,
        title: 'Email updated',
        message: `Your login email was changed to ${dto.newEmail}. Verify it using the link sent there before your next sign-in.`,
      },
    });

    return { ...(await this.getProfile(actor, actor.userId)), emailDelivery };
  }

  async changePassword(actor: AuthenticatedUser, dto: ChangePasswordDto): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });

    const passwordMatches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: actor.userId },
        data: { passwordHash, isTemporaryPassword: false },
      }),
      this.prisma.notification.create({
        data: {
          orgId: actor.orgId,
          userId: actor.userId,
          type: NotificationType.GENERIC,
          title: 'Password changed',
          message: 'Your password was changed successfully.',
        },
      }),
    ]);

    return { success: true };
  }

  async setEmployeeCode(actor: AuthenticatedUser, employeeId: string, dto: UpdateEmployeeCodeDto): Promise<EmployeeProfile> {
    const isPrivileged = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);

    const employee = await this.prisma.user.findFirst({
      where: {
        id: employeeId,
        orgId: actor.orgId,
        ...(isPrivileged ? {} : { managerId: actor.userId }),
      },
    });

    if (!employee) {
      if (!isPrivileged && actor.role !== Role.MANAGER) {
        throw new ForbiddenException('Only Managers or Admins can set an employee code');
      }
      throw new NotFoundException('Employee not found under your management');
    }

    const clash = await this.prisma.user.findFirst({
      where: { orgId: actor.orgId, employeeCode: dto.employeeCode, NOT: { id: employeeId } },
    });
    if (clash) {
      throw new ConflictException('This employee code is already in use in your organization');
    }

    await this.prisma.user.update({ where: { id: employeeId }, data: { employeeCode: dto.employeeCode } });

    return this.getProfile(actor, employeeId);
  }

  /**
   * Single combined view for a Manager: today's attendance status, active
   * lead snapshot, and current-month target progress per direct report —
   * so a Manager doesn't have to open three separate screens per person.
   */
  async getTeamRollup(actor: AuthenticatedUser) {
    if (actor.role !== Role.MANAGER) {
      throw new ForbiddenException('Only Managers can request a team rollup');
    }

    const [attendanceToday, targetProgress, directReports] = await Promise.all([
      this.attendanceService.getTeamAttendanceForDate(actor),
      this.targetsService.getTeamProgress(actor),
      this.prisma.user.findMany({
        where: { orgId: actor.orgId, managerId: actor.userId, status: UserStatus.ACTIVE, deletedAt: null },
      }),
    ]);

    const attendanceByUser = new Map(attendanceToday.map((a) => [a.userId, a]));
    const targetByUser = new Map(targetProgress.map((t) => [t.userId, t]));

    const rollup = [];
    for (const member of directReports) {
      const leadsByStatus = await this.prisma.lead.groupBy({
        by: ['status'],
        where: { assignedToId: member.id, orgId: actor.orgId, deletedAt: null },
        _count: { _all: true },
      });
      const statusBreakdown = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
      for (const row of leadsByStatus as { status: LeadStatus; _count: { _all: number } }[]) {
        statusBreakdown[row.status] = row._count._all;
      }

      rollup.push({
        userId: member.id,
        name: member.name,
        role: member.role,
        attendanceToday: attendanceByUser.get(member.id)?.status ?? null,
        leadSnapshot: {
          inProgress: statusBreakdown[LeadStatus.IN_PROGRESS],
          converted: statusBreakdown[LeadStatus.CONVERTED],
          lost: statusBreakdown[LeadStatus.LOST],
          statusBreakdown,
        },
        target: targetByUser.get(member.id) ?? null,
      });
    }

    return rollup;
  }
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LeaveRequest, LeaveStatus, Role } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { businessDateOnly } from '../../../common/utils/business-date.util';
import { ApplyLeaveDto } from '../dto/apply-leave.dto';
import { ReviewLeaveDto } from '../dto/review-leave.dto';

const startOfDay = businessDateOnly;

@Injectable()
export class LeaveService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(actor: AuthenticatedUser, dto: ApplyLeaveDto): Promise<LeaveRequest> {
    const startDate = startOfDay(dto.startDate);
    const endDate = startOfDay(dto.endDate);

    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    return this.prisma.leaveRequest.create({
      data: {
        orgId: actor.orgId,
        userId: actor.userId,
        startDate,
        endDate,
        reason: dto.reason,
      },
    });
  }

  async getMine(actor: AuthenticatedUser): Promise<LeaveRequest[]> {
    return this.prisma.leaveRequest.findMany({
      where: { userId: actor.userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTeamPending(actor: AuthenticatedUser) {
    if (actor.role !== Role.MANAGER) {
      throw new ForbiddenException('Only Managers can view their team\'s pending leave requests');
    }

    return this.prisma.leaveRequest.findMany({
      where: {
        status: LeaveStatus.PENDING,
        user: { orgId: actor.orgId, managerId: actor.userId },
      },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getOrgLeaveRequests(actor: AuthenticatedUser, status?: LeaveStatus) {
    if (!([Role.ADMIN, Role.SUPER_ADMIN] as Role[]).includes(actor.role)) {
      throw new ForbiddenException('Only Admins can view org-wide leave requests');
    }

    return this.prisma.leaveRequest.findMany({
      where: {
        orgId: actor.orgId,
        ...(status ? { status } : {}),
      },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approve(actor: AuthenticatedUser, leaveId: string, dto: ReviewLeaveDto): Promise<LeaveRequest> {
    const leave = await this.assertReviewable(actor, leaveId);

    const updated = await this.prisma.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: LeaveStatus.APPROVED,
        reviewedById: actor.userId,
        reviewedAt: new Date(),
        reviewComment: dto.comment,
      },
    });

    // Attendance rows are not backfilled: a leave day simply has no row, and
    // reports read approved LeaveRequests to tell leave apart from absence.

    return updated;
  }

  async reject(actor: AuthenticatedUser, leaveId: string, dto: ReviewLeaveDto): Promise<LeaveRequest> {
    const leave = await this.assertReviewable(actor, leaveId);

    return this.prisma.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: LeaveStatus.REJECTED,
        reviewedById: actor.userId,
        reviewedAt: new Date(),
        reviewComment: dto.comment,
      },
    });
  }

  private async assertReviewable(actor: AuthenticatedUser, leaveId: string): Promise<LeaveRequest> {
    const leave = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      include: { user: true },
    });

    if (!leave || leave.orgId !== actor.orgId) {
      throw new NotFoundException('Leave request not found');
    }

    const isPrivileged = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);
    const isManagerOfApplicant = actor.role === Role.MANAGER && leave.user.managerId === actor.userId;

    if (!isPrivileged && !isManagerOfApplicant) {
      throw new ForbiddenException('You do not have permission to review this leave request');
    }

    if (leave.status !== LeaveStatus.PENDING) {
      throw new BadRequestException('This leave request has already been reviewed');
    }

    return leave;
  }
}

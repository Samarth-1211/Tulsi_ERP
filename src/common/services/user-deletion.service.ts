import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityType,
  AssignmentMethod,
  LeadStatus,
  LeaveStatus,
  NotificationType,
  Prisma,
  TaskStatus,
  User,
  Role,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Appended to a deleted user's email (and employee code) so the original
 * value is free again — the same person can later be re-added as a brand-new
 * account without tripping the per-organization unique constraints.
 */
const DELETED_MARKER = '#deleted-';

/** Strips the deletion marker, giving back the email / employee code the user actually had. */
export function stripDeletedMarker(value: string): string {
  const i = value.indexOf(DELETED_MARKER);
  return i === -1 ? value : value.slice(0, i);
}

// Roles that work leads — who can take over a deleted user's open leads (besides Managers).
const SALES_ROLES: Role[] = [Role.CALLER];
const STAFF_ROLES: Role[] = [Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF];
const OPEN_LEAD_STATUSES: LeadStatus[] = [LeadStatus.NEW, LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS];

// Which roles each role may delete. Managers are further limited to their own
// direct reports (see getDeletableUser).
const DELETABLE_ROLES: Record<Role, Role[]> = {
  SUPER_ADMIN: [Role.ADMIN, Role.MANAGER, ...STAFF_ROLES],
  ADMIN: [Role.MANAGER, ...STAFF_ROLES],
  MANAGER: [Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF],
  CALLER: [],
  DELIVERY_PARTNER: [],
  WAREHOUSE_STAFF: [],
};

const candidateSelect = { id: true, name: true, email: true, role: true } as const;
type Candidate = Prisma.UserGetPayload<{ select: typeof candidateSelect }>;

export interface DeletionImpact {
  user: Candidate;
  /** NEW / ASSIGNED / IN_PROGRESS leads — converted and lost leads stay on the archived account as history. */
  openLeads: number;
  /** PENDING tasks owned by the user. */
  openTasks: number;
  directReports: (Candidate & { status: UserStatus })[];
  /** Who can take over the open leads + tasks (empty when there's nothing to hand over). */
  workCandidates: Candidate[];
  /** Managers who can take over the direct reports (empty when there are none). */
  managerCandidates: Candidate[];
}

export interface DeletionOptions {
  reason?: string;
  /** Required when the user still has open leads or pending tasks. */
  reassignWorkToId?: string;
  /** Required when the user still has direct reports. */
  reassignTeamToId?: string;
}

/**
 * Deletes a user account by archiving it rather than removing the row.
 *
 * Everything the user did stays readable for Admins afterwards — attendance,
 * lead activity, audit trail, closed leads, completed tasks — and nothing
 * historical can block the delete. What the organization still needs from the
 * account is handed over first:
 *  - open leads and pending tasks go to `reassignWorkToId`;
 *  - direct reports move to the manager `reassignTeamToId`.
 * The admin picks both in the delete dialog (driven by getImpact()).
 *
 * The archived account can never sign in again, and its email / employee code
 * are released so the same person can be re-added later as a fresh account.
 */
@Injectable()
export class UserDeletionService {
  private readonly logger = new Logger(UserDeletionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Loads a deletable user, enforcing org scoping and the role hierarchy. */
  async getDeletableUser(actor: AuthenticatedUser, id: string): Promise<User> {
    const target = await this.prisma.user.findUnique({ where: { id } });

    if (!target || target.deletedAt || target.orgId !== actor.orgId) {
      throw new NotFoundException('User not found');
    }
    if (target.id === actor.userId) {
      throw new ForbiddenException('You cannot delete your own account');
    }
    if (!DELETABLE_ROLES[actor.role].includes(target.role)) {
      throw new ForbiddenException(`A ${actor.role} cannot delete an account with role ${target.role}`);
    }
    if (actor.role === Role.MANAGER && target.managerId !== actor.userId) {
      throw new NotFoundException('Team member not found under your management');
    }

    return target;
  }

  async getImpact(actor: AuthenticatedUser, target: User): Promise<DeletionImpact> {
    const [openLeads, openTasks, directReports] = await Promise.all([
      this.countOpenLeads(target.id),
      this.countOpenTasks(target.id),
      this.prisma.user.findMany({
        where: { managerId: target.id, deletedAt: null },
        select: { ...candidateSelect, status: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const [workCandidates, managerCandidates] = await Promise.all([
      openLeads + openTasks > 0 ? this.findWorkCandidates(actor, target) : [],
      directReports.length > 0 ? this.findManagerCandidates(actor, target) : [],
    ]);

    return {
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        role: target.role,
      },
      openLeads,
      openTasks,
      directReports,
      workCandidates,
      managerCandidates,
    };
  }

  async deleteUser(actor: AuthenticatedUser, target: User, options: DeletionOptions): Promise<void> {
    const id = target.id;

    const [openLeads, openTasks, directReportCount] = await Promise.all([
      this.countOpenLeads(id),
      this.countOpenTasks(id),
      this.prisma.user.count({ where: { managerId: id, deletedAt: null } }),
    ]);

    let workOwner: Candidate | null = null;
    if (openLeads + openTasks > 0) {
      if (!options.reassignWorkToId) {
        throw new BadRequestException(
          `This user still has ${openLeads} open lead(s) and ${openTasks} pending task(s). Choose who should take them over.`,
        );
      }
      workOwner =
        (await this.findWorkCandidates(actor, target, options.reassignWorkToId))[0] ?? null;
      if (!workOwner) {
        throw new BadRequestException('The selected user cannot take over these leads and tasks');
      }
    }

    let newManager: Candidate | null = null;
    if (directReportCount > 0) {
      if (!options.reassignTeamToId) {
        throw new BadRequestException(
          `This manager still has ${directReportCount} team member(s). Choose another manager to move them to.`,
        );
      }
      newManager =
        (await this.findManagerCandidates(actor, target, options.reassignTeamToId))[0] ?? null;
      if (!newManager) {
        throw new BadRequestException('The selected manager cannot take over this team');
      }
    }

    const now = new Date();
    const targetName = target.name;

    await this.prisma.$transaction(async (tx) => {
      // --- Hand over open leads -------------------------------------------
      const leads = await tx.lead.findMany({
        where: { assignedToId: id, status: { in: OPEN_LEAD_STATUSES }, deletedAt: null },
        select: { id: true, status: true },
      });
      if (leads.length > 0) {
        if (workOwner) {
          const workOwnerName = workOwner.name;
          const leadIds = leads.map((l) => l.id);
          // Matches LeadsService.assign: a NEW lead becomes ASSIGNED once it has an owner.
          await tx.lead.updateMany({
            where: { id: { in: leadIds }, status: LeadStatus.NEW },
            data: { status: LeadStatus.ASSIGNED },
          });
          await tx.lead.updateMany({
            where: { id: { in: leadIds } },
            data: { assignedToId: workOwner.id, assignedAt: now },
          });
          await tx.leadAssignment.createMany({
            data: leadIds.map((leadId) => ({
              orgId: actor.orgId,
              leadId,
              fromUserId: id,
              toUserId: workOwner!.id,
              method: AssignmentMethod.MANUAL,
              assignedById: actor.userId,
              reason: 'USER_DELETED',
            })),
          });
          await tx.leadActivityLog.createMany({
            data: leadIds.map((leadId) => ({
              orgId: actor.orgId,
              leadId,
              userId: actor.userId,
              type: ActivityType.REASSIGNED,
              message: `Lead reassigned from ${targetName} to ${workOwnerName} by ${actor.email} (previous owner's account was deleted)`,
              meta: { previousAssigneeId: id, newAssigneeId: workOwner.id, reason: 'USER_DELETED' },
            })),
          });
        } else {
          // Only reachable if a lead landed between the count above and this
          // transaction — put it back in the unassigned pool rather than
          // leave it on an account nobody can open.
          await tx.lead.updateMany({
            where: { id: { in: leads.map((l) => l.id) } },
            data: { assignedToId: null, assignedAt: null, status: LeadStatus.NEW },
          });
        }
      }

      // --- Hand over pending tasks ----------------------------------------
      await tx.task.updateMany({
        where: { userId: id, status: TaskStatus.PENDING },
        data: workOwner ? { userId: workOwner.id } : { status: TaskStatus.CANCELLED },
      });

      // --- Move the team ----------------------------------------------------
      if (newManager) {
        await tx.user.updateMany({
          where: { managerId: id, deletedAt: null },
          data: { managerId: newManager.id },
        });
      }

      // --- Detach live configuration -------------------------------------
      await tx.leaveRequest.updateMany({
        where: { userId: id, status: LeaveStatus.PENDING },
        data: { status: LeaveStatus.CANCELLED },
      });

      // --- Kill every way back in ----------------------------------------
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      await tx.verificationToken.deleteMany({ where: { userId: id } });
      await tx.passwordResetOtp.deleteMany({ where: { userId: id } });
      await tx.notification.deleteMany({ where: { userId: id } });

      // --- Archive the account -------------------------------------------
      const suffix = `${DELETED_MARKER}${now.getTime()}`;
      await tx.user.update({
        where: { id },
        data: {
          deletedAt: now,
          status: UserStatus.INACTIVE,
          email: `${target.email}${suffix}`,
          employeeCode: target.employeeCode ? `${target.employeeCode}${suffix}` : null,
        },
      });

      await tx.userAuditLog.create({
        data: {
          action: 'ADMIN_DELETED', // reused enum value — covers every role, see metadata.role
          performedById: actor.userId,
          targetUserId: id,
          reason: options.reason,
          metadata: {
            role: target.role,
            email: target.email,
            leadsReassigned: workOwner ? leads.length : 0,
            tasksReassigned: workOwner ? openTasks : 0,
            reassignedWorkToId: workOwner?.id ?? null,
            teamMovedToId: newManager?.id ?? null,
          },
        },
      });

      // --- Tell the people who picked up the work ------------------------
      if (workOwner) {
        await tx.notification.create({
          data: {
            orgId: actor.orgId,
            userId: workOwner.id,
            type: NotificationType.GENERIC,
            title: 'Work handed over to you',
            message: `${targetName}'s account was deleted. ${leads.length} open lead(s) and ${openTasks} pending task(s) are now yours.`,
          },
        });
      }
      if (newManager && newManager.id !== workOwner?.id) {
        await tx.notification.create({
          data: {
            orgId: actor.orgId,
            userId: newManager.id,
            type: NotificationType.GENERIC,
            title: 'Team members moved to you',
            message: `${targetName}'s account was deleted. ${directReportCount} team member(s) now report to you.`,
          },
        });
      }
    }, { timeout: 30_000 });

    this.logger.warn(
      `User ${id} (${target.email}, role ${target.role}) deleted by ${actor.userId}.` +
        (options.reason ? ` Reason: ${options.reason}` : ''),
    );
  }

  private countOpenLeads(userId: string) {
    return this.prisma.lead.count({ where: { assignedToId: userId, status: { in: OPEN_LEAD_STATUSES }, deletedAt: null } });
  }

  private countOpenTasks(userId: string) {
    return this.prisma.task.count({ where: { userId, status: TaskStatus.PENDING } });
  }

  /**
   * Active users who can take over the target's open leads and tasks. A
   * Manager can only hand work to their own team (or keep it themselves);
   * Admins can pick any active manager or sales person in the org. Hot
   * platform leads are handed over like any other lead.
   */
  private async findWorkCandidates(actor: AuthenticatedUser, target: User, onlyId?: string): Promise<Candidate[]> {
    const eligible: Prisma.UserWhereInput =
      actor.role === Role.MANAGER
        ? { OR: [{ id: actor.userId }, { managerId: actor.userId, role: { in: SALES_ROLES } }] }
        : { role: { in: [Role.MANAGER, ...SALES_ROLES] } };

    return this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        AND: [eligible, { id: { not: target.id } }, ...(onlyId ? [{ id: onlyId }] : [])],
      },
      select: candidateSelect,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
  }

  /** Active managers (other than the target) who can take over the target's team. */
  private findManagerCandidates(actor: AuthenticatedUser, target: User, onlyId?: string): Promise<Candidate[]> {
    return this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        role: Role.MANAGER,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        AND: [{ id: { not: target.id } }, ...(onlyId ? [{ id: onlyId }] : [])],
      },
      select: candidateSelect,
      orderBy: { name: 'asc' },
    });
  }
}

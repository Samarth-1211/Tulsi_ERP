import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, Task, TaskPriority, TaskStatus, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { managerLeadScope } from '../../../common/utils/lead-scope.util';
import { CreateTaskDto } from '../dto/create-task.dto';
import { UpdateTaskDto } from '../dto/update-task.dto';
import { TaskQueryDto, TaskSourceFilter } from '../dto/task-query.dto';

/** No reminders configured explicitly: default to 1 day + 6 hours before due. */
const DEFAULT_REMINDER_OFFSETS_MINUTES = [1440, 360];

const TASK_INCLUDE = {
  lead: { select: { id: true, fullName: true, phone: true } },
  user: { select: { id: true, name: true, role: true } },
  createdBy: { select: { id: true, name: true, role: true } },
} as const;

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actor: AuthenticatedUser, dto: CreateTaskDto): Promise<Task> {
    if (dto.leadId) {
      await this.assertLeadInOrg(actor, dto.leadId);
    }

    const assigneeId = await this.resolveAssignee(actor, dto.assignedToId);

    const task = await this.prisma.task.create({
      data: {
        orgId: actor.orgId,
        userId: assigneeId,
        createdById: actor.userId,
        title: dto.title,
        description: dto.description,
        taskType: dto.taskType,
        priority: dto.priority ?? TaskPriority.NORMAL,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        leadId: dto.leadId || null,
      },
      include: TASK_INCLUDE,
    });

    if (task.dueAt) {
      await this.scheduleReminders(task.id, task.dueAt, dto.reminderOffsetsMinutes);
    }

    if (assigneeId !== actor.userId) {
      await this.notifyAssignment(task, actor, false);
    }

    return task;
  }

  async findMine(actor: AuthenticatedUser, query: TaskQueryDto) {
    const source = query.source ?? TaskSourceFilter.ALL;

    return this.prisma.task.findMany({
      where: {
        userId: actor.userId,
        ...(source === TaskSourceFilter.PERSONAL ? { createdById: actor.userId } : {}),
        ...(source === TaskSourceFilter.ASSIGNED_TO_ME ? { NOT: { createdById: actor.userId } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.leadId ? { leadId: query.leadId } : {}),
        ...(query.from || query.to
          ? {
              dueAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: TASK_INCLUDE,
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { dueAt: 'asc' }],
    });
  }

  /** Tasks the caller has delegated to someone else (Manager/Admin view of their own assignments). */
  async findAssignedByMe(actor: AuthenticatedUser, query: TaskQueryDto) {
    return this.prisma.task.findMany({
      where: {
        orgId: actor.orgId,
        createdById: actor.userId,
        NOT: { userId: actor.userId },
        ...(query.status ? { status: query.status } : {}),
        ...(query.leadId ? { leadId: query.leadId } : {}),
      },
      include: TASK_INCLUDE,
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { dueAt: 'asc' }],
    });
  }

  async findOne(actor: AuthenticatedUser, id: string) {
    const task = await this.getAccessibleTask(actor, id);
    return this.prisma.task.findUnique({
      where: { id: task.id },
      include: { ...TASK_INCLUDE, reminders: true },
    });
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateTaskDto): Promise<Task> {
    const existing = await this.getAccessibleTask(actor, id);

    const isOwner = existing.userId === actor.userId;
    const canManage = this.canManageTask(actor, existing);

    // Only the person who delegated the task (or an Admin/the owner's Manager)
    // may reassign it or change its priority — the assignee themself
    // shouldn't be able to hand their own task off or re-rank its urgency.
    if ((dto.assignedToId || dto.priority) && !canManage) {
      throw new ForbiddenException('Only the task creator, an Admin, or your Manager can reassign or reprioritize this task');
    }
    if (!isOwner && !canManage) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    if (dto.leadId) {
      await this.assertLeadInOrg(actor, dto.leadId);
    }

    const nextAssigneeId = dto.assignedToId ? await this.resolveAssignee(actor, dto.assignedToId) : existing.userId;
    const isReassignment = nextAssigneeId !== existing.userId;

    const dueAtChanged = dto.dueAt !== undefined && new Date(dto.dueAt).getTime() !== existing.dueAt?.getTime();
    const nextDueAt = dto.dueAt !== undefined ? (dto.dueAt ? new Date(dto.dueAt) : null) : existing.dueAt;

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        taskType: dto.taskType,
        priority: dto.priority,
        leadId: dto.leadId === '' ? null : dto.leadId,
        userId: isReassignment ? nextAssigneeId : undefined,
        dueAt: dto.dueAt !== undefined ? nextDueAt : undefined,
      },
      include: TASK_INCLUDE,
    });

    if (dueAtChanged || dto.reminderOffsetsMinutes) {
      await this.prisma.taskReminder.deleteMany({ where: { taskId: id, firedAt: null } });
      if (nextDueAt) {
        await this.scheduleReminders(id, nextDueAt, dto.reminderOffsetsMinutes);
      }
    }

    if (isReassignment && nextAssigneeId !== actor.userId) {
      await this.notifyAssignment(updated, actor, true);
    }

    return updated;
  }

  async complete(actor: AuthenticatedUser, id: string): Promise<Task> {
    const existing = await this.getAccessibleTask(actor, id);
    if (existing.userId !== actor.userId && !this.canManageTask(actor, existing)) {
      throw new ForbiddenException('You do not have permission to complete this task');
    }
    await this.prisma.taskReminder.deleteMany({ where: { taskId: id, firedAt: null } });
    return this.prisma.task.update({
      where: { id },
      data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
      include: TASK_INCLUDE,
    });
  }

  async remove(actor: AuthenticatedUser, id: string): Promise<void> {
    const existing = await this.getAccessibleTask(actor, id);
    const isOwnerAndSelfCreated = existing.userId === actor.userId && existing.createdById === actor.userId;
    if (!isOwnerAndSelfCreated && !this.canManageTask(actor, existing)) {
      throw new ForbiddenException('You do not have permission to delete this task');
    }
    await this.prisma.task.delete({ where: { id } });
  }

  /**
   * Resolves who a task should be assigned to and authorizes the actor to do
   * so. With no `assignedToId`, the actor assigns to themself (always
   * allowed). Assigning to someone else requires the actor to be a Manager
   * (target must be one of their own direct reports) or an Admin/Super Admin
   * (any active user in the organization) — mirrors UsersService.findAll's
   * team-scoping rule.
   */
  private async resolveAssignee(actor: AuthenticatedUser, assignedToId?: string): Promise<string> {
    if (!assignedToId || assignedToId === actor.userId) {
      return actor.userId;
    }

    const isPrivileged = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);
    if (!isPrivileged && actor.role !== Role.MANAGER) {
      throw new ForbiddenException('You do not have permission to assign tasks to other users');
    }

    const target = await this.prisma.user.findFirst({
      where: {
        id: assignedToId,
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true, managerId: true },
    });

    if (!target) {
      throw new BadRequestException('assignedToId does not reference an active user in your organization');
    }

    if (actor.role === Role.MANAGER && target.managerId !== actor.userId) {
      throw new ForbiddenException('Managers may only assign tasks to their own direct reports');
    }

    return target.id;
  }

  private canManageTask(actor: AuthenticatedUser, task: Task & { user?: { managerId?: string | null } }): boolean {
    if (task.createdById === actor.userId) return true;
    if (([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role)) return true;
    if (actor.role === Role.MANAGER && task.user?.managerId === actor.userId) return true;
    return false;
  }

  private async notifyAssignment(task: Task, actor: AuthenticatedUser, isReassignment: boolean): Promise<void> {
    await this.prisma.notification.create({
      data: {
        orgId: task.orgId,
        userId: task.userId,
        type: NotificationType.TASK_ASSIGNED,
        title: isReassignment ? `Task reassigned to you: ${task.title}` : `New task assigned: ${task.title}`,
        message: `${isReassignment ? 'Reassigned' : 'Assigned'} by ${actor.email}${task.dueAt ? ` — due ${task.dueAt.toLocaleString('en-IN')}` : ''} (priority: ${task.priority})`,
        taskId: task.id,
      },
    });
  }

  private async scheduleReminders(taskId: string, dueAt: Date, offsetsMinutes?: number[]): Promise<void> {
    const offsets = offsetsMinutes && offsetsMinutes.length > 0 ? offsetsMinutes : DEFAULT_REMINDER_OFFSETS_MINUTES;
    const now = new Date();

    const reminders = offsets
      .map((offsetMinutes) => ({
        taskId,
        offsetMinutes,
        remindAt: new Date(dueAt.getTime() - offsetMinutes * 60_000),
      }))
      .filter((r) => r.remindAt.getTime() > now.getTime());

    if (reminders.length > 0) {
      await this.prisma.taskReminder.createMany({ data: reminders });
    }
  }

  private async assertLeadInOrg(actor: AuthenticatedUser, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        orgId: actor.orgId,
        // A Manager can only link their own or their team's leads.
        ...(actor.role === Role.MANAGER ? managerLeadScope(actor.userId) : {}),
      },
    });
    if (!lead) {
      throw new BadRequestException('leadId does not reference a lead in your organization');
    }
  }

  /**
   * Fetches a task, enforcing view access: the assignee, whoever created it,
   * an Admin/Super Admin in the same org, or the assignee's Manager.
   */
  private async getAccessibleTask(actor: AuthenticatedUser, id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { user: { select: { id: true, managerId: true } } },
    });
    if (!task || task.orgId !== actor.orgId) {
      throw new NotFoundException('Task not found');
    }

    const isOwner = task.userId === actor.userId;
    if (!isOwner && !this.canManageTask(actor, task)) {
      throw new ForbiddenException('You do not have permission to view this task');
    }

    return task;
  }
}

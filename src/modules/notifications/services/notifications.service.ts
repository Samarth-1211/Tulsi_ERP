import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

function formatOffset(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes / 1440 > 1 ? 's' : ''}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes / 60 > 1 ? 's' : ''}`;
  return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findMine(actor: AuthenticatedUser, unreadOnly?: boolean) {
    return this.prisma.notification.findMany({
      where: { userId: actor.userId, ...(unreadOnly ? { isRead: false } : {}) },
      include: { task: { select: { id: true, title: true, leadId: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async unreadCount(actor: AuthenticatedUser): Promise<number> {
    return this.prisma.notification.count({ where: { userId: actor.userId, isRead: false } });
  }

  async markRead(actor: AuthenticatedUser, id: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({ where: { id } });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    if (notification.userId !== actor.userId) {
      throw new ForbiddenException('You can only manage your own notifications');
    }
    await this.prisma.notification.update({ where: { id }, data: { isRead: true } });
  }

  async markAllRead(actor: AuthenticatedUser): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId: actor.userId, isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * Runs every 5 minutes: any TaskReminder whose remindAt has passed and
   * hasn't fired yet gets turned into an in-app Notification for the task's
   * owner (skipped if the task was completed/cancelled/deleted since).
   */
  @Cron('*/5 * * * *')
  async fireDueReminders(): Promise<void> {
    const due = await this.prisma.taskReminder.findMany({
      where: { firedAt: null, remindAt: { lte: new Date() }, task: { status: TaskStatus.PENDING } },
      include: { task: true },
    });

    if (due.length === 0) {
      return;
    }

    for (const reminder of due) {
      await this.prisma.$transaction([
        this.prisma.notification.create({
          data: {
            orgId: reminder.task.orgId,
            userId: reminder.task.userId,
            type: NotificationType.TASK_REMINDER,
            title: `Reminder: ${reminder.task.title}`,
            message: reminder.task.dueAt
              ? `Due in ${formatOffset(reminder.offsetMinutes)} (${reminder.task.dueAt.toLocaleString('en-IN')})`
              : `This task is due soon`,
            taskId: reminder.taskId,
          },
        }),
        this.prisma.taskReminder.update({ where: { id: reminder.id }, data: { firedAt: new Date() } }),
      ]);
    }

    this.logger.log(`Fired ${due.length} task reminder(s)`);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { NotificationType, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { MailService, NotificationEmailItem } from '../../mail/mail.service';
import { notificationPath } from '../notification-url.util';

/** How often new notifications are collected and emailed — also the window a burst is grouped in. */
const SWEEP_MS = 60_000;
const BATCH_SIZE = 500;
/** Older than this when dispatched (e.g. after downtime): marked, not emailed. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Updates listed in one digest; the rest are counted. */
const MAX_ITEMS_PER_EMAIL = 10;

/** Chip shown on each update in the email. */
const TYPE_LABELS: Record<NotificationType, string> = {
  [NotificationType.LEAD_ASSIGNED]: 'Lead allotted',
  [NotificationType.TASK_ASSIGNED]: 'Task assigned',
  [NotificationType.TASK_REMINDER]: 'Task reminder',
  [NotificationType.TASK_ALLOTTED]: 'Follow-up list',
  [NotificationType.TRIP_SHARED]: 'Trip shared',
  [NotificationType.LEAD_CAPTURED]: 'New lead',
  [NotificationType.LEAD_UPDATED]: 'Lead updated',
  [NotificationType.LEAD_DELETED]: 'Lead deleted',
  [NotificationType.GENERIC]: 'Update',
};

/** Same as the OrgSettings.emailNotificationTypes column default. */
export const DEFAULT_EMAIL_NOTIFICATION_TYPES: NotificationType[] = [
  NotificationType.LEAD_ASSIGNED,
  NotificationType.TASK_ASSIGNED,
  NotificationType.TASK_REMINDER,
  NotificationType.TASK_ALLOTTED,
  NotificationType.TRIP_SHARED,
];

interface ClaimedNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  leadId: string | null;
  taskId: string | null;
  createdAt: Date;
}

/**
 * Emails in-app notifications to the user — lead allotted, task assigned,
 * task reminder, follow-up list ready, and whatever else the org's Admin
 * ticks (OrgSettings.emailNotificationTypes). Users can switch it off for
 * themselves (User.emailNotifications).
 *
 * Like PushService, nothing that writes a Notification has to know about
 * this: every minute a sweep claims undispatched rows (FOR UPDATE SKIP
 * LOCKED, so several instances never email twice) and sends one email per
 * user — a digest when several updates landed in the same minute.
 */
@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  // ─────────── Preferences ───────────

  async getMyPreference(actor: AuthenticatedUser) {
    const [user, settings] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: actor.userId }, select: { emailNotifications: true, email: true } }),
      actor.orgId ? this.prisma.orgSettings.findUnique({ where: { orgId: actor.orgId }, select: { emailNotificationTypes: true } }) : null,
    ]);
    return {
      enabled: user?.emailNotifications ?? true,
      email: user?.email ?? null,
      types: settings?.emailNotificationTypes ?? DEFAULT_EMAIL_NOTIFICATION_TYPES,
      emailConfigured: this.mail.isConfigured,
    };
  }

  async setMyPreference(actor: AuthenticatedUser, enabled: boolean) {
    await this.prisma.user.update({ where: { id: actor.userId }, data: { emailNotifications: enabled } });
    return this.getMyPreference(actor);
  }

  async getOrgSettings(actor: AuthenticatedUser) {
    const row = await this.prisma.orgSettings.upsert({
      where: { orgId: actor.orgId },
      create: { orgId: actor.orgId },
      update: {},
      select: { emailNotificationTypes: true, updatedAt: true },
    });
    return { ...row, availableTypes: Object.keys(TYPE_LABELS), emailConfigured: this.mail.isConfigured };
  }

  async updateOrgSettings(actor: AuthenticatedUser, types: NotificationType[]) {
    const emailNotificationTypes = [...new Set(types)];
    await this.prisma.orgSettings.upsert({
      where: { orgId: actor.orgId },
      create: { orgId: actor.orgId, emailNotificationTypes },
      update: { emailNotificationTypes },
    });
    return this.getOrgSettings(actor);
  }

  // ─────────── Dispatch ───────────

  @Interval(SWEEP_MS)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let claimed: ClaimedNotification[];
      do {
        claimed = await this.claimBatch();
        if (claimed.length > 0) await this.deliver(claimed);
      } while (claimed.length === BATCH_SIZE);
    } catch (error) {
      this.logger.warn(`Email notification dispatch failed: ${error}`);
    } finally {
      this.running = false;
    }
  }

  /** Marks the next batch of un-emailed notifications as dispatched and returns them. */
  private claimBatch(): Promise<ClaimedNotification[]> {
    return this.prisma.$queryRaw<ClaimedNotification[]>(Prisma.sql`
      UPDATE "notifications" SET "emailedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "notifications"
        WHERE "emailedAt" IS NULL
        ORDER BY "createdAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "userId", "type", "title", "message", "leadId", "taskId", "createdAt"
    `);
  }

  private async deliver(notifications: ClaimedNotification[]): Promise<void> {
    // Without SMTP the rows are just marked — the startup warning already says why.
    if (!this.mail.isConfigured) return;

    const fresh = notifications.filter((n) => Date.now() - new Date(n.createdAt).getTime() < STALE_AFTER_MS);
    if (fresh.length === 0) return;

    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(fresh.map((n) => n.userId))] },
        deletedAt: null,
        status: UserStatus.ACTIVE,
        isVerified: true,
        emailNotifications: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        org: { select: { name: true, settings: { select: { emailNotificationTypes: true } } } },
      },
    });

    // One at a time: a burst shouldn't open dozens of SMTP connections.
    for (const user of users) {
      if (!user.org) continue;
      const allowed = user.org.settings?.emailNotificationTypes ?? DEFAULT_EMAIL_NOTIFICATION_TYPES;
      const mine = fresh
        .filter((n) => n.userId === user.id && allowed.includes(n.type))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      if (mine.length === 0) continue;

      const items: NotificationEmailItem[] = mine.slice(0, MAX_ITEMS_PER_EMAIL).map((n) => ({
        label: TYPE_LABELS[n.type],
        title: n.title,
        message: n.message,
        url: this.appUrl(notificationPath(n)),
      }));
      const status = await this.mail.attempt(() =>
        this.mail.sendNotificationDigest({
          to: user.email,
          name: user.name,
          orgName: user.org!.name,
          items,
          moreCount: mine.length - items.length,
          allUrl: this.appUrl('/notifications'),
        }),
      );
      if (!status.sent) this.logger.warn(`Update email to user ${user.id} not sent: ${status.error}`);
    }
  }

  /** Absolute frontend link (last CORS_ORIGINS entry is the frontend, as in VerificationService). */
  private appUrl(path: string): string {
    const origins = (this.config.get<string>('CORS_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    return `${(origins[origins.length - 1] ?? '').replace(/\/$/, '')}${path}`;
  }
}

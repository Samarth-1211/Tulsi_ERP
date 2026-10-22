import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { NotificationType, Prisma } from '@prisma/client';
import * as webPush from 'web-push';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { PushSubscriptionDto } from '../dto/push-subscription.dto';
import { notificationPath } from '../notification-url.util';

/** Notifications older than this when dispatched are only marked, not pushed — a device alert that late is noise. */
const STALE_AFTER_MS = 30 * 60 * 1000;
/** How many notifications one dispatch pass claims. */
const BATCH_SIZE = 200;
/** Delay between a notification being written and the dispatch pass, so a burst (e.g. createMany) goes out in one pass. */
const DISPATCH_DEBOUNCE_MS = 300;

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
 * Delivers in-app notifications to the user's devices as real OS
 * notifications (phone notification bar / desktop toast) via the Web Push
 * API — they arrive even when the CRM tab is closed.
 *
 * Nothing that writes a Notification has to know about this: a Prisma
 * middleware kicks off a dispatch pass whenever notifications are created,
 * and a sweep every few seconds catches anything the middleware ran ahead
 * of (rows written inside a transaction that hadn't committed yet). Each
 * pass claims undispatched rows with FOR UPDATE SKIP LOCKED, so several
 * backend instances never push the same notification twice.
 *
 * Disabled (with one warning at startup) when VAPID keys aren't configured;
 * the in-app bell is unaffected.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private readonly publicKey: string | null;
  private readonly enabled: boolean;
  private dispatchTimer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private dispatchAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    const fromEmail = config.get<string>('SMTP_FROM_EMAIL')?.trim();
    const subject =
      config.get<string>('VAPID_SUBJECT')?.trim() || (fromEmail ? `mailto:${fromEmail}` : 'mailto:admin@localhost');

    if (publicKey && privateKey) {
      try {
        webPush.setVapidDetails(subject, publicKey, privateKey);
        this.publicKey = publicKey;
        this.enabled = true;
        return;
      } catch (error) {
        this.logger.error(`Invalid VAPID configuration — push notifications disabled: ${error}`);
      }
    } else {
      this.logger.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled');
    }
    this.publicKey = null;
    this.enabled = false;
  }

  onModuleInit(): void {
    this.prisma.$use(async (params, next) => {
      const result = await next(params);
      if (params.model === 'Notification' && (params.action === 'create' || params.action === 'createMany')) {
        this.scheduleDispatch();
      }
      return result;
    });
  }

  /** The VAPID public key browsers subscribe with, or null when push is off on this server. */
  getPublicKey(): { publicKey: string | null } {
    return { publicKey: this.publicKey };
  }

  /** Saves (or moves to this user) the browser's subscription — the same endpoint can't belong to two people. */
  async subscribe(actor: AuthenticatedUser, dto: PushSubscriptionDto, userAgent?: string): Promise<{ subscribed: true }> {
    const data = {
      userId: actor.userId,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: userAgent?.slice(0, 500) ?? null,
    };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { endpoint: dto.endpoint, ...data },
      update: data,
    });
    return { subscribed: true };
  }

  async unsubscribe(actor: AuthenticatedUser, endpoint: string): Promise<{ subscribed: false }> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId: actor.userId } });
    return { subscribed: false };
  }

  /** Sends a test alert to every device the caller has turned push on for. */
  async sendTest(actor: AuthenticatedUser): Promise<{ devices: number }> {
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId: actor.userId } });
    await Promise.all(
      subscriptions.map((sub) =>
        this.send(sub, {
          title: 'Notifications are on',
          body: 'New leads, assignments and reminders will show up here.',
          url: '/dashboard',
          tag: `test-${Date.now()}`,
        }),
      ),
    );
    return { devices: subscriptions.length };
  }

  @Interval(10_000)
  sweep(): void {
    this.scheduleDispatch(0);
  }

  private scheduleDispatch(delay = DISPATCH_DEBOUNCE_MS): void {
    if (this.dispatchTimer) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      void this.dispatch();
    }, delay);
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) {
      this.dispatchAgain = true;
      return;
    }
    this.dispatching = true;
    try {
      let claimed: ClaimedNotification[];
      do {
        claimed = await this.claimBatch();
        if (claimed.length > 0) await this.deliver(claimed);
      } while (claimed.length === BATCH_SIZE);
    } catch (error) {
      this.logger.warn(`Push dispatch failed: ${error}`);
    } finally {
      this.dispatching = false;
      if (this.dispatchAgain) {
        this.dispatchAgain = false;
        this.scheduleDispatch(0);
      }
    }
  }

  /** Marks the next batch of undispatched notifications as dispatched and returns them. */
  private claimBatch(): Promise<ClaimedNotification[]> {
    return this.prisma.$queryRaw<ClaimedNotification[]>(Prisma.sql`
      UPDATE "notifications" SET "pushedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "notifications"
        WHERE "pushedAt" IS NULL
        ORDER BY "createdAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "userId", "type", "title", "message", "leadId", "taskId", "createdAt"
    `);
  }

  private async deliver(notifications: ClaimedNotification[]): Promise<void> {
    if (!this.enabled) return;

    const fresh = notifications.filter((n) => Date.now() - new Date(n.createdAt).getTime() < STALE_AFTER_MS);
    if (fresh.length === 0) return;

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId: { in: [...new Set(fresh.map((n) => n.userId))] } },
    });
    if (subscriptions.length === 0) return;

    const byUser = new Map<string, typeof subscriptions>();
    for (const sub of subscriptions) byUser.set(sub.userId, [...(byUser.get(sub.userId) ?? []), sub]);

    const unreadByUser = new Map(
      (
        await this.prisma.notification.groupBy({
          by: ['userId'],
          where: { userId: { in: [...byUser.keys()] }, isRead: false },
          _count: { _all: true },
        })
      ).map((row) => [row.userId, row._count._all]),
    );

    await Promise.all(
      fresh.flatMap((n) =>
        (byUser.get(n.userId) ?? []).map((sub) =>
          this.send(sub, {
            title: n.title,
            body: n.message,
            url: notificationPath(n),
            tag: n.id,
            notificationId: n.id,
            unreadCount: unreadByUser.get(n.userId) ?? 0,
          }),
        ),
      ),
    );
  }

  private async send(
    sub: { id: string; endpoint: string; p256dh: string; auth: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: 'high' },
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      // 404/410: the browser unsubscribed or the subscription expired — forget it.
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
      } else {
        this.logger.warn(`Push to subscription ${sub.id} failed (${statusCode ?? 'no status'}): ${error}`);
      }
    }
  }
}

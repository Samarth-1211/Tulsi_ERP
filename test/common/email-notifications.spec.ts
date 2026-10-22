import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationType } from '@prisma/client';
import { EmailNotificationService } from '../../src/modules/notifications/services/email-notification.service';

type Row = Record<string, any>;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const note = (id: string, userId: string, type: NotificationType, o: Row = {}) => ({
  id,
  userId,
  type,
  title: `title ${id}`,
  message: `message ${id}`,
  leadId: null,
  taskId: null,
  createdAt: minutesAgo(1),
  ...o,
});

const ORG = { name: 'Tulsi Plywood', settings: null };
const USERS = [
  { id: 'caller', name: 'Amit', email: 'amit@test.dev', emailNotifications: true, org: ORG },
  { id: 'manager', name: 'Priya', email: 'priya@test.dev', emailNotifications: true, org: ORG },
  { id: 'opted-out', name: 'Neha', email: 'neha@test.dev', emailNotifications: false, org: ORG },
];

function setup(rows: Row[], { configured = true } = {}) {
  const sent: Row[] = [];
  let claims = 0;
  const prisma = {
    $queryRaw: async () => (claims++ === 0 ? rows : []),
    user: {
      // Mirrors the service's where: only users who keep emails on.
      findMany: async ({ where }: Row) =>
        USERS.filter((u) => where.id.in.includes(u.id) && u.emailNotifications === where.emailNotifications),
    },
  };
  const mail = {
    isConfigured: configured,
    attempt: async (fn: () => Promise<void>) => (await fn(), { sent: true }),
    sendNotificationDigest: async (params: Row) => void sent.push(params),
  };
  const config = { get: (key: string) => (key === 'CORS_ORIGINS' ? 'http://localhost:3000,https://erp.example.com/' : undefined) };
  const service = new EmailNotificationService(prisma as never, mail as never, config as never);
  return { service, sent };
}

describe('Email notifications', () => {
  it('emails a single update with a link to the record', async () => {
    const { service, sent } = setup([note('n1', 'caller', NotificationType.LEAD_ASSIGNED, { leadId: 'lead-9' })]);
    await service.sweep();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'amit@test.dev');
    assert.equal(sent[0].items[0].url, 'https://erp.example.com/leads/lead-9');
    assert.equal(sent[0].items[0].label, 'Lead allotted');
  });

  it('groups a burst into one digest per user, newest first', async () => {
    const { service, sent } = setup([
      note('old', 'caller', NotificationType.LEAD_ASSIGNED, { createdAt: minutesAgo(3) }),
      note('new', 'caller', NotificationType.TASK_REMINDER, { createdAt: minutesAgo(1), taskId: 't1' }),
      note('m1', 'manager', NotificationType.TASK_ASSIGNED),
    ]);
    await service.sweep();
    assert.equal(sent.length, 2);
    const caller = sent.find((s) => s.to === 'amit@test.dev')!;
    assert.deepEqual(caller.items.map((i: Row) => i.title), ['title new', 'title old']);
  });

  it('only emails the types the org picked (default: allotments, tasks, reminders)', async () => {
    const { service, sent } = setup([note('cap', 'manager', NotificationType.LEAD_CAPTURED), note('upd', 'manager', NotificationType.LEAD_UPDATED)]);
    await service.sweep();
    assert.equal(sent.length, 0);
  });

  it('skips users who turned emails off, stale updates, and everything when SMTP is missing', async () => {
    const optedOut = setup([note('x', 'opted-out', NotificationType.LEAD_ASSIGNED)]);
    await optedOut.service.sweep();
    assert.equal(optedOut.sent.length, 0);

    const stale = setup([note('y', 'caller', NotificationType.LEAD_ASSIGNED, { createdAt: minutesAgo(7 * 60) })]);
    await stale.service.sweep();
    assert.equal(stale.sent.length, 0);

    const noSmtp = setup([note('z', 'caller', NotificationType.LEAD_ASSIGNED)], { configured: false });
    await noSmtp.service.sweep();
    assert.equal(noSmtp.sent.length, 0);
  });

  it('caps a digest at 10 updates and counts the rest', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => note(`n${i}`, 'caller', NotificationType.LEAD_ASSIGNED));
    const { service, sent } = setup(rows);
    await service.sweep();
    assert.equal(sent[0].items.length, 10);
    assert.equal(sent[0].moreCount, 4);
  });
});

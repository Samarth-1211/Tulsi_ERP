import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationType, Role, UserStatus } from '@prisma/client';
import { LeadNotificationsService } from '../../src/modules/lead-ingestion/services/lead-notifications.service';

interface FakeUser {
  id: string;
  name: string;
  role: Role;
  managerId: string | null;
  status: UserStatus;
  deletedAt: Date | null;
  orgId: string;
}

const user = (id: string, role: Role, managerId: string | null = null, status: UserStatus = UserStatus.ACTIVE): FakeUser => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  role,
  managerId,
  status,
  deletedAt: null,
  orgId: 'org-1',
});

function setup(users: FakeUser[]) {
  const sent: { userId: string; type: NotificationType; title: string; message: string }[] = [];
  const prisma = {
    user: {
      findMany: async ({ where }: { where: Record<string, any> }) =>
        users.filter(
          (u) =>
            (!where.id?.in || where.id.in.includes(u.id)) &&
            (!where.role || u.role === where.role) &&
            (!where.status || u.status === where.status) &&
            (!where.orgId || u.orgId === where.orgId) &&
            (where.deletedAt === undefined || u.deletedAt === where.deletedAt),
        ),
    },
    notification: { createMany: async ({ data }: { data: typeof sent }) => void sent.push(...data) },
  };
  const service = new LeadNotificationsService(prisma as never);
  const to = (id: string) => sent.filter((n) => n.userId === id);
  return { service, sent, to };
}

describe('Google Sheet bulk sync notifications (RBAC)', () => {
  // Admin oversees everything; Manager Meera leads callers Chetan and Chitra; Kiran is a caller with no manager.
  const users = [
    user('anita', Role.ADMIN),
    user('olddmin', Role.ADMIN, null, UserStatus.INACTIVE),
    user('meera', Role.MANAGER),
    user('chetan', Role.CALLER, 'meera'),
    user('chitra', Role.CALLER, 'meera'),
    user('kiran', Role.CALLER),
  ];
  const summary = {
    orgId: 'org-1',
    sheetName: 'Meta leads',
    created: ['chetan', 'chetan', 'chetan', 'chitra', 'chitra', 'meera', null],
    reEnquired: ['chetan', 'kiran'],
  };

  it('tells each assignee only about their own leads', async () => {
    const { service, to } = setup(users);
    await service.notifyBulkSheetSync(summary);
    assert.deepEqual(to('chetan').map((n) => [n.type, n.title, n.message]), [
      [NotificationType.LEAD_ASSIGNED, '3 new leads assigned to you', 'From the Google Sheet "Meta leads" — and one of your leads enquired again.'],
    ]);
    assert.deepEqual(to('chitra').map((n) => n.title), ['2 new leads assigned to you']);
    assert.deepEqual(to('kiran').map((n) => [n.type, n.title]), [[NotificationType.GENERIC, 'One of your leads enquired again']]);
    // A caller never hears about a colleague's leads.
    assert.doesNotMatch(JSON.stringify(to('chitra')), /Chetan|Kiran|Meera/);
  });

  it('tells a Manager about their own leads and their team members’ leads', async () => {
    const { service, to } = setup(users);
    await service.notifyBulkSheetSync(summary);
    assert.deepEqual(to('meera').map((n) => [n.type, n.title, n.message]), [
      [NotificationType.LEAD_ASSIGNED, '1 new lead assigned to you', 'From the Google Sheet "Meta leads".'],
      [NotificationType.LEAD_CAPTURED, '5 new leads went to your team', 'From the Google Sheet "Meta leads" — Chetan: 3, Chitra: 2.'],
    ]);
    assert.doesNotMatch(JSON.stringify(to('meera')), /Kiran/); // not in her team
  });

  it('gives active Admins the whole picture, flagging leads nobody got', async () => {
    const { service, to } = setup(users);
    await service.notifyBulkSheetSync(summary);
    assert.deepEqual(to('anita').map((n) => [n.type, n.title, n.message]), [
      [
        NotificationType.LEAD_CAPTURED,
        'Action needed — 7 new leads from Google Sheet "Meta leads"',
        'assigned — Chetan 3, Chitra 2, Meera 1; 1 not assigned yet, needs allocation; 2 existing leads enquired again.',
      ],
    ]);
    assert.equal(to('olddmin').length, 0);
  });

  it('sends one notification per person, and nothing when nothing came in', async () => {
    const { service, sent } = setup(users);
    await service.notifyBulkSheetSync(summary);
    assert.equal(sent.length, 6); // chetan, chitra, meera ×2, kiran, anita
    const empty = setup(users);
    await empty.service.notifyBulkSheetSync({ ...summary, created: [], reEnquired: [] });
    assert.equal(empty.sent.length, 0);
  });
});

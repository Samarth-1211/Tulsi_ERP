import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../../src/common/decorators/current-user.decorator';
import { LeadsService } from '../../src/modules/lead-ingestion/services/leads.service';
import { WhatsAppMessagingService } from '../../src/modules/whatsapp-integration/services/whatsapp-messaging.service';

type Row = Record<string, any>;

const actor = (userId: string, role: Role, orgId = 'org-1'): AuthenticatedUser => ({
  userId,
  role,
  orgId,
  email: `${userId}@test.dev`,
});

const ADMIN = actor('admin-1', Role.ADMIN);
const SUPER_ADMIN = actor('super-1', Role.SUPER_ADMIN);
const MANAGER_A = actor('mgr-a', Role.MANAGER);
const MANAGER_B = actor('mgr-b', Role.MANAGER);
const AGENT_A1 = actor('agent-a1', Role.CALLER);
const PRESALES_A2 = actor('presales-a2', Role.CALLER);
const POSTSALES_B1 = actor('postsales-b1', Role.CALLER);

const USERS: Row[] = [
  { id: 'mgr-a', managerId: null },
  { id: 'mgr-b', managerId: null },
  { id: 'agent-a1', managerId: 'mgr-a' },
  { id: 'presales-a2', managerId: 'mgr-a' },
  { id: 'postsales-b1', managerId: 'mgr-b' },
];

// `chat: false` — a lead nobody has messaged on WhatsApp.
const LEADS: Row[] = [
  { id: 'lead-a1', orgId: 'org-1', assignedToId: 'agent-a1', chat: true },
  { id: 'lead-a2', orgId: 'org-1', assignedToId: 'presales-a2', chat: true },
  { id: 'lead-mgr-a', orgId: 'org-1', assignedToId: 'mgr-a', chat: true },
  { id: 'lead-b1', orgId: 'org-1', assignedToId: 'postsales-b1', chat: true },
  { id: 'lead-unassigned', orgId: 'org-1', assignedToId: null, chat: true },
  { id: 'lead-a1-no-chat', orgId: 'org-1', assignedToId: 'agent-a1', chat: false },
  { id: 'lead-other-org', orgId: 'org-2', assignedToId: 'someone-else', chat: true },
];

/** Evaluates the lead filters these services build (see lead-scope.util) against a row. */
function leadMatches(lead: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some((w) => leadMatches(lead, w));
    if (key === 'whatsappMessages') return lead.chat;
    if (key === 'assignedTo') return !!lead.assignedTo && lead.assignedTo.managerId === value.managerId;
    return lead[key] === value;
  });
}

function setup() {
  const leads: Row[] = LEADS.map((l) => ({
    ...l,
    name: l.id,
    deletedAt: null,
    phone: '+919800000000',
    status: 'ASSIGNED',
    source: 'WHATSAPP_ORGANIC',
    assignedTo: USERS.find((u) => u.id === l.assignedToId) ?? null,
    whatsappMessages: l.chat ? [{ id: `msg-${l.id}`, createdAt: new Date() }] : [],
    activityLogs: [],
  }));

  const prisma = {
    lead: {
      findMany: async ({ where }: { where: Row }) => leads.filter((l) => leadMatches(l, where)),
      findFirst: async ({ where }: { where: Row }) => leads.find((l) => leadMatches(l, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => leads.find((l) => l.id === where.id) ?? null,
    },
    whatsAppMessage: { findMany: async () => [], findFirst: async () => null },
    $queryRaw: async () => [],
  };

  return {
    messaging: new WhatsAppMessagingService(prisma as never, {} as never, {} as never, {} as never),
    leads: new LeadsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never),
  };
}

async function inboxIds(user: AuthenticatedUser) {
  const inbox = await setup().messaging.listInbox(user);
  return inbox.map((item) => item.id).sort();
}

describe('who sees which chats in the WhatsApp inbox', () => {
  it('shows an individual contributor only the chats of leads assigned to them', async () => {
    assert.deepEqual(await inboxIds(AGENT_A1), ['lead-a1']);
    assert.deepEqual(await inboxIds(PRESALES_A2), ['lead-a2']);
    assert.deepEqual(await inboxIds(POSTSALES_B1), ['lead-b1']);
  });

  it("shows a Manager their own chats and their direct team's, not another team's or unassigned ones", async () => {
    assert.deepEqual(await inboxIds(MANAGER_A), ['lead-a1', 'lead-a2', 'lead-mgr-a']);
    assert.deepEqual(await inboxIds(MANAGER_B), ['lead-b1']);
  });

  it("shows an Admin or Super Admin every chat in their organization, and none of another organization's", async () => {
    const all = ['lead-a1', 'lead-a2', 'lead-b1', 'lead-mgr-a', 'lead-unassigned'];
    assert.deepEqual(await inboxIds(ADMIN), all);
    assert.deepEqual(await inboxIds(SUPER_ADMIN), all);
  });
});

describe('opening a WhatsApp thread directly by lead id', () => {
  it("refuses a colleague's chat, another team's chat and an unassigned chat", async () => {
    const { messaging } = setup();
    await assert.rejects(messaging.listMessages(AGENT_A1, 'lead-a2'), ForbiddenException);
    await assert.rejects(messaging.listMessages(AGENT_A1, 'lead-unassigned'), ForbiddenException);
    await assert.rejects(messaging.listMessages(MANAGER_A, 'lead-b1'), ForbiddenException);
    await assert.rejects(messaging.markRead(POSTSALES_B1, 'lead-a1'), ForbiddenException);
  });

  it("hides another organization's lead entirely", async () => {
    await assert.rejects(setup().messaging.listMessages(ADMIN, 'lead-other-org'), NotFoundException);
  });

  it('allows the assignee, their Manager and an Admin', async () => {
    const { messaging } = setup();
    for (const user of [AGENT_A1, MANAGER_A, ADMIN]) {
      const thread = await messaging.listMessages(user, 'lead-a1');
      assert.equal(thread.lead.id, 'lead-a1');
    }
  });
});

describe('opening a lead by id', () => {
  it("hides leads outside the caller's scope", async () => {
    const { leads } = setup();
    await assert.rejects(leads.findOne(AGENT_A1, 'lead-a2'), NotFoundException);
    await assert.rejects(leads.findOne(AGENT_A1, 'lead-unassigned'), NotFoundException);
    await assert.rejects(leads.findOne(MANAGER_A, 'lead-b1'), NotFoundException);
    await assert.rejects(leads.findOne(ADMIN, 'lead-other-org'), NotFoundException);
  });

  it('returns leads inside it', async () => {
    const { leads } = setup();
    assert.equal((await leads.findOne(AGENT_A1, 'lead-a1')).id, 'lead-a1');
    assert.equal((await leads.findOne(MANAGER_A, 'lead-a2')).id, 'lead-a2');
    assert.equal((await leads.findOne(ADMIN, 'lead-unassigned')).id, 'lead-unassigned');
  });
});

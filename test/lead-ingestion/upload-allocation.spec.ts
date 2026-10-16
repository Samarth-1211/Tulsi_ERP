import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { LeadAllocationService, QuotaSplitter, UploadManagerPick, UploadQuota } from '../../src/modules/lead-ingestion/services/lead-allocation.service';
import { LeadImportService } from '../../src/modules/lead-ingestion/services/lead-import.service';
import { LeadNotificationsService } from '../../src/modules/lead-ingestion/services/lead-notifications.service';
import { ImportLeadsDto } from '../../src/modules/lead-ingestion/dto/import-leads.dto';

type Row = Record<string, any>;

const person = (id: string, role: string, managerId: string | null = null, extra: Row = {}): Row => ({
  id,
  orgId: 'org-1',
  role,
  managerId,
  name: id,
  status: 'ACTIVE',
  deletedAt: null,
  ...extra,
});

// Two teams of different sizes, a manager with no team, and people who must never be picked.
const USERS: Row[] = [
  person('m-a', 'MANAGER'),
  person('m-b', 'MANAGER'),
  person('m-c', 'MANAGER'),
  person('m-gone', 'MANAGER', null, { status: 'INACTIVE' }),
  person('m-other-org', 'MANAGER', null, { orgId: 'org-2' }),
  person('a1', 'CALLER', 'm-a'),
  person('a2', 'CALLER', 'm-a'),
  person('a3', 'CALLER', 'm-a'),
  person('b1', 'CALLER', 'm-b'),
  person('b-driver', 'DELIVERY_PARTNER', 'm-b'),
  person('admin', 'ADMIN'),
];

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Row[]).some((clause) => matches(row, clause));
    if (expected && typeof expected === 'object') {
      if ('in' in expected) return expected.in.includes(row[key]);
      if ('not' in expected) return row[key] !== expected.not;
    }
    return row[key] === expected;
  });
}

/** Just enough of PrismaService for splitting an upload, checking the picked managers and notifying. */
class FakePrisma {
  notifications: Row[] = [];

  constructor(
    private readonly absent: string[] = [],
    private readonly uploadedSoFar: Record<string, number> = {},
  ) {}

  user = {
    findMany: async ({ where }: { where: Row }) =>
      USERS.filter((u) => matches(u, where))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((u) => {
          const manager = USERS.find((m) => m.id === u.managerId);
          return { ...u, manager: manager ? { name: manager.name } : null };
        }),
  };
  // `absent` = on approved leave today — the only thing that keeps someone out of a split.
  leaveRequest = {
    findMany: async ({ where }: { where: Row }) =>
      this.absent.filter((id) => where.userId.in.includes(id)).map((userId) => ({ userId })),
  };
  lead = {
    groupBy: async ({ where }: { where: Row }) =>
      Object.entries(this.uploadedSoFar)
        .filter(([id]) => where.assignedToId.in.includes(id))
        .map(([assignedToId, count]) => ({ assignedToId, _count: { _all: count } })),
  };
  notification = {
    createMany: async ({ data }: { data: Row[] }) => {
      this.notifications.push(...data);
    },
  };
}

/** Who got how many of `leads` uploaded leads. */
async function share(leads: number, managers?: UploadManagerPick, prisma = new FakePrisma()) {
  const splitter = await new LeadAllocationService(prisma as never).createTeamSplitter('org-1', managers);
  const tally: Record<string, number> = {};
  for (let i = 0; i < leads; i++) {
    const assignee = splitter.next();
    if (!assignee) break;
    tally[assignee.userId] = (tally[assignee.userId] ?? 0) + 1;
  }
  return tally;
}

describe('sharing an uploaded sheet', () => {
  it("goes to every manager's caller team when no managers are picked — never to the managers", async () => {
    assert.deepEqual(await share(12), { a1: 2, a2: 2, a3: 2, b1: 6 });
  });

  it('gives each picked manager an equal share and nobody else anything, when kept to the managers', async () => {
    assert.deepEqual(await share(9, { ids: ['m-a', 'm-b', 'm-c'], withTeams: false }), { 'm-a': 3, 'm-b': 3, 'm-c': 3 });
  });

  it("spreads each picked manager's equal share across the manager and their callers", async () => {
    assert.deepEqual(await share(24, { ids: ['m-a', 'm-b'], withTeams: true }), {
      'm-a': 3,
      a1: 3,
      a2: 3,
      a3: 3,
      'm-b': 6,
      b1: 6,
    });
  });

  it('leaves a picked manager with no team to take their whole share themselves', async () => {
    assert.deepEqual(await share(8, { ids: ['m-b', 'm-c'], withTeams: true }), { 'm-b': 2, b1: 2, 'm-c': 4 });
  });

  it('skips whoever is on leave today — the rest of their team still takes its share', async () => {
    const absent = () => new FakePrisma(['m-a', 'm-c']);
    assert.deepEqual(await share(6, { ids: ['m-a', 'm-b', 'm-c'], withTeams: false }, absent()), { 'm-b': 6 });
    assert.deepEqual(await share(12, { ids: ['m-a', 'm-b'], withTeams: true }, absent()), {
      a1: 2,
      a2: 2,
      a3: 2,
      'm-b': 3,
      b1: 3,
    });
  });

  it('hands out nothing when none of the picked managers is available', async () => {
    assert.deepEqual(await share(5, { ids: ['m-a'], withTeams: false }, new FakePrisma(['m-a'])), {});
  });

  it('starts with whoever has had the fewest uploaded leads so far', async () => {
    const prisma = new FakePrisma([], { 'm-a': 10 });
    assert.deepEqual(await share(1, { ids: ['m-a', 'm-b'], withTeams: false }, prisma), { 'm-b': 1 });
  });
});

describe('who an upload may be shared with', () => {
  const ADMIN = { userId: 'admin', orgId: 'org-1', role: 'ADMIN' };
  const MANAGER = { userId: 'm-a', orgId: 'org-1', role: 'MANAGER' };
  const service = new LeadImportService(new FakePrisma() as never, null as never, null as never, null as never, null as never, null as never);
  const resolve = async (actor: Row, request: Row) => {
    const { mode, managers } = await (service as any).resolveAllocation(actor, request);
    return { mode, managerIds: managers.map((m: Row) => m.id) };
  };

  it('lets an Admin and a Manager alike send a sheet to every team', async () => {
    for (const actor of [ADMIN, MANAGER]) {
      assert.deepEqual(await resolve(actor, { allocationMode: 'ALL_TEAMS' }), { mode: 'ALL_TEAMS', managerIds: [] });
    }
  });

  it('takes the picked managers as given — a Manager may leave themselves out', async () => {
    assert.deepEqual(await resolve(ADMIN, { allocationMode: 'MANAGERS_ONLY', managerIds: ['m-b', 'm-a', 'm-b'] }), {
      mode: 'MANAGERS_ONLY',
      managerIds: ['m-a', 'm-b'],
    });
    assert.deepEqual(await resolve(MANAGER, { allocationMode: 'MANAGERS_AND_TEAMS', managerIds: ['m-c'] }), {
      mode: 'MANAGERS_AND_TEAMS',
      managerIds: ['m-c'],
    });
  });

  it('treats an older client as before: every team for an Admin, own team plus collaborators for a Manager', async () => {
    assert.deepEqual(await resolve(ADMIN, {}), { mode: 'ALL_TEAMS', managerIds: [] });
    assert.deepEqual(await resolve(MANAGER, {}), { mode: 'MANAGERS_AND_TEAMS', managerIds: ['m-a'] });
    assert.deepEqual(await resolve(MANAGER, { collaboratorIds: ['m-b'] }), {
      mode: 'MANAGERS_AND_TEAMS',
      managerIds: ['m-a', 'm-b'],
    });
  });

  it('rejects a choice that does not add up', async () => {
    const rejected = (actor: Row, request: Row, message: RegExp) =>
      assert.rejects(resolve(actor, request), (error: unknown) => error instanceof BadRequestException && message.test(error.message));

    await rejected(ADMIN, { allocationMode: 'MANAGERS_ONLY' }, /Pick at least one manager/);
    await rejected(ADMIN, { allocationMode: 'MANAGERS_ONLY', managerIds: [] }, /Pick at least one manager/);
    await rejected(ADMIN, { allocationMode: 'ALL_TEAMS', managerIds: ['m-a'] }, /goes to every team/);
    await rejected(ADMIN, { collaboratorIds: ['m-a'] }, /goes to every team/);
    await rejected(MANAGER, { allocationMode: 'MANAGERS_ONLY', collaboratorIds: ['m-b'] }, /can’t be combined/);
    for (const id of ['m-gone', 'm-other-org', 'a1', 'admin', 'nobody']) {
      await rejected(ADMIN, { allocationMode: 'MANAGERS_AND_TEAMS', managerIds: ['m-a', id] }, /aren’t active managers/);
    }
  });
});

describe('the upload form fields', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const parse = (body: Row): Promise<ImportLeadsDto> => pipe.transform(body, { type: 'body', metatype: ImportLeadsDto });

  it('reads the picked managers however the form sends them', async () => {
    assert.deepEqual({ ...(await parse({})) }, {});
    assert.deepEqual((await parse({ allocationMode: 'MANAGERS_ONLY', managerIds: 'm-a' })).managerIds, ['m-a']);
    assert.deepEqual((await parse({ managerIds: ['m-a', 'm-b'] })).managerIds, ['m-a', 'm-b']);
    assert.deepEqual((await parse({ managerIds: '["m-a","m-b"]' })).managerIds, ['m-a', 'm-b']);
    assert.deepEqual((await parse({ collaboratorIds: 'm-b' })).collaboratorIds, ['m-b']);
  });

  it('rejects an unknown mode or field', async () => {
    await assert.rejects(parse({ allocationMode: 'EVERYONE' }), BadRequestException);
    await assert.rejects(parse({ other: 'x' }), BadRequestException);
  });
});

describe('telling people about an upload', () => {
  const notify = async (summary: Row) => {
    const prisma = new FakePrisma();
    await new LeadNotificationsService(prisma as never).notifyBulkUpload({
      orgId: 'org-1',
      uploader: { id: 'uploader', name: 'Asha Rao', role: 'ADMIN' },
      fileName: 'leads.xlsx',
      ...summary,
    } as never);
    return prisma.notifications.map((n) => ({ to: n.userId, title: n.title, message: n.message }));
  };
  const row = (userId: string, managerId: string, count: number) => ({ userId, name: userId, managerId, managerName: managerId, count });

  it('tells a manager once about their own share, and separately what went to their team members', async () => {
    const sent = await notify({
      allocationMode: 'MANAGERS_AND_TEAMS',
      managerNames: ['m-a', 'm-b'],
      createdCount: 9,
      allocation: [row('m-a', 'm-a', 2), row('a1', 'm-a', 3), row('m-b', 'm-b', 4)],
    });

    assert.deepEqual(
      sent.filter((n) => n.to !== 'admin').map((n) => `${n.to}: ${n.title}`),
      [
        'm-a: 2 new leads assigned to you',
        'a1: 3 new leads assigned to you',
        'm-b: 4 new leads assigned to you',
        'm-a: 3 uploaded leads went to your team',
      ],
    );
    assert.match(sent.find((n) => n.to === 'admin')!.message, /9 shared across 2 teams\. Managers picked: m-a, m-b — with their teams\.$/);
  });

  it('says so when the sheet was kept to the managers', async () => {
    const sent = await notify({
      allocationMode: 'MANAGERS_ONLY',
      managerNames: ['m-a'],
      createdCount: 5,
      allocation: [row('m-a', 'm-a', 5)],
    });

    assert.deepEqual(sent.map((n) => n.to), ['m-a', 'admin']);
    assert.match(sent[1].message, /5 shared across 1 manager\. Managers picked: m-a — managers only\.$/);
  });
});

describe('a custom split', () => {
  const ADMIN = { userId: 'admin', orgId: 'org-1', role: 'ADMIN' };
  const MANAGER = { userId: 'm-a', orgId: 'org-1', role: 'MANAGER' };
  const service = new LeadImportService(new FakePrisma() as never, null as never, null as never, null as never, null as never, null as never);
  const resolve = (actor: Row, customAllocations: unknown, extra: Row = {}) =>
    (service as any).resolveAllocation(actor, {
      allocationMode: 'CUSTOM',
      customAllocations: typeof customAllocations === 'string' ? customAllocations : JSON.stringify(customAllocations),
      ...extra,
    });
  const handOut = (quotas: UploadQuota[], leads: number) => {
    const splitter = new QuotaSplitter(quotas);
    const tally: Record<string, number> = {};
    for (let i = 0; i < leads; i++) {
      const assignee = splitter.next();
      if (!assignee) break;
      tally[assignee.userId] = (tally[assignee.userId] ?? 0) + 1;
    }
    return tally;
  };
  const quota = (userId: string, count: number): UploadQuota => ({
    userId,
    name: userId,
    count,
    team: { managerId: null, managerName: null, members: [] },
  });

  it('gives everyone exactly their number and stops there', () => {
    const quotas = [quota('x', 200), quota('y', 300), quota('z', 1)];
    assert.deepEqual(handOut(quotas, 1000), { x: 200, y: 300, z: 1 });
  });

  it('leaves everyone short in proportion when the sheet runs out early', () => {
    assert.deepEqual(handOut([quota('x', 200), quota('y', 300)], 250), { x: 100, y: 150 });
  });

  it('names each person with the team they belong to, in the order given', async () => {
    const { mode, managers, quotas } = await resolve(ADMIN, [
      { userId: 'b1', count: 300 },
      { userId: 'm-a', count: 200 },
      { userId: 'a1', count: 5 },
    ]);

    assert.equal(mode, 'CUSTOM');
    assert.deepEqual(managers, []);
    assert.deepEqual(
      quotas.map((q: UploadQuota) => [q.userId, q.count, q.team.managerId, q.team.managerName]),
      [
        ['b1', 300, 'm-b', 'm-b'],
        ['m-a', 200, 'm-a', 'm-a'],
        ['a1', 5, 'm-a', 'm-a'],
      ],
    );
  });

  it('lets a Manager name themselves, their own team and other Managers — not another team’s members', async () => {
    const { quotas } = await resolve(MANAGER, [
      { userId: 'm-a', count: 1 },
      { userId: 'a1', count: 2 },
      { userId: 'm-b', count: 3 },
    ]);
    assert.equal(quotas.length, 3);

    await assert.rejects(resolve(MANAGER, [{ userId: 'b1', count: 1 }]), ForbiddenException);
  });

  it('rejects a split that does not add up', async () => {
    const rejected = (allocations: unknown, message: RegExp, extra?: Row) =>
      assert.rejects(resolve(ADMIN, allocations, extra), (error: unknown) => error instanceof BadRequestException && message.test(error.message));

    await rejected('not json', /at least one person/);
    await rejected([], /at least one person/);
    await rejected([{ userId: 'a1', count: 0 }], /whole number of leads/);
    await rejected([{ userId: 'a1', count: 2.5 }], /whole number of leads/);
    await rejected([{ userId: 'a1', count: '5' }], /whole number of leads/);
    await rejected([{ count: 5 }], /whole number of leads/);
    await rejected([{ userId: 'a1', count: 1 }, { userId: 'a1', count: 2 }], /only be listed once/);
    await rejected([{ userId: 'a1', count: 1 }], /not managerIds/, { managerIds: ['m-a'] });
    for (const id of ['admin', 'm-gone', 'm-other-org', 'nobody']) {
      await rejected([{ userId: id, count: 1 }], /aren’t active managers or team members/);
    }
    await assert.rejects(
      (service as any).resolveAllocation(ADMIN, { allocationMode: 'ALL_TEAMS', customAllocations: '[]' }),
      /only goes with the CUSTOM/,
    );
  });
});

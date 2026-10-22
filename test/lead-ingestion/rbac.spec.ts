import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../../src/common/decorators/current-user.decorator';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { LeadsService } from '../../src/modules/lead-ingestion/services/leads.service';
import { LeadAssignmentService } from '../../src/modules/lead-ingestion/services/lead-assignment.service';
import { LeadsController } from '../../src/modules/lead-ingestion/controllers/leads.controller';

type Row = Record<string, any>;

const actor = (userId: string, role: Role): AuthenticatedUser => ({ userId, role, orgId: 'org-1', email: `${userId}@test.dev` });

const ADMIN = actor('admin', Role.ADMIN);
const MANAGER_A = actor('mgr-a', Role.MANAGER);
const CALLER_A1 = actor('caller-a1', Role.CALLER);
const CALLER_A2 = actor('caller-a2', Role.CALLER);
const DRIVER = actor('driver-a', Role.DELIVERY_PARTNER);

const USERS: Row[] = [
  { id: 'admin', role: 'ADMIN', managerId: null },
  { id: 'mgr-a', role: 'MANAGER', managerId: null },
  { id: 'mgr-b', role: 'MANAGER', managerId: null },
  { id: 'caller-a1', role: 'CALLER', managerId: 'mgr-a' },
  { id: 'caller-a2', role: 'CALLER', managerId: 'mgr-a' },
  { id: 'caller-b1', role: 'CALLER', managerId: 'mgr-b' },
  { id: 'driver-a', role: 'DELIVERY_PARTNER', managerId: 'mgr-a' },
].map((u) => ({ ...u, orgId: 'org-1', name: u.id, status: 'ACTIVE', deletedAt: null }));

const LEAD_ROWS: Row[] = [
  { id: 'lead-a1', assignedToId: 'caller-a1' },
  { id: 'lead-a2', assignedToId: 'caller-a2' },
  { id: 'lead-mgr-a', assignedToId: 'mgr-a' },
  { id: 'lead-b1', assignedToId: 'caller-b1' },
  { id: 'lead-unassigned', assignedToId: null },
  { id: 'lead-deleted', assignedToId: 'caller-a1', deletedAt: new Date() },
  { id: 'lead-other-org', assignedToId: 'caller-a1', orgId: 'org-2' },
];

/** Evaluates the Prisma where-clauses LeadsService builds against an in-memory row. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Row[]).every((w) => matches(row, w));
    if (key === 'OR') return (value as Row[]).some((w) => matches(row, w));
    if (key === 'assignedTo') return !!row.assignedTo && matches(row.assignedTo, value);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('notIn' in value) return !value.notIn.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      return true; // ranges / contains — not used by these tests
    }
    return (row[key] ?? null) === value;
  });
}

function setup() {
  const leads: Row[] = LEAD_ROWS.map((l) => ({
    orgId: 'org-1',
    deletedAt: null,
    status: 'ASSIGNED',
    name: l.id,
    phone: '+919800000000',
    source: 'MANUAL',
    firstResponseAt: null,
    ...l,
    assignedTo: USERS.find((u) => u.id === l.assignedToId) ?? null,
  }));
  const tx = {
    lead: { update: async ({ where, data }: Row) => Object.assign(leads.find((l) => l.id === where.id)!, data) },
    leadActivityLog: { create: async ({ data }: Row) => data },
    leadAssignment: { create: async ({ data }: Row) => data },
    taskAllotment: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    lead: {
      findMany: async ({ where }: Row) => leads.filter((l) => matches(l, where)),
      findFirst: async ({ where }: Row) => leads.find((l) => matches(l, where)) ?? null,
      count: async ({ where }: Row) => leads.filter((l) => matches(l, where)).length,
    },
    user: { findFirst: async ({ where }: Row) => USERS.find((u) => matches(u, where)) ?? null },
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn)),
  };
  const notifications = { notifyAssigned: async () => undefined };
  const assignment = new LeadAssignmentService(prisma as never, {} as never, notifications as never);
  const leadsService = new LeadsService(prisma as never, {} as never, {} as never, {} as never, {} as never, assignment);
  return { leads, leadsService, assignment };
}

const visibleIds = async (user: AuthenticatedUser) =>
  (await setup().leadsService.findAll(user, { page: 1, pageSize: 100 })).items.map((l: Row) => l.id).sort();

/** Runs the real RolesGuard against the @Roles metadata of a LeadsController handler. */
function routeAllows(handler: keyof LeadsController, user: AuthenticatedUser): boolean {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => LeadsController.prototype[handler],
    getClass: () => LeadsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
}

describe('lead visibility (GET /leads)', () => {
  it('shows a caller only the leads assigned to them', async () => {
    assert.deepEqual(await visibleIds(CALLER_A1), ['lead-a1']);
  });

  it("shows a manager their own and their team's leads only — not another team's or unassigned ones", async () => {
    assert.deepEqual(await visibleIds(MANAGER_A), ['lead-a1', 'lead-a2', 'lead-mgr-a']);
  });

  it("shows an admin every live lead in the org — never soft-deleted or another org's", async () => {
    assert.deepEqual(await visibleIds(ADMIN), ['lead-a1', 'lead-a2', 'lead-b1', 'lead-mgr-a', 'lead-unassigned']);
  });

  it('gives delivery partners no lead access, at the route and in the service', async () => {
    assert.equal(routeAllows('findAll', DRIVER), false);
    assert.deepEqual(await visibleIds(DRIVER), []);
  });

  it("does not let a caller open a teammate's lead", async () => {
    await assert.rejects(setup().leadsService.findOne(CALLER_A1, 'lead-a2'), NotFoundException);
  });
});

describe('deleting leads (Admin only)', () => {
  it('blocks callers and managers at the route', () => {
    assert.equal(routeAllows('remove', CALLER_A1), false);
    assert.equal(routeAllows('remove', MANAGER_A), false);
    assert.equal(routeAllows('remove', ADMIN), true);
  });

  it('refuses a caller in the service too', async () => {
    await assert.rejects(setup().leadsService.remove(CALLER_A1, 'lead-a1'), ForbiddenException);
  });
});

describe('changing status and assignment', () => {
  it("refuses a caller changing another caller's lead", async () => {
    await assert.rejects(
      setup().leadsService.updateStatus(CALLER_A2, 'lead-a1', { status: 'IN_PROGRESS' as never }),
      NotFoundException,
    );
  });

  it('requires a note to convert and a reason to lose a lead', async () => {
    const { leadsService } = setup();
    await assert.rejects(leadsService.updateStatus(CALLER_A1, 'lead-a1', { status: 'CONVERTED' as never }), /note is required/);
    await assert.rejects(leadsService.updateStatus(CALLER_A1, 'lead-a1', { status: 'LOST' as never }), /lostReason is required/);
  });

  it("lets the assignee convert their lead with a note, setting convertedAt and firstResponseAt", async () => {
    const { leadsService, leads } = setup();
    await leadsService.updateStatus(CALLER_A1, 'lead-a1', { status: 'CONVERTED' as never, note: '40 sheets BWP, paid advance' });
    const lead = leads.find((l) => l.id === 'lead-a1')!;
    assert.equal(lead.status, 'CONVERTED');
    assert.ok(lead.convertedAt instanceof Date);
    assert.ok(lead.firstResponseAt instanceof Date);
  });

  it('blocks callers from assigning, and keeps a manager inside their own team', async () => {
    assert.equal(routeAllows('assign', CALLER_A1), false);
    const { assignment } = setup();
    await assert.rejects(assignment.reassign(MANAGER_A, 'lead-a1', 'caller-b1'), ForbiddenException);
    await assert.rejects(assignment.reassign(MANAGER_A, 'lead-b1', 'caller-a2'), NotFoundException);
    const moved = await assignment.reassign(MANAGER_A, 'lead-a1', 'caller-a2', 'balancing load');
    assert.equal(moved.assignedToId, 'caller-a2');
  });
});

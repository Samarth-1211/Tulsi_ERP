import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityType, AssignmentMethod, Lead, LeadStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { LEAD_ASSIGNEE_ROLES, managerLeadScope } from '../../../common/utils/lead-scope.util';
import { LeadAllocationService } from './lead-allocation.service';
import { LeadNotificationsService } from './lead-notifications.service';

// A hand-picked (re)assignment revives a NEW or LOST lead into the new owner's
// active pipeline; any other status (IN_PROGRESS, CONVERTED) is left as-is.
const REVIVED_ON_ASSIGN: LeadStatus[] = [LeadStatus.NEW, LeadStatus.LOST];

// Bulk writes go in chunks so a large selection stays under Postgres's
// bind-parameter limit, inside one transaction.
const BULK_CHUNK_SIZE = 1000;
const BULK_TX_TIMEOUT_MS = 120_000;

function chunked<T>(items: T[], size = BULK_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

type AssignTarget = { id: string; name: string; role: Role; managerId: string | null };
type AssignableLead = Pick<Lead, 'id' | 'orgId' | 'assignedToId' | 'status'>;

/**
 * Manual lead (re)assignment — PATCH /leads/:id/assign and bulk assign:
 *  - ADMIN → any active user in the org
 *  - MANAGER → only leads held by them or their team, to themselves or their team
 * Each move writes a LeadAssignment row (MANUAL), a REASSIGNED activity (or
 * ASSIGNED for a lead that had no owner) and notifies the new assignee.
 * Also the lost-lead reshuffle (manual, or automatic on LOST).
 */
@Injectable()
export class LeadAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: LeadAllocationService,
    private readonly notifications: LeadNotificationsService,
  ) {}

  async reassign(actor: AuthenticatedUser, leadId: string, toUserId: string, reason?: string): Promise<Lead> {
    this.assertCanAssign(actor);

    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        orgId: actor.orgId,
        deletedAt: null,
        ...(actor.role === Role.MANAGER ? managerLeadScope(actor.userId) : {}),
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const target = await this.findAssignTarget(actor, toUserId);
    if (lead.assignedToId === target.id) {
      throw new BadRequestException(`Lead is already assigned to ${target.name}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lead.update({
        where: { id: lead.id },
        data: {
          assignedToId: target.id,
          assignedAt: new Date(),
          ...(REVIVED_ON_ASSIGN.includes(lead.status) ? { status: LeadStatus.ASSIGNED, lostReason: null } : {}),
          lastActivityAt: new Date(),
        },
      });
      await tx.leadAssignment.create({ data: this.assignmentRow(actor, lead, target, reason) });
      await tx.leadActivityLog.create({ data: this.assignmentActivity(actor, lead, target, reason) });
      return result;
    });

    await this.notifications.notifyAssigned(updated, {
      how: `assigned by ${actor.email}${reason ? ` — ${reason}` : ''}`,
      actorId: actor.userId,
      reassigned: Boolean(lead.assignedToId),
    });
    return updated;
  }

  /**
   * Hands every selected lead to one person — the same rules as `reassign`,
   * checked lead by lead: leads the actor can't move (or already with that
   * person) are skipped and reported. The assignee gets one summary notification.
   */
  async reassignMany(actor: AuthenticatedUser, leadIds: string[], toUserId: string, reason?: string) {
    this.assertCanAssign(actor);
    const target = await this.findAssignTarget(actor, toUserId);
    const ids = [...new Set(leadIds)];

    const leads = await this.prisma.lead.findMany({
      where: {
        id: { in: ids },
        orgId: actor.orgId,
        deletedAt: null,
        ...(actor.role === Role.MANAGER ? managerLeadScope(actor.userId) : {}),
      },
      select: { id: true, orgId: true, assignedToId: true, status: true },
    });

    const found = new Set(leads.map((l) => l.id));
    const skipped: { leadId: string; reason: string }[] = ids
      .filter((id) => !found.has(id))
      .map((leadId) => ({ leadId, reason: 'Lead not found' }));
    const toAssign = leads.filter((lead) => {
      if (lead.assignedToId !== target.id) return true;
      skipped.push({ leadId: lead.id, reason: `Already assigned to ${target.name}` });
      return false;
    });

    if (toAssign.length > 0) {
      const now = new Date();
      const revived = toAssign.filter((l) => REVIVED_ON_ASSIGN.includes(l.status)).map((l) => l.id);
      const kept = toAssign.filter((l) => !REVIVED_ON_ASSIGN.includes(l.status)).map((l) => l.id);

      await this.prisma.$transaction(
        async (tx) => {
          for (const chunk of chunked(revived)) {
            await tx.lead.updateMany({
              where: { id: { in: chunk } },
              data: { assignedToId: target.id, assignedAt: now, lastActivityAt: now, status: LeadStatus.ASSIGNED, lostReason: null },
            });
          }
          for (const chunk of chunked(kept)) {
            await tx.lead.updateMany({
              where: { id: { in: chunk } },
              data: { assignedToId: target.id, assignedAt: now, lastActivityAt: now },
            });
          }
          for (const chunk of chunked(toAssign)) {
            await tx.leadAssignment.createMany({ data: chunk.map((l) => this.assignmentRow(actor, l, target, reason)) });
            await tx.leadActivityLog.createMany({ data: chunk.map((l) => this.assignmentActivity(actor, l, target, reason)) });
          }
        },
        { timeout: BULK_TX_TIMEOUT_MS },
      );

      await this.notifications.notifyBulkAssigned({
        orgId: actor.orgId,
        assigneeId: target.id,
        count: toAssign.length,
        how: `assigned by ${actor.email}`,
        actorId: actor.userId,
      });
    }

    return { attempted: ids.length, assigned: toAssign.length, skipped };
  }

  /**
   * Manually shuffles lost leads (all lost leads in scope when `leadIds` is
   * omitted) to a different eligible person each — never back to whoever
   * lost it. A Manager's shuffle stays inside their own team.
   */
  async shuffleLostLeads(actor: AuthenticatedUser, leadIds?: string[]) {
    this.assertCanAssign(actor);
    const teamManagerId = actor.role === Role.MANAGER ? actor.userId : null;

    const lostLeads = await this.prisma.lead.findMany({
      where: {
        orgId: actor.orgId,
        deletedAt: null,
        status: LeadStatus.LOST,
        ...(leadIds ? { id: { in: leadIds } } : {}),
        ...(teamManagerId ? { assignedTo: { managerId: teamManagerId } } : {}),
      },
      include: { assignedTo: { select: { role: true } } },
    });

    const results: { leadId: string; reassignedToId: string | null }[] = [];
    for (const lead of lostLeads) {
      if (!lead.assignedToId || !lead.assignedTo) continue;
      const reallocated = await this.reallocateLostLead(
        lead,
        lead.assignedToId,
        lead.assignedTo.role,
        `manual shuffle by ${actor.email}`,
        teamManagerId,
        actor.userId,
      );
      results.push({ leadId: lead.id, reassignedToId: reallocated?.assignedToId ?? null });
    }

    return { attempted: lostLeads.length, reassigned: results.filter((r) => r.reassignedToId).length, results };
  }

  /**
   * Hands a lost lead to a different person of the same role as whoever lost
   * it (fewest open leads first) and flips it back to ASSIGNED. Returns null
   * (leaving it LOST) when no one else is eligible. Used by the manual
   * shuffle and, with OrgSettings.autoReallocateLostLeads, the moment a lead
   * is marked LOST.
   */
  async reallocateLostLead(
    lead: Lead,
    excludeUserId: string,
    holderRole: Role,
    reason: string,
    teamManagerId: string | null = null,
    actorId: string | null = null,
  ): Promise<Lead | null> {
    const newAssigneeId = await this.allocation.selectReassignee(lead.orgId, excludeUserId, holderRole, teamManagerId);
    if (!newAssigneeId) return null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lead.update({
        where: { id: lead.id },
        data: { assignedToId: newAssigneeId, assignedAt: new Date(), status: LeadStatus.ASSIGNED, lostReason: null },
      });
      await tx.leadAssignment.create({
        data: {
          orgId: lead.orgId,
          leadId: lead.id,
          fromUserId: excludeUserId,
          toUserId: newAssigneeId,
          method: AssignmentMethod.MANUAL,
          assignedById: actorId,
          reason,
        },
      });
      await tx.leadActivityLog.create({
        data: {
          orgId: lead.orgId,
          leadId: lead.id,
          userId: actorId,
          type: ActivityType.REASSIGNED,
          message: `Lost lead reassigned for a fresh attempt (${reason})`,
          meta: { fromUserId: excludeUserId, toUserId: newAssigneeId, reason },
        },
      });
      return result;
    });

    await this.notifications.notifyAssigned(updated, {
      how: `a lost lead handed to you for a fresh attempt (${reason})`,
      actorId,
      reassigned: true,
    });
    return updated;
  }

  private assertCanAssign(actor: AuthenticatedUser): void {
    if (!([Role.ADMIN, Role.MANAGER] as Role[]).includes(actor.role)) {
      throw new ForbiddenException('Only Admins and Managers can assign leads');
    }
  }

  /** An active, non-deleted user in the org; for a Manager, only themselves or their own team. */
  private async findAssignTarget(actor: AuthenticatedUser, toUserId: string): Promise<AssignTarget> {
    const target = await this.prisma.user.findFirst({
      where: {
        id: toUserId,
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true, name: true, role: true, managerId: true },
    });
    if (!target) throw new BadRequestException('toUserId does not reference an active user in your organization');
    // Delivery/warehouse staff can't open leads — a lead given to them would vanish from every list.
    if (!LEAD_ASSIGNEE_ROLES.includes(target.role)) {
      throw new BadRequestException(`${target.name} can't be given leads — choose an Admin, Manager or Caller`);
    }

    if (actor.role === Role.MANAGER && target.id !== actor.userId && target.managerId !== actor.userId) {
      throw new ForbiddenException('Managers can only assign a lead to themselves or their own team');
    }
    return target;
  }

  private assignmentRow(
    actor: AuthenticatedUser,
    lead: AssignableLead,
    target: AssignTarget,
    reason?: string,
  ): Prisma.LeadAssignmentCreateManyInput {
    return {
      orgId: lead.orgId,
      leadId: lead.id,
      fromUserId: lead.assignedToId,
      toUserId: target.id,
      method: AssignmentMethod.MANUAL,
      assignedById: actor.userId,
      reason: reason ?? null,
    };
  }

  private assignmentActivity(
    actor: AuthenticatedUser,
    lead: AssignableLead,
    target: AssignTarget,
    reason?: string,
  ): Prisma.LeadActivityLogCreateManyInput {
    return {
      orgId: lead.orgId,
      leadId: lead.id,
      userId: actor.userId,
      type: lead.assignedToId ? ActivityType.REASSIGNED : ActivityType.ASSIGNED,
      message: `${lead.assignedToId ? 'Reassigned' : 'Assigned'} to ${target.name} by ${actor.email}${reason ? ` — ${reason}` : ''}`,
      meta: { fromUserId: lead.assignedToId, toUserId: target.id, method: AssignmentMethod.MANUAL, reason: reason ?? null },
    };
  }
}

import { Prisma, Role } from '@prisma/client';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

/** Roles that only ever see the leads assigned to them. */
export const INDIVIDUAL_CONTRIBUTOR_ROLES: Role[] = [Role.CALLER];

/**
 * A Manager's leads: those assigned to them, or to one of their direct
 * reports. Nothing else — not other Managers' teams, and not unassigned
 * leads (those are the Admin's to hand out).
 */
export function managerLeadScope(managerId: string): Prisma.LeadWhereInput {
  return { OR: [{ assignedToId: managerId }, { assignedTo: { managerId } }] };
}

/** Roles with no access to leads at all (Phase 1). */
export const NO_LEAD_ACCESS_ROLES: Role[] = [Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF];

/** Roles a lead may be assigned to — anyone else could never open it. */
export const LEAD_ASSIGNEE_ROLES: Role[] = [Role.ADMIN, Role.MANAGER, Role.CALLER];

/**
 * Which of the org's leads the actor may see: Admins/Super Admins see all of
 * them, Managers see their own and their team's, Callers see only their own,
 * delivery/warehouse staff see none. Combine with the `orgId` filter — this
 * doesn't set it.
 */
export function leadVisibilityWhere(actor: AuthenticatedUser): Prisma.LeadWhereInput {
  if (actor.role === Role.MANAGER) return managerLeadScope(actor.userId);
  if (INDIVIDUAL_CONTRIBUTOR_ROLES.includes(actor.role)) return { assignedToId: actor.userId };
  if (NO_LEAD_ACCESS_ROLES.includes(actor.role)) return { id: { in: [] } };
  return {};
}

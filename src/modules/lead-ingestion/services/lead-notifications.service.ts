import { Injectable, Logger } from '@nestjs/common';
import { Lead, LeadImportAllocationMode, NotificationType, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { leadLabel } from './lead-dedup.service';


export interface LeadAssignmentContext {
  /** How the lead reached them, e.g. "auto-assigned from Magic Bricks" or "assigned by a@b.com". */
  how: string;
  /** Whoever did the assigning — no notification when they assigned the lead to themselves. */
  actorId?: string | null;
  reassigned?: boolean;
}

/**
 * How many of an Excel upload's leads one person received — a caller
 * member, or a Manager (then `managerId` is their own id).
 */
export interface BulkAllocationRow {
  userId: string;
  name: string;
  managerId: string | null;
  managerName: string | null;
  count: number;
}

export interface BulkUploadSummary {
  orgId: string;
  uploader: { id: string; name: string; role: Role };
  allocationMode: LeadImportAllocationMode;
  /** The Managers picked to share the upload — empty when it went to every team. */
  managerNames: string[];
  fileName: string;
  createdCount: number;
  allocation: BulkAllocationRow[];
}

/** Who edited or deleted a lead, for the notification text. */
export interface LeadChangeActor {
  id: string;
  name: string;
  role: Role;
}

/** One edited field: "Phone: 98123 45678 → 98123 00000". */
export interface LeadFieldChange {
  label: string;
  from: string;
  to: string;
}

/** Several leads handed to one person in a single action (bulk assign). */
export interface BulkAssignmentSummary {
  orgId: string;
  assigneeId: string;
  count: number;
  hotCount?: number;
  /** e.g. "assigned by a@b.com". */
  how: string;
  actorId: string;
}

/** Several leads deleted in one action — a selection, or every lead from one uploaded sheet. */
export interface BulkDeletionSummary {
  orgId: string;
  count: number;
  /** e.g. "from the sheet leads-sept.xlsx" — empty for a plain selection. */
  context: string | null;
  /** A few of the deleted leads' names, for the message. */
  sampleNames: string[];
  /** Whoever held the deleted leads, and their Managers — they hear about it too. */
  affectedUserIds: (string | null | undefined)[];
}

/** What a deleted lead held — the lead row itself is gone by the time this is sent. */
export interface DeletedLeadSnapshot {
  orgId: string;
  name: string | null;
  phone: string;
  email: string | null;
  source: string;
  status: string;
  assignedToId: string | null;
  assigneeName: string | null;
  assigneeManagerId: string | null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function roleLabel(role: Role): string {
  if (role === Role.SUPER_ADMIN) return 'Super Admin';
  return role.charAt(0) + role.slice(1).toLowerCase();
}

/** Keeps a long change list readable in the bell and in a device notification. */
function truncate(text: string, max = 600): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * In-app notifications for the lead pipeline:
 *  - LEAD_CAPTURED: every active Admin in the org, plus the Manager whose
 *    team the lead went to, whenever a new lead is saved from any channel
 *    (portal webhook, WhatsApp, manual entry) — other Managers never hear
 *    about leads outside their team
 *  - LEAD_ASSIGNED: the team member a lead is allocated to — auto-allocation
 *    on capture, a manual (re)assignment, or a lost-lead reshuffle
 *  - an Excel upload sends one summary per person instead of one per lead
 *    (see notifyBulkUpload)
 *  - LEAD_UPDATED / LEAD_DELETED: the org's Admins (plus the lead's assignee
 *    and their Manager) when someone edits or deletes a lead, with what
 *    changed or what was removed
 *
 * Best-effort on purpose: the lead is already saved when these run, so a
 * failure is logged, not thrown — a portal webhook must not 500 (and be
 * retried into a "re-enquiry") just because a notification wasn't written.
 */
@Injectable()
export class LeadNotificationsService {
  private readonly logger = new Logger(LeadNotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param channel Where the lead came from, e.g. "Magic Bricks" or "manual entry by a@b.com".
   * @param capturedById Whoever keyed the lead in by hand — they already know about it.
   * @param actionNeeded Something only an Admin can sort out for this lead (e.g. its project has no
   *   team yet) — added to the Admins' notification, which is then titled as needing action.
   */
  async notifyCaptured(
    lead: Lead,
    channel: string,
    capturedById?: string | null,
    actionNeeded?: string | null,
  ): Promise<void> {
    try {
      const assignee = lead.assignedToId
        ? await this.prisma.user.findUnique({
            where: { id: lead.assignedToId },
            select: { name: true, managerId: true },
          })
        : null;

      const recipients = await this.prisma.user.findMany({
        where: {
          orgId: lead.orgId,
          // Admins oversee every lead; a Manager only the ones their team got.
          OR: [
            { role: Role.ADMIN },
            ...(assignee?.managerId ? [{ id: assignee.managerId, role: Role.MANAGER }] : []),
          ],
          status: UserStatus.ACTIVE,
          deletedAt: null,
          // The assignee gets the more specific LEAD_ASSIGNED instead.
          id: { notIn: [capturedById, lead.assignedToId].filter((id): id is string => !!id) },
        },
        select: { id: true, role: true },
      });
      if (recipients.length === 0) return;

      const title = `New lead: ${leadLabel(lead)}`;
      const message = `${lead.phone} came in via ${channel} — ${
        assignee ? `assigned to ${assignee.name}` : 'not assigned yet, needs allocation'
      }.`;

      await this.prisma.notification.createMany({
        data: recipients.map(({ id, role }) => {
          const needsAction = !!actionNeeded && role === Role.ADMIN;
          return {
            orgId: lead.orgId,
            userId: id,
            type: NotificationType.LEAD_CAPTURED,
            title: needsAction ? `Action needed — ${title[0].toLowerCase()}${title.slice(1)}` : title,
            message: needsAction ? truncate(`${message} ${actionNeeded}`) : message,
            leadId: lead.id,
          };
        }),
      });
    } catch (error) {
      this.logger.warn(`Could not send lead-captured notifications for lead ${lead.id}: ${error}`);
    }
  }

  async notifyAssigned(lead: Lead, { how, actorId, reassigned }: LeadAssignmentContext): Promise<void> {
    if (!lead.assignedToId || lead.assignedToId === actorId) return;

    try {
      await this.prisma.notification.create({
        data: {
          orgId: lead.orgId,
          userId: lead.assignedToId,
          type: NotificationType.LEAD_ASSIGNED,
          title: reassigned
            ? `Lead reassigned to you: ${leadLabel(lead)}`
            : `New lead assigned to you: ${leadLabel(lead)}`,
          message: `${lead.phone} — ${how}.`,
          leadId: lead.id,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not send lead-assigned notification for lead ${lead.id}: ${error}`);
    }
  }

  /**
   * A lead's details were edited: the org's Admins hear exactly what
   * changed, as do the lead's assignee and their Manager — whoever made the
   * edit is left out.
   */
  async notifyDetailsUpdated(
    lead: Lead & { assignedTo?: { managerId: string | null } | null },
    actor: LeadChangeActor,
    changes: LeadFieldChange[],
  ): Promise<void> {
    if (changes.length === 0) return;
    try {
      const recipients = await this.oversightRecipients(lead.orgId, actor.id, [
        lead.assignedToId,
        lead.assignedTo?.managerId,
      ]);
      if (recipients.length === 0) return;

      const summary = changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ');
      await this.prisma.notification.createMany({
        data: recipients.map((userId) => ({
          orgId: lead.orgId,
          userId,
          type: NotificationType.LEAD_UPDATED,
          title: `Lead edited by ${roleLabel(actor.role)} ${actor.name}: ${leadLabel(lead)}`,
          message: truncate(`${lead.phone} — ${summary}.`),
          leadId: lead.id,
        })),
      });
    } catch (error) {
      this.logger.warn(`Could not send lead-updated notifications for lead ${lead.id}: ${error}`);
    }
  }

  /**
   * A lead was deleted: the org's Admins (plus its assignee and their
   * Manager) get a snapshot of what was removed, since the lead itself —
   * and its timeline — no longer exist to look at.
   */
  async notifyDeleted(snapshot: DeletedLeadSnapshot, actor: LeadChangeActor): Promise<void> {
    try {
      const recipients = await this.oversightRecipients(snapshot.orgId, actor.id, [
        snapshot.assignedToId,
        snapshot.assigneeManagerId,
      ]);
      if (recipients.length === 0) return;

      const details = [
        `Phone ${snapshot.phone}`,
        snapshot.email && `email ${snapshot.email}`,
        `source ${snapshot.source}`,
        `status ${snapshot.status}`,
        `assigned to ${snapshot.assigneeName ?? 'no one'}`,
      ].filter(Boolean);

      await this.prisma.notification.createMany({
        data: recipients.map((userId) => ({
          orgId: snapshot.orgId,
          userId,
          type: NotificationType.LEAD_DELETED,
          title: `Lead deleted by ${roleLabel(actor.role)} ${actor.name}: ${snapshot.name ?? snapshot.phone}`,
          message: truncate(`${details.join(', ')}.`),
        })),
      });
    } catch (error) {
      this.logger.warn(`Could not send lead-deleted notifications for lead ${snapshot.phone}: ${error}`);
    }
  }

  /** One notification for a whole bulk (re)assignment, rather than one per lead. */
  async notifyBulkAssigned({ orgId, assigneeId, count, how, actorId }: BulkAssignmentSummary): Promise<void> {
    if (count === 0 || assigneeId === actorId) return;
    try {
      await this.prisma.notification.create({
        data: {
          orgId,
          userId: assigneeId,
          type: NotificationType.LEAD_ASSIGNED,
          title: `${plural(count, 'lead')} assigned to you`,
          message: `${how}.`,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not send bulk-assigned notification to ${assigneeId}: ${error}`);
    }
  }

  /**
   * One summary per person when several leads are deleted at once: the
   * org's Admins plus whoever held the leads and their Managers — the
   * person who deleted them is left out.
   */
  async notifyBulkDeleted(summary: BulkDeletionSummary, actor: LeadChangeActor): Promise<void> {
    if (summary.count === 0) return;
    try {
      const recipients = await this.oversightRecipients(summary.orgId, actor.id, summary.affectedUserIds);
      if (recipients.length === 0) return;

      const more = summary.count - summary.sampleNames.length;
      const names = `${summary.sampleNames.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      await this.prisma.notification.createMany({
        data: recipients.map((userId) => ({
          orgId: summary.orgId,
          userId,
          type: NotificationType.LEAD_DELETED,
          title: `${plural(summary.count, 'lead')} deleted by ${roleLabel(actor.role)} ${actor.name}`,
          message: truncate(`${summary.context ? `${summary.context[0].toUpperCase()}${summary.context.slice(1)}: ` : ''}${names}.`),
        })),
      });
    } catch (error) {
      this.logger.warn(`Could not send bulk lead-deleted notifications: ${error}`);
    }
  }

  /** Every active Admin in the org plus the given extra users (if still active), minus `excludeId`. */
  private async oversightRecipients(
    orgId: string,
    excludeId: string,
    extraIds: (string | null | undefined)[],
  ): Promise<string[]> {
    const extras = extraIds.filter((id): id is string => !!id);
    const users = await this.prisma.user.findMany({
      where: {
        orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        id: { not: excludeId },
        OR: [{ role: Role.ADMIN }, ...(extras.length ? [{ id: { in: extras } }] : [])],
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * One summary per person for an Excel upload, rather than one
   * notification per lead: everyone who received leads hears how many they
   * got, each Manager how many went to their team members, and the Admins
   * (other than the uploader) that the upload happened. The uploader already
   * saw all of this on their own screen, so they get nothing.
   */
  async notifyBulkUpload({
    orgId,
    uploader,
    allocationMode,
    managerNames,
    fileName,
    createdCount,
    allocation,
  }: BulkUploadSummary): Promise<void> {
    if (createdCount === 0) return;
    const uploaderRole = uploader.role === Role.MANAGER ? 'Manager' : 'Admin';
    const providedBy = `Provided by ${uploaderRole} ${uploader.name} via Excel upload (${fileName})`;

    try {
      const data: {
        orgId: string;
        userId: string;
        type: NotificationType;
        title: string;
        message: string;
      }[] = allocation.filter((row) => row.userId !== uploader.id).map((row) => ({
        orgId,
        userId: row.userId,
        type: NotificationType.LEAD_ASSIGNED,
        title: `${plural(row.count, 'new lead')} assigned to you`,
        message: `${providedBy}.`,
      }));

      // A Manager's own share was covered just above — this is about their team members'.
      const teams = new Map<string, BulkAllocationRow[]>();
      for (const row of allocation) {
        if (!row.managerId || row.managerId === uploader.id || row.managerId === row.userId) continue;
        teams.set(row.managerId, [...(teams.get(row.managerId) ?? []), row]);
      }
      for (const [managerId, rows] of teams) {
        const total = rows.reduce((sum, r) => sum + r.count, 0);
        data.push({
          orgId,
          userId: managerId,
          type: NotificationType.LEAD_CAPTURED,
          title: `${plural(total, 'uploaded lead')} went to your team`,
          message: `${providedBy} — ${rows.map((r) => `${r.name}: ${r.count}`).join(', ')}.`,
        });
      }

      const admins = await this.prisma.user.findMany({
        where: { orgId, role: Role.ADMIN, status: UserStatus.ACTIVE, deletedAt: null, id: { not: uploader.id } },
        select: { id: true },
      });
      const assigned = allocation.reduce((sum, r) => sum + r.count, 0);
      const teamCount = new Set(allocation.map((r) => r.managerId)).size;
      const sharedAcross = {
        ALL_TEAMS: plural(teamCount, 'caller team'),
        MANAGERS_AND_TEAMS: plural(teamCount, 'team'),
        MANAGERS_ONLY: plural(teamCount, 'manager'),
        CUSTOM: `${allocation.length} ${allocation.length === 1 ? 'person' : 'people'} as a custom split`,
      }[allocationMode];
      const picked =
        managerNames.length > 0
          ? `. Managers picked: ${managerNames.join(', ')} — ${
              allocationMode === LeadImportAllocationMode.MANAGERS_ONLY ? 'managers only' : 'with their teams'
            }`
          : '';
      for (const { id } of admins) {
        data.push({
          orgId,
          userId: id,
          type: NotificationType.LEAD_CAPTURED,
          title: `${plural(createdCount, 'lead')} uploaded by ${uploaderRole} ${uploader.name}`,
          message: `From ${fileName} — ${
            assigned > 0 ? `${assigned} shared across ${sharedAcross}` : 'none could be assigned yet'
          }${assigned > 0 && assigned < createdCount ? `, ${createdCount - assigned} left unassigned` : ''}${picked}.`,
        });
      }

      await this.prisma.notification.createMany({ data });
    } catch (error) {
      this.logger.warn(`Could not send bulk-upload notifications for ${fileName}: ${error}`);
    }
  }
}

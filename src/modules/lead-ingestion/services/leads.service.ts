import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ActivityType,
  AllotmentStatus,
  FollowUpStatus,
  Lead,
  LeadSource,
  LeadStatus,
  NotificationType,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { leadVisibilityWhere } from '../../../common/utils/lead-scope.util';
import { searchKeyFilter } from '../../../common/utils/phonetic-key.util';
import { businessDayEndInstant, businessDayStartInstant } from '../../../common/utils/business-date.util';
import { CreateLeadManualDto } from '../dto/create-lead-manual.dto';
import { LeadQueryDto } from '../dto/lead-querry-dto';
import { UpdateLeadStatusDto } from '../dto/update-lead-status.dto';
import { UpdateLeadDetailsDto } from '../dto/update-lead-details.dto';
import { CreateFollowUpDto } from '../dto/create-follow-up.dto';
import { LeadAllocationService } from './lead-allocation.service';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadIngestionService } from './lead-ingestion.service';
import { CLOSED_LEAD_STATUSES, formatSourceLabel, LeadDedupService, leadLabel, toE164 } from './lead-dedup.service';
import { LeadChangeActor, LeadFieldChange, LeadNotificationsService } from './lead-notifications.service';
import { rememberCity } from '../utils/city.util';

const OPEN_LEAD_STATUSES: LeadStatus[] = [LeadStatus.NEW, LeadStatus.ASSIGNED, LeadStatus.IN_PROGRESS];
const BULK_CHUNK_SIZE = 1000;

function chunked<T>(items: T[], size = BULK_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const ASSIGNEE_SUMMARY = { select: { id: true, name: true, email: true, role: true, managerId: true } } as const;

// Who provided an Excel-uploaded lead — shown on the lead list and detail page.
const IMPORT_BATCH_SUMMARY = {
  select: { id: true, fileName: true, createdAt: true, uploadedBy: { select: { id: true, name: true, role: true } } },
} satisfies Prisma.LeadImportBatchDefaultArgs;

const LIST_INCLUDE = {
  assignedTo: ASSIGNEE_SUMMARY,
  attribution: { select: { campaignName: true, adName: true, adId: true, formName: true, ctwaClid: true } },
  importBatch: IMPORT_BATCH_SUMMARY,
} satisfies Prisma.LeadInclude;

/**
 * Lead management, role-scoped (RBAC matrix):
 *  - list / view / update fields / change status: ADMIN all in org,
 *    MANAGER own + team's, CALLER assigned to self; delivery/warehouse none
 *  - create: ADMIN, MANAGER, CALLER (through LeadIngestionService)
 *  - assign / reassign: LeadAssignmentService
 *  - delete (soft): ADMIN only
 * Every query is scoped by the caller's orgId and excludes soft-deleted leads.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allocationService: LeadAllocationService,
    private readonly dedupService: LeadDedupService,
    private readonly leadNotifications: LeadNotificationsService,
    private readonly ingestion: LeadIngestionService,
    private readonly assignment: LeadAssignmentService,
  ) {}

  /**
   * Manual entry (ADMIN, MANAGER, CALLER) through LeadIngestionService.ingest():
   * an Admin may name any assignee (otherwise round robin); a Manager may
   * name themselves or one of their team; a Caller or Manager without an
   * assignee keeps the lead (SELF). A phone with an open lead is recorded as a
   * re-enquiry on it instead — `deduplicated: true` points the UI at it.
   */
  async createManual(actor: AuthenticatedUser, dto: CreateLeadManualDto): Promise<Lead & { deduplicated: boolean }> {
    if (dto.assignToId && actor.role === Role.CALLER) {
      throw new ForbiddenException('Callers cannot assign leads to someone else');
    }
    if (dto.assignToId && actor.role === Role.MANAGER && dto.assignToId !== actor.userId) {
      const member = await this.prisma.user.findFirst({
        where: { id: dto.assignToId, orgId: actor.orgId, managerId: actor.userId, deletedAt: null },
        select: { id: true },
      });
      if (!member) throw new ForbiddenException('Managers can only assign leads to themselves or their own team');
    }

    const { lead, outcome } = await this.ingestion.ingest({
      orgId: actor.orgId,
      source: dto.source ?? LeadSource.MANUAL,
      name: dto.name,
      phone: dto.phone,
      altPhone: dto.altPhone,
      email: dto.email,
      city: dto.city,
      pincode: dto.pincode,
      address: dto.address,
      customerType: dto.customerType,
      requirementNotes: dto.requirementNotes,
      estimatedValue: dto.estimatedValue,
      createdById: actor.userId,
      assignToId: dto.assignToId,
      channel: `manual entry by ${actor.email}`,
    });
    return { ...lead, deduplicated: outcome !== 'CREATED' };
  }

  /** Leads the actor may see: the org's live leads within their role scope. */
  private scope(actor: AuthenticatedUser): Prisma.LeadWhereInput {
    return { orgId: actor.orgId, deletedAt: null, ...leadVisibilityWhere(actor) };
  }

  async findAll(actor: AuthenticatedUser, query: LeadQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const search = query.search?.trim();
    const searchPhone = search?.replace(/[^\d+]/g, '');

    const where: Prisma.LeadWhereInput = {
      AND: [
        this.scope(actor),
        {
          ...(query.status ? { status: query.status } : {}),
          ...(query.source ? { source: query.source } : {}),
          ...(query.customerType ? { customerType: query.customerType } : {}),
          ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
          ...(query.city ? { city: { equals: query.city.trim(), mode: 'insensitive' as const } } : {}),
          ...(query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: businessDayStartInstant(query.from) } : {}),
                  ...(query.to ? { lte: businessDayEndInstant(query.to) } : {}),
                },
              }
            : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' as const } },
                  ...(searchKeyFilter(search) ? [searchKeyFilter(search)!] : []),
                  ...(searchPhone && searchPhone.replace('+', '').length >= 3
                    ? [{ phone: { contains: searchPhone.replace(/^\+/, '') } }]
                    : []),
                ],
              }
            : {}),
        },
      ],
    };

    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lead.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * How many leads came in since the caller last opened the Leads list — the
   * "new" dot on the Leads nav item. Admins count every new lead in the org;
   * everyone else counts leads newly allocated into what they can see.
   */
  async countUnseen(actor: AuthenticatedUser): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { leadsSeenAt: true } });
    if (!user) return 0;
    return this.prisma.lead.count({
      where: {
        ...this.scope(actor),
        ...(actor.role === Role.ADMIN ? { createdAt: { gt: user.leadsSeenAt } } : { assignedAt: { gt: user.leadsSeenAt } }),
      },
    });
  }

  /** Every city the org's leads have come from, A–Z — options for the Leads "City" filter. */
  async listCities(actor: AuthenticatedUser): Promise<string[]> {
    const cities = await this.prisma.city.findMany({ where: { orgId: actor.orgId }, orderBy: { name: 'asc' }, select: { name: true } });
    return cities.map((c) => c.name);
  }

  async markSeen(actor: AuthenticatedUser): Promise<void> {
    await this.prisma.user.updateMany({ where: { id: actor.userId }, data: { leadsSeenAt: new Date() } });
  }

  async findOne(actor: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, ...this.scope(actor) },
      include: {
        assignedTo: ASSIGNEE_SUMMARY,
        createdBy: { select: { id: true, name: true, role: true } },
        integration: { select: { id: true, name: true, type: true } },
        attribution: true,
        importBatch: IMPORT_BATCH_SUMMARY,
        adSource: { select: { id: true, adId: true, headline: true, sourceUrl: true } },
        previousLead: { select: { id: true, status: true, createdAt: true, assignedToId: true } },
        followUps: { orderBy: { createdAt: 'desc' }, take: 10, include: { user: { select: { id: true, name: true } } } },
        // Lets the detail page show the WhatsApp chat for any lead that has one.
        _count: { select: { whatsappMessages: true, followUps: true, activities: true } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  /** GET /leads/:id/activities — the lead's timeline, newest first. */
  async listActivities(actor: AuthenticatedUser, id: string) {
    await this.findVisibleLead(actor, id);
    return this.prisma.leadActivityLog.findMany({
      where: { leadId: id, orgId: actor.orgId },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The lead, if the actor may work on it: ADMIN any lead in the org,
   * MANAGER own + team's, CALLER only leads assigned to them. Delivery and
   * warehouse staff never (blocked at the controller too).
   */
  private async findVisibleLead(actor: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, ...this.scope(actor) },
      include: { assignedTo: { select: { id: true, name: true, role: true, managerId: true } } },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private async actorSummary(actor: AuthenticatedUser): Promise<LeadChangeActor> {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    return { id: actor.userId, role: actor.role, name: user ? user.name : actor.email };
  }

  /**
   * Activity bookkeeping on a lead: lastActivityAt always, and — the first
   * time the lead's assignee changes its status or logs anything on it —
   * firstResponseAt.
   */
  private activityStamp(lead: Pick<Lead, 'assignedToId' | 'firstResponseAt'>, actor: AuthenticatedUser) {
    const now = new Date();
    return {
      lastActivityAt: now,
      ...(!lead.firstResponseAt && lead.assignedToId === actor.userId ? { firstResponseAt: now } : {}),
    };
  }

  /**
   * Edits the lead's own fields (ADMIN all, MANAGER own + team's, CALLER own).
   * Logged as an UPDATED activity with exactly what changed; the org's
   * Admins (plus assignee and their Manager) are notified.
   */
  async updateDetails(actor: AuthenticatedUser, leadId: string, dto: UpdateLeadDetailsDto) {
    const lead = await this.findVisibleLead(actor, leadId);

    let phone: string | undefined;
    if (dto.phone !== undefined) {
      phone = toE164(dto.phone) ?? undefined;
      if (!phone) throw new BadRequestException(`Invalid phone number: ${dto.phone}`);
      if (phone !== lead.phone) {
        const owner = await this.dedupService.findOpenByPhone(actor.orgId, phone);
        if (owner && owner.id !== lead.id) {
          throw new ConflictException(`That number already belongs to another open lead: ${leadLabel(owner)}`);
        }
      }
    }
    const altPhone = dto.altPhone !== undefined ? (dto.altPhone ? (toE164(dto.altPhone) ?? dto.altPhone.trim()) : null) : undefined;

    const next = {
      name: dto.name?.trim(),
      phone,
      altPhone,
      email: dto.email,
      city: dto.city?.trim(),
      pincode: dto.pincode,
      address: dto.address,
      customerType: dto.customerType,
      requirementNotes: dto.requirementNotes,
      estimatedValue: dto.estimatedValue,
    };

    const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
    const labels: Record<keyof typeof next, string> = {
      name: 'Name',
      phone: 'Phone',
      altPhone: 'Alternate phone',
      email: 'Email',
      city: 'City',
      pincode: 'Pincode',
      address: 'Address',
      customerType: 'Customer type',
      requirementNotes: 'Requirement',
      estimatedValue: 'Estimated value',
    };
    const changes: LeadFieldChange[] = [];
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const to = next[key];
      const from = key === 'estimatedValue' ? lead.estimatedValue?.toNumber() : lead[key];
      if (to !== undefined && show(from) !== show(to)) changes.push({ label: labels[key], from: show(from), to: show(to) });
    }
    if (changes.length === 0) return this.findOne(actor, lead.id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lead.update({ where: { id: lead.id }, data: { ...next, ...this.activityStamp(lead, actor) } });
      await rememberCity(tx, actor.orgId, next.city);
      await tx.leadActivityLog.create({
        data: {
          orgId: actor.orgId,
          leadId: lead.id,
          userId: actor.userId,
          type: ActivityType.UPDATED,
          message: `Details edited — ${changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ')}`,
          meta: { changes: changes.map((c) => ({ ...c })) },
        },
      });
      return result;
    });

    await this.leadNotifications.notifyDetailsUpdated(
      { ...updated, assignedTo: lead.assignedTo },
      await this.actorSummary(actor),
      changes,
    );
    return this.findOne(actor, lead.id);
  }

  /**
   * Status change (same scope as updateDetails):
   *  - CONVERTED requires a note and sets convertedAt — how a caller closes a deal
   *  - LOST requires lostReason
   *  - every change writes STATUS_CHANGED { from, to }
   * With OrgSettings.autoReallocateLostLeads on, a LOST lead is immediately
   * handed to someone else of the same role (RCRM behaviour).
   */
  async updateStatus(actor: AuthenticatedUser, leadId: string, dto: UpdateLeadStatusDto): Promise<Lead> {
    const lead = await this.findVisibleLead(actor, leadId);
    const from = lead.status;
    const to = dto.status;
    if (from === to) throw new BadRequestException('Lead is already in this status');
    // A won deal is final: reopening it silently would undo the conversion in
    // every report, so only an Admin may do it, and must say why.
    if (from === LeadStatus.CONVERTED) {
      if (actor.role !== Role.ADMIN) throw new ForbiddenException('Only an Admin can reopen a converted lead');
      if (!dto.note?.trim()) throw new BadRequestException('A note is required to reopen a converted lead');
    }
    if (to === LeadStatus.CONVERTED && !dto.note?.trim()) {
      throw new BadRequestException('A note is required to mark a lead CONVERTED');
    }
    if (to === LeadStatus.LOST && !dto.lostReason?.trim()) {
      throw new BadRequestException('lostReason is required to mark a lead LOST');
    }
    if (to === LeadStatus.ASSIGNED && !lead.assignedToId) {
      throw new BadRequestException('Assign the lead to someone instead of setting ASSIGNED');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: to,
          convertedAt: to === LeadStatus.CONVERTED ? new Date() : null,
          lostReason: to === LeadStatus.LOST ? dto.lostReason!.trim() : null,
          ...this.activityStamp(lead, actor),
        },
      });
      await tx.leadActivityLog.create({
        data: {
          orgId: actor.orgId,
          leadId: lead.id,
          userId: actor.userId,
          type: ActivityType.STATUS_CHANGED,
          message: `Status changed from ${from} to ${to}${dto.note ? ` — ${dto.note.trim()}` : ''}${
            to === LeadStatus.LOST ? ` (reason: ${dto.lostReason!.trim()})` : ''
          }`,
          meta: {
            from,
            to,
            ...(dto.note ? { note: dto.note.trim() } : {}),
            ...(to === LeadStatus.LOST ? { lostReason: dto.lostReason!.trim() } : {}),
          },
        },
      });
      await this.completeAllotments(tx, lead.id, to);
      return result;
    });

    if (to === LeadStatus.LOST && lead.assignedTo) {
      const { autoReallocateLostLeads } = await this.allocationService.getSettings(actor.orgId);
      if (autoReallocateLostLeads) {
        const reallocated = await this.assignment.reallocateLostLead(
          updated,
          lead.assignedTo.id,
          lead.assignedTo.role,
          'auto-reallocation (org setting)',
          null,
          actor.userId,
        );
        if (reallocated) return reallocated;
      }
    }
    return updated;
  }

  /**
   * POST /leads/:id/follow-ups: logs a follow-up (and closes the lead's
   * earlier pending ones), sets lead.nextFollowUpAt and lastActivityAt, and
   * writes a FOLLOW_UP activity.
   */
  async addFollowUp(actor: AuthenticatedUser, leadId: string, dto: CreateFollowUpDto) {
    const lead = await this.findVisibleLead(actor, leadId);
    const nextFollowUpAt = dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt) : null;
    // A few minutes of slack for device clocks; anything earlier is a typo
    // that would sit in "overdue" from the moment it is saved.
    if (nextFollowUpAt && nextFollowUpAt.getTime() < Date.now() - 5 * 60_000) {
      throw new BadRequestException('The next follow-up must be in the future');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.followUp.updateMany({
        where: { leadId: lead.id, status: FollowUpStatus.PENDING },
        data: { status: FollowUpStatus.DONE, completedAt: new Date() },
      });
      const followUp = await tx.followUp.create({
        data: {
          orgId: actor.orgId,
          leadId: lead.id,
          userId: actor.userId,
          note: dto.note.trim(),
          outcome: dto.outcome?.trim() || null,
          nextFollowUpAt,
          status: nextFollowUpAt ? FollowUpStatus.PENDING : FollowUpStatus.DONE,
          completedAt: nextFollowUpAt ? null : new Date(),
        },
      });
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          nextFollowUpAt,
          ...this.activityStamp(lead, actor),
          // Working a NEW/ASSIGNED lead moves it into the pipeline.
          ...(lead.status === LeadStatus.ASSIGNED ? { status: LeadStatus.IN_PROGRESS } : {}),
        },
      });
      await this.completeAllotments(tx, lead.id, dto.outcome?.trim() || null);
      await tx.leadActivityLog.create({
        data: {
          orgId: actor.orgId,
          leadId: lead.id,
          userId: actor.userId,
          type: ActivityType.FOLLOW_UP,
          message: dto.note.trim(),
          meta: {
            followUpId: followUp.id,
            outcome: dto.outcome ?? null,
            nextFollowUpAt: nextFollowUpAt?.toISOString() ?? null,
          },
        },
      });
      if (lead.status === LeadStatus.ASSIGNED) {
        await tx.leadActivityLog.create({
          data: {
            orgId: actor.orgId,
            leadId: lead.id,
            userId: actor.userId,
            type: ActivityType.STATUS_CHANGED,
            message: 'Status changed from ASSIGNED to IN_PROGRESS (first follow-up)',
            meta: { from: LeadStatus.ASSIGNED, to: LeadStatus.IN_PROGRESS },
          },
        });
      }
      return followUp;
    });
  }

  /** Working a lead closes its open Automated Task Allotment rows (see TaskAllotmentService). */
  private completeAllotments(tx: Prisma.TransactionClient, leadId: string, outcome: string | null) {
    return tx.taskAllotment.updateMany({
      where: { leadId, status: AllotmentStatus.PENDING },
      data: { status: AllotmentStatus.DONE, outcome, completedAt: new Date() },
    });
  }

  /**
   * GET /follow-ups/today: pending follow-ups due by the end of today
   * (overdue included, flagged) on open leads — the caller's own leads, a
   * Manager's own + team's, or the whole org for an Admin.
   */
  async followUpsDueToday(actor: AuthenticatedUser) {
    const startOfToday = businessDayStartInstant();
    const rows = await this.prisma.followUp.findMany({
      where: {
        orgId: actor.orgId,
        status: FollowUpStatus.PENDING,
        nextFollowUpAt: { lte: businessDayEndInstant() },
        lead: { ...this.scope(actor), status: { notIn: CLOSED_LEAD_STATUSES } },
      },
      include: {
        lead: { select: { id: true, name: true, phone: true, status: true, city: true, assignedTo: { select: { id: true, name: true } } } },
        user: { select: { id: true, name: true } },
      },
      orderBy: { nextFollowUpAt: 'asc' },
    });
    return rows.map((row) => ({ ...row, overdue: !!row.nextFollowUpAt && row.nextFollowUpAt < startOfToday }));
  }

  /**
   * POST /leads/:id/notes: a NOTE on the lead's timeline. From a Manager or
   * Admin it also notifies the lead's assignee (RCRM's notification feature) —
   * the manager → employee channel about a lead.
   */
  async addNote(actor: AuthenticatedUser, leadId: string, note: string) {
    const lead = await this.findVisibleLead(actor, leadId);
    const text = note.trim();

    const activity = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: lead.id }, data: this.activityStamp(lead, actor) });
      return tx.leadActivityLog.create({
        data: { orgId: actor.orgId, leadId: lead.id, userId: actor.userId, type: ActivityType.NOTE, message: text },
      });
    });

    if (lead.assignedToId && lead.assignedToId !== actor.userId) {
      const author = await this.actorSummary(actor);
      await this.prisma.notification.create({
        data: {
          orgId: actor.orgId,
          userId: lead.assignedToId,
          leadId: lead.id,
          type: NotificationType.GENERIC,
          title: `Note from ${author.name} on ${leadLabel(lead)}`,
          message: text.length > 600 ? `${text.slice(0, 599)}…` : text,
        },
      });
    }
    return activity;
  }

  /** Soft delete (ADMIN only): sets deletedAt and writes a DELETED activity; Admins are notified. */
  async remove(actor: AuthenticatedUser, leadId: string): Promise<{ message: string; id: string }> {
    this.assertAdmin(actor);
    const lead = await this.findVisibleLead(actor, leadId);

    await this.prisma.$transaction([
      this.prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } }),
      this.prisma.leadActivityLog.create({
        data: { orgId: actor.orgId, leadId: lead.id, userId: actor.userId, type: ActivityType.DELETED, message: 'Lead deleted' },
      }),
    ]);

    await this.leadNotifications.notifyDeleted(
      {
        orgId: lead.orgId,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: formatSourceLabel(lead.source),
        status: lead.status,
        assignedToId: lead.assignedToId,
        assigneeName: lead.assignedTo?.name ?? null,
        assigneeManagerId: lead.assignedTo?.managerId ?? null,
      },
      await this.actorSummary(actor),
    );
    return { message: 'Lead deleted', id: lead.id };
  }

  /** Soft-deletes every selected lead in the org (ADMIN only); unknown ids are skipped. */
  async removeMany(actor: AuthenticatedUser, leadIds: string[]) {
    this.assertAdmin(actor);
    const ids = [...new Set(leadIds)];
    const deletedIds = await this.softDeleteLeads(actor, { id: { in: ids } }, null);
    return { attempted: ids.length, deleted: deletedIds.length, skipped: ids.length - deletedIds.length, deletedIds };
  }

  /** Soft-deletes every lead that came from one uploaded sheet (ADMIN only). */
  async removeImportBatchLeads(actor: AuthenticatedUser, batchId: string) {
    this.assertAdmin(actor);
    const batch = await this.prisma.leadImportBatch.findFirst({
      where: { id: batchId, orgId: actor.orgId },
      select: { id: true, fileName: true },
    });
    if (!batch) throw new NotFoundException('Upload not found');

    const deletedIds = await this.softDeleteLeads(actor, { importBatchId: batch.id }, `from the sheet ${batch.fileName}`);
    return { batchId: batch.id, fileName: batch.fileName, deleted: deletedIds.length, deletedIds };
  }

  private async softDeleteLeads(actor: AuthenticatedUser, where: Prisma.LeadWhereInput, context: string | null) {
    const leads = await this.prisma.lead.findMany({
      where: { AND: [where, { orgId: actor.orgId, deletedAt: null }] },
      select: { id: true, name: true, phone: true, assignedToId: true, assignedTo: { select: { managerId: true } } },
    });
    if (leads.length === 0) return [];

    const ids = leads.map((l) => l.id);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const chunk of chunked(ids)) {
        await tx.lead.updateMany({ where: { id: { in: chunk } }, data: { deletedAt: now } });
        await tx.leadActivityLog.createMany({
          data: chunk.map((leadId) => ({
            orgId: actor.orgId,
            leadId,
            userId: actor.userId,
            type: ActivityType.DELETED,
            message: `Lead deleted${context ? ` (${context})` : ''}`,
          })),
        });
      }
    });

    this.logger.log(`${leads.length} lead(s)${context ? ` ${context}` : ''} soft-deleted by ${actor.email}`);
    await this.leadNotifications.notifyBulkDeleted(
      {
        orgId: actor.orgId,
        count: leads.length,
        context,
        sampleNames: leads.slice(0, 5).map((l) => leadLabel(l)),
        affectedUserIds: [...new Set(leads.flatMap((l) => [l.assignedToId, l.assignedTo?.managerId]))],
      },
      await this.actorSummary(actor),
    );
    return ids;
  }

  private assertAdmin(actor: AuthenticatedUser) {
    if (actor.role !== Role.ADMIN) throw new ForbiddenException('Only Admins can delete leads');
  }

  /**
   * One row per caller (a Manager's direct reports, or the whole org for an
   * Admin): leads held, open, converted, lost, conversion rate, overdue
   * follow-ups and converted value.
   */
  async getTeamPerformance(actor: AuthenticatedUser) {
    if (!([Role.MANAGER, Role.ADMIN] as Role[]).includes(actor.role)) {
      throw new ForbiddenException('Only Managers and Admins can view team performance');
    }

    const executives = await this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        role: { in: [Role.CALLER, Role.MANAGER] },
        ...(actor.role === Role.MANAGER ? { OR: [{ managerId: actor.userId }, { id: actor.userId }] } : {}),
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    if (executives.length === 0) return [];

    const leads = await this.prisma.lead.findMany({
      where: { orgId: actor.orgId, deletedAt: null, assignedToId: { in: executives.map((e) => e.id) } },
      select: { assignedToId: true, status: true, estimatedValue: true, nextFollowUpAt: true },
    });
    const byExecutive = new Map<string, typeof leads>();
    for (const lead of leads) byExecutive.set(lead.assignedToId!, [...(byExecutive.get(lead.assignedToId!) ?? []), lead]);

    const now = Date.now();
    const round1 = (n: number) => Math.round(n * 10) / 10;
    return executives.map((exec) => {
      const list = byExecutive.get(exec.id) ?? [];
      const converted = list.filter((l) => l.status === LeadStatus.CONVERTED);
      return {
        userId: exec.id,
        name: exec.name,
        role: exec.role,
        totalLeads: list.length,
        openLeads: list.filter((l) => OPEN_LEAD_STATUSES.includes(l.status)).length,
        converted: converted.length,
        lost: list.filter((l) => l.status === LeadStatus.LOST).length,
        convertedValue: converted.reduce((sum, l) => sum + Number(l.estimatedValue ?? 0), 0),
        overdueFollowUps: list.filter(
          (l) => l.nextFollowUpAt && l.nextFollowUpAt.getTime() < now && OPEN_LEAD_STATUSES.includes(l.status),
        ).length,
        conversionPct: list.length > 0 ? round1((converted.length / list.length) * 100) : 0,
      };
    });
  }
}

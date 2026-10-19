import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ActivityType,
  AllocationMode,
  AssignmentMethod,
  CustomerType,
  Lead,
  LeadSource,
  LeadStatus,
  Prisma,
  Role,
  UserStatus,
  WebhookEventStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LeadAllocationService } from './lead-allocation.service';
import { LeadDedupService, formatSourceLabel, toE164 } from './lead-dedup.service';
import { LeadNotificationsService } from './lead-notifications.service';
import { rememberCity } from '../utils/city.util';
import { MAX_MONEY } from '../../../common/utils/limits.util';
import { LEAD_ASSIGNEE_ROLES } from '../../../common/utils/lead-scope.util';

/** Ad attribution fields (LeadAdAttribution minus its own keys). */
export type IngestAttribution = Partial<
  Omit<Prisma.LeadAdAttributionUncheckedCreateInput, 'id' | 'leadId' | 'createdAt'>
>;

/** §5 of docs/PHASE1_DATABASE.md — the one input every lead source sends. */
export interface IngestInput {
  orgId: string;
  source: LeadSource;
  integrationId?: string;
  sourceLeadId?: string; // leadgen_id / wamid
  name?: string;
  phone: string; // any format → normalized to E.164 (default country IN)
  altPhone?: string;
  email?: string;
  city?: string;
  pincode?: string;
  address?: string;
  customerType?: CustomerType;
  requirementNotes?: string;
  estimatedValue?: number;
  customFields?: Record<string, unknown>;
  attribution?: IngestAttribution;
  rawPayload?: unknown;
  createdById?: string; // manual entry
  assignToId?: string; // manual entry with explicit assignee
  /** Human-readable channel for timeline/notifications; defaults to the source label. */
  channel?: string;
  /** RCRM-kept links. */
  adSourceId?: string;
  importBatchId?: string;
}

export interface IngestOptions {
  /** The stored raw webhook this enquiry came from — marked PROCESSED / DUPLICATE / FAILED. */
  webhookEventId?: string;
  /** Skip per-lead notifications (bulk import sends one summary instead). */
  silent?: boolean;
  /** Never fall back to SELF / round robin — no assignToId means unassigned (bulk import). */
  noAutoAssign?: boolean;
}

export type IngestOutcome = 'CREATED' | 'RE_ENQUIRY' | 'EXISTING';

export interface IngestResult {
  lead: Lead;
  outcome: IngestOutcome;
  assignment: AssignmentMethod | null;
}

const CREATOR_SELF_ROLES: Role[] = [Role.CALLER, Role.MANAGER];

/**
 * LeadIngestionService.ingest() — the single entry point for every lead
 * source (WhatsApp, Meta forms, generic webhook, manual entry, Excel/CSV).
 *
 * In one transaction: normalize the phone, attach a repeat enquiry to the
 * open lead for that phone (RE_ENQUIRY) or create the lead (+ attribution +
 * CREATED activity), then allocate — explicit assignee (MANUAL), creator
 * Caller/Manager (SELF), else round robin when the org allows it.
 */
@Injectable()
export class LeadIngestionService {
  private readonly logger = new Logger(LeadIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: LeadAllocationService,
    private readonly dedup: LeadDedupService,
    private readonly notifications: LeadNotificationsService,
  ) {}

  async ingest(input: IngestInput, options: IngestOptions = {}): Promise<IngestResult> {
    const phone = toE164(input.phone);
    if (!phone) {
      const error = `Invalid phone number: ${input.phone ?? '(missing)'}`;
      if (options.webhookEventId) await this.markEvent(options.webhookEventId, WebhookEventStatus.FAILED, null, error);
      throw new BadRequestException(error);
    }

    const channel = input.channel ?? formatSourceLabel(input.source);
    let roundRobinMissed = false;

    const result = await this.prisma.$transaction(
      async (tx): Promise<IngestResult> => {
        // Serializes concurrent enquiries for the same phone in this org, so
        // two parallel webhooks can't both decide "no open lead" and create two.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.orgId}:${phone}`}))`;

        if (input.sourceLeadId) {
          const same = await tx.lead.findFirst({
            where: { orgId: input.orgId, source: input.source, sourceLeadId: input.sourceLeadId },
          });
          if (same) return { lead: same, outcome: 'EXISTING', assignment: null };
        }

        const open = await this.dedup.findOpenByPhone(input.orgId, phone, tx);
        if (open) {
          const lead = await this.dedup.recordReEnquiry(tx, open, {
            source: input.source,
            channel,
            performedById: input.createdById ?? null,
            details: {
              integrationId: input.integrationId ?? null,
              sourceLeadId: input.sourceLeadId ?? null,
              name: input.name ?? null,
              requirementNotes: input.requirementNotes ?? null,
              ...(input.attribution ? { attribution: input.attribution } : {}),
              ...(input.customFields ? { customFields: input.customFields } : {}),
            },
          });
          return { lead, outcome: 'RE_ENQUIRY', assignment: null };
        }

        const previous = await this.dedup.findLatestByPhone(input.orgId, phone, tx);
        const now = new Date();
        let lead = await tx.lead.create({
          data: {
            orgId: input.orgId,
            source: input.source,
            integrationId: input.integrationId,
            sourceLeadId: input.sourceLeadId,
            name: input.name?.trim() || null,
            phone,
            altPhone: input.altPhone ? (toE164(input.altPhone) ?? input.altPhone.trim()) : null,
            email: input.email?.trim() || null,
            city: input.city?.trim() || null,
            pincode: input.pincode?.trim() || null,
            address: input.address?.trim() || null,
            // Sheets/webhooks can carry absurd amounts; drop what the column can't hold.
            estimatedValue: input.estimatedValue != null && input.estimatedValue <= MAX_MONEY ? input.estimatedValue : undefined,
            customerType: input.customerType,
            requirementNotes: input.requirementNotes?.trim() || null,
            customFields: (input.customFields ?? undefined) as Prisma.InputJsonValue | undefined,
            rawPayload: (input.rawPayload ?? undefined) as Prisma.InputJsonValue | undefined,
            createdById: input.createdById,
            previousLeadId: previous?.id,
            adSourceId: input.adSourceId,
            importBatchId: input.importBatchId,
            lastActivityAt: now,
            attribution: input.attribution ? { create: input.attribution } : undefined,
            activities: {
              create: {
                orgId: input.orgId,
                userId: input.createdById ?? null,
                type: ActivityType.CREATED,
                message: `Lead created from ${channel}`,
                meta: { source: input.source, integrationId: input.integrationId ?? null, previousLeadId: previous?.id ?? null },
              },
            },
          },
        });

        await rememberCity(tx, input.orgId, lead.city);

        const { assigneeId, method } = await this.allocate(tx, input, options.noAutoAssign ?? false);
        if (!assigneeId) {
          roundRobinMissed = method === AssignmentMethod.AUTO_ROUND_ROBIN;
          return { lead, outcome: 'CREATED', assignment: null };
        }

        lead = await tx.lead.update({
          where: { id: lead.id },
          data: { status: LeadStatus.ASSIGNED, assignedToId: assigneeId, assignedAt: now },
        });
        await tx.leadAssignment.create({
          data: {
            orgId: input.orgId,
            leadId: lead.id,
            toUserId: assigneeId,
            method: method!,
            assignedById: method === AssignmentMethod.AUTO_ROUND_ROBIN ? null : (input.createdById ?? null),
          },
        });
        await tx.leadActivityLog.create({
          data: {
            orgId: input.orgId,
            leadId: lead.id,
            userId: method === AssignmentMethod.AUTO_ROUND_ROBIN ? null : (input.createdById ?? null),
            type: ActivityType.ASSIGNED,
            message: method === AssignmentMethod.AUTO_ROUND_ROBIN ? 'Auto-assigned (round robin)' : 'Assigned on creation',
            meta: { method: method!, toUserId: assigneeId },
          },
        });
        return { lead, outcome: 'CREATED', assignment: method };
      },
      { timeout: 15_000 },
    );

    if (options.webhookEventId) {
      await this.markEvent(
        options.webhookEventId,
        result.outcome === 'CREATED' ? WebhookEventStatus.PROCESSED : WebhookEventStatus.DUPLICATE,
        result.lead.id,
      );
    }

    if (result.outcome === 'CREATED' && !options.silent) {
      await this.notifications.notifyCaptured(
        result.lead,
        channel,
        input.createdById ?? null,
        roundRobinMissed ? 'No eligible user was available for round-robin allocation — assign it manually.' : null,
      );
      if (result.lead.assignedToId) {
        await this.notifications.notifyAssigned(result.lead, {
          how: result.assignment === AssignmentMethod.AUTO_ROUND_ROBIN ? `auto-assigned from ${channel}` : 'assigned on creation',
          actorId: input.createdById ?? null,
        });
      }
    }

    this.logger.log(`ingest ${input.source} org=${input.orgId} → ${result.outcome} lead=${result.lead.id}`);
    return result;
  }

  /**
   * §5 step 4: explicit assignee → MANUAL; creator is a Caller/Manager and no
   * assignee → SELF; else ROUND_ROBIN when the org's mode allows it.
   * `method` is AUTO_ROUND_ROBIN with a null assignee when nobody was eligible.
   */
  private async allocate(
    tx: Prisma.TransactionClient,
    input: IngestInput,
    noAutoAssign: boolean,
  ): Promise<{ assigneeId: string | null; method: AssignmentMethod | null }> {
    if (input.assignToId) {
      const assignee = await tx.user.findFirst({
        where: {
          id: input.assignToId,
          orgId: input.orgId,
          status: UserStatus.ACTIVE,
          deletedAt: null,
          role: { in: LEAD_ASSIGNEE_ROLES },
        },
        select: { id: true },
      });
      if (!assignee) throw new BadRequestException('assignToId must be an active Admin, Manager or Caller in your organization');
      return { assigneeId: assignee.id, method: AssignmentMethod.MANUAL };
    }
    if (noAutoAssign) return { assigneeId: null, method: null };

    if (input.createdById) {
      const creator = await tx.user.findUnique({ where: { id: input.createdById }, select: { id: true, role: true } });
      if (creator && CREATOR_SELF_ROLES.includes(creator.role)) {
        return { assigneeId: creator.id, method: AssignmentMethod.SELF };
      }
    }

    const { allocationMode } = await this.allocation.getSettings(input.orgId, tx);
    if (allocationMode !== AllocationMode.ROUND_ROBIN) return { assigneeId: null, method: null };

    return { assigneeId: await this.allocation.pickRoundRobin(tx, input.orgId), method: AssignmentMethod.AUTO_ROUND_ROBIN };
  }

  async markEvent(id: string, status: WebhookEventStatus, leadId: string | null, error?: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status, leadId, error: error?.slice(0, 1000) ?? null, processedAt: new Date() },
    });
  }
}

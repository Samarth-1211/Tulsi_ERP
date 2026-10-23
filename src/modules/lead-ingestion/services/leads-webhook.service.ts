import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  Integration,
  IntegrationStatus,
  IntegrationType,
  LeadSource,
  Prisma,
  WebhookEventStatus,
} from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { isValidWebhookSignature } from '../../whatsapp-integration/utils/whatsapp-signature.util';
import { IncomingLeadWebhookDto } from '../dto/incoming-lead-webhook.dto';
import { IngestAttribution, IngestInput, LeadIngestionService } from './lead-ingestion.service';
import { BUYING_FOR_QUESTION_KEY, REQUIREMENT_QTY_QUESTION_KEY } from '../utils/lead-import.util';

/** Lead fields a Meta form answer can be mapped to via Integration.config.fieldMapping. */
const MAPPABLE_FIELDS = ['name', 'phone', 'email', 'city', 'pincode', 'buyingFor', 'requirementNotes', 'feedback'] as const;
/** Mapping targets of fields that were merged — older fieldMapping configs still work. */
const MERGED_TARGETS: Record<string, MappableField> = { customerType: 'buyingFor', requirementQty: 'requirementNotes', remarks: 'feedback' };
type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** Used when an integration has no fieldMapping for a Meta field — Meta's standard question keys. */
const DEFAULT_META_FIELD_MAPPING: Record<string, MappableField> = {
  full_name: 'name',
  name: 'name',
  phone_number: 'phone',
  phone: 'phone',
  email: 'email',
  city: 'city',
  zip_code: 'pincode',
  post_code: 'pincode',
  postal_code: 'pincode',
  pincode: 'pincode',
  [BUYING_FOR_QUESTION_KEY]: 'buyingFor',
  [REQUIREMENT_QTY_QUESTION_KEY]: 'requirementNotes',
};

const GRAPH_LEAD_FIELDS =
  'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform';

/** What a stored WebhookEvent.payload holds, so processing knows how to read it. */
type StoredPayload =
  | { via: 'RELAY'; body: Record<string, unknown> }
  | { via: 'META_NATIVE'; value: MetaLeadgenValue };

interface MetaLeadgenValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  created_time?: number;
}

interface MetaLeadgenPayload {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: MetaLeadgenValue }[] }[];
}

interface GraphLead {
  id: string;
  field_data?: { name: string; values?: string[] }[];
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
}

export type WebhookReceipt =
  | { status: 'received'; eventId: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'invalid'; eventId: string; errors: string[] };

/**
 * Lead webhooks from outside the CRM:
 *  - the common relay URL POST /webhooks/leads/:webhookToken (n8n / Pabbly /
 *    Zapier / Make forwarding Meta form leads, website forms)
 *  - Meta's native Lead Ads webhook POST /webhooks/meta/leadgen
 *
 * Every request is stored as a WebhookEvent first (externalId = leadgen_id;
 * a repeat is stored as DUPLICATE), answered 200 straight away, then
 * processed one at a time through LeadIngestionService.ingest().
 */
@Injectable()
export class LeadsWebhookService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeadsWebhookService.name);

  // Same in-process queue as the WhatsApp webhook: events are processed one
  // at a time, in arrival order, after the HTTP response has gone out.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly ingestion: LeadIngestionService,
  ) {}

  /** Re-queues anything that was stored but never processed (e.g. the server restarted mid-queue). */
  async onApplicationBootstrap(): Promise<void> {
    const pending = await this.prisma.webhookEvent.findMany({
      // Google Sheet rows left RECEIVED are retried by GoogleSheetSyncService on its next read.
      where: { status: WebhookEventStatus.RECEIVED, source: { notIn: [IntegrationType.WHATSAPP, IntegrationType.GOOGLE_SHEET] } },
      select: { id: true },
      orderBy: { receivedAt: 'asc' },
    });
    for (const { id } of pending) this.enqueue(id);
    if (pending.length) this.logger.log(`Re-queued ${pending.length} unprocessed lead webhook event(s)`);
  }

  findIntegrationByToken(token: string): Promise<Integration | null> {
    return this.prisma.integration.findFirst({
      where: {
        webhookToken: token,
        status: IntegrationStatus.ACTIVE,
        type: { in: [IntegrationType.META_LEAD_FORM, IntegrationType.WEBHOOK_GENERIC] },
      },
    });
  }

  // ───────────────────────── relay / generic URL ─────────────────────────

  async receiveRelay(integration: Integration, body: Record<string, unknown>): Promise<WebhookReceipt> {
    const leadgenId = typeof body?.leadgen_id === 'string' && body.leadgen_id.trim() ? body.leadgen_id.trim() : null;
    const stored = await this.store(integration, { via: 'RELAY', body }, leadgenId);
    if (stored.duplicate) return { status: 'duplicate', eventId: stored.id };

    // Cheap shape check up front so the sender (n8n, a website form) sees
    // what's wrong; the event stays on record as FAILED.
    const errors = await this.validateRelayBody(body);
    if (errors.length) {
      await this.ingestion.markEvent(stored.id, WebhookEventStatus.FAILED, null, errors.join('; '));
      return { status: 'invalid', eventId: stored.id, errors };
    }

    this.enqueue(stored.id);
    return { status: 'received', eventId: stored.id };
  }

  private async validateRelayBody(body: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(IncomingLeadWebhookDto, body ?? {});
    const errors = await validate(dto);
    return errors.flatMap((e) => Object.values(e.constraints ?? {}));
  }

  private relayToIngest(integration: Integration, body: Record<string, unknown>): IngestInput {
    const dto = plainToInstance(IncomingLeadWebhookDto, body);
    const extra = dto.extra ?? {};
    const { [BUYING_FOR_QUESTION_KEY]: _buyingFor, [REQUIREMENT_QTY_QUESTION_KEY]: _requirementQty, ...otherExtra } = extra;
    const answer = (key: string) => (typeof extra[key] === 'string' ? (extra[key] as string) : undefined);
    // Requirement and "Approx. Requirement" are one field now: both, joined, when both are sent.
    const requirement = [dto.requirement, answer(REQUIREMENT_QTY_QUESTION_KEY)].filter(Boolean).join(' · ') || undefined;
    const attribution: IngestAttribution = this.compact({
      campaignId: dto.campaign_id,
      campaignName: dto.campaign_name,
      adsetId: dto.adset_id,
      adsetName: dto.adset_name,
      adId: dto.ad_id,
      adName: dto.ad_name,
      formId: dto.form_id,
      formName: dto.form_name,
    });
    const fromMetaForm =
      integration.type === IntegrationType.META_LEAD_FORM || !!dto.leadgen_id || !!dto.form_id || !!dto.ad_id;

    return {
      orgId: integration.orgId,
      integrationId: integration.id,
      source: fromMetaForm ? LeadSource.META_LEAD_FORM : LeadSource.WEBSITE,
      sourceLeadId: dto.leadgen_id,
      name: dto.name,
      phone: dto.phone,
      email: dto.email,
      city: dto.city,
      pincode: dto.pincode,
      requirementNotes: requirement,
      // The Meta questions may also arrive among the relayed extra answers (n8n / Zapier);
      // customerType is the older name of Buying For.
      buyingFor: dto.buyingFor ?? answer(BUYING_FOR_QUESTION_KEY) ?? dto.customerType,
      customFields: Object.keys(otherExtra).length ? otherExtra : undefined,
      attribution: Object.keys(attribution).length ? { ...attribution, raw: body as Prisma.InputJsonValue } : undefined,
      rawPayload: body,
      channel: integration.name,
    };
  }

  // ───────────────────────── native Meta Lead Ads ─────────────────────────

  /** GET hub.verify_token check: META_VERIFY_TOKEN, or any Meta-form integration's own verifyToken. */
  async isValidMetaVerifyToken(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const appWide = this.config.get<string>('META_VERIFY_TOKEN');
    if (appWide && this.safeEqual(appWide, token)) return true;
    const integration = await this.prisma.integration.findFirst({
      where: { type: IntegrationType.META_LEAD_FORM, verifyToken: token },
      select: { id: true },
    });
    return !!integration;
  }

  /** X-Hub-Signature-256 over the raw body with META_APP_SECRET. Unset secret = reject (can't verify). */
  isValidMetaSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    const secret = this.config.get<string>('META_APP_SECRET');
    if (!secret) {
      this.logger.warn('META_APP_SECRET is not set — rejecting Meta leadgen webhook');
      return false;
    }
    return isValidWebhookSignature(rawBody, signature, secret);
  }

  /** Stores one event per leadgen change, routed by page_id → Integration.externalAccountId. */
  async receiveMetaLeadgen(payload: MetaLeadgenPayload): Promise<{ received: number; duplicates: number; unrouted: number }> {
    let received = 0;
    let duplicates = 0;
    let unrouted = 0;

    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen' || !change.value) continue;
        const value = change.value;
        const pageId = value.page_id ?? entry.id ?? null;
        const integration = pageId
          ? await this.prisma.integration.findFirst({
              where: { type: IntegrationType.META_LEAD_FORM, externalAccountId: pageId, status: IntegrationStatus.ACTIVE },
            })
          : null;

        const stored = await this.store(integration, { via: 'META_NATIVE', value }, value.leadgen_id ?? null);
        if (stored.duplicate) {
          duplicates++;
          continue;
        }
        if (!integration) {
          unrouted++;
          await this.ingestion.markEvent(stored.id, WebhookEventStatus.FAILED, null, `No active Meta Lead Form integration for page ${pageId}`);
          continue;
        }
        received++;
        this.enqueue(stored.id);
      }
    }
    return { received, duplicates, unrouted };
  }

  private async fetchGraphLead(integration: Integration, leadgenId: string): Promise<GraphLead> {
    if (!integration.encryptedSecrets) throw new Error('Integration has no page access token');
    const { pageAccessToken } = JSON.parse(this.encryption.decrypt(integration.encryptedSecrets)) as {
      pageAccessToken?: string;
    };
    if (!pageAccessToken) throw new Error('Integration has no page access token');

    const version = this.config.get<string>('META_GRAPH_API_VERSION', 'v25.0');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}?fields=${GRAPH_LEAD_FIELDS}&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    const json = (await res.json()) as GraphLead & { error?: { message?: string } };
    if (!res.ok || json.error) throw new Error(`Graph API: ${json.error?.message ?? res.statusText}`);
    return json;
  }

  /** Maps form answers through config.fieldMapping (then Meta's standard keys); the rest go to customFields. */
  private graphLeadToIngest(integration: Integration, value: MetaLeadgenValue, lead: GraphLead): IngestInput {
    const config = (integration.config ?? {}) as { fieldMapping?: Record<string, string> };
    const mapping = { ...DEFAULT_META_FIELD_MAPPING, ...(config.fieldMapping ?? {}) };
    const mapped: Partial<Record<MappableField, string>> = {};
    const customFields: Record<string, unknown> = {};

    for (const field of lead.field_data ?? []) {
      const answer = (field.values ?? []).join(', ').trim();
      const target = (MERGED_TARGETS[mapping[field.name]] ?? mapping[field.name]) as MappableField | undefined;
      if (target && (MAPPABLE_FIELDS as readonly string[]).includes(target) && !mapped[target]) mapped[target] = answer;
      else customFields[field.name] = answer;
    }

    return {
      orgId: integration.orgId,
      integrationId: integration.id,
      source: LeadSource.META_LEAD_FORM,
      sourceLeadId: lead.id,
      name: mapped.name,
      phone: mapped.phone ?? '',
      email: mapped.email,
      city: mapped.city,
      pincode: mapped.pincode,
      buyingFor: mapped.buyingFor,
      requirementNotes: mapped.requirementNotes,
      feedback: mapped.feedback,
      customFields: Object.keys(customFields).length ? customFields : undefined,
      attribution: {
        ...this.compact({
          campaignId: lead.campaign_id,
          campaignName: lead.campaign_name,
          adsetId: lead.adset_id ?? value.adgroup_id,
          adsetName: lead.adset_name,
          adId: lead.ad_id ?? value.ad_id,
          adName: lead.ad_name,
          formId: lead.form_id ?? value.form_id,
          pageId: value.page_id,
        }),
        raw: { webhook: value, lead } as unknown as Prisma.InputJsonValue,
      },
      rawPayload: { webhook: value, lead },
      channel: integration.name,
    };
  }

  // ───────────────────────── shared plumbing ─────────────────────────

  /**
   * Stores the raw event. A repeat externalId (Meta retry) hits
   * @@unique([source, externalId]); it is then kept as its own DUPLICATE row
   * (externalId null) pointing at the original's lead.
   */
  private async store(
    integration: Integration | null,
    payload: StoredPayload,
    externalId: string | null,
  ): Promise<{ id: string; duplicate: boolean }> {
    const source = integration?.type ?? IntegrationType.META_LEAD_FORM;
    const base = {
      orgId: integration?.orgId ?? null,
      integrationId: integration?.id ?? null,
      source,
      payload: payload as unknown as Prisma.InputJsonValue,
    };

    try {
      const event = await this.prisma.webhookEvent.create({ data: { ...base, externalId } });
      if (integration) {
        await this.prisma.integration.update({ where: { id: integration.id }, data: { lastEventAt: new Date() } });
      }
      return { id: event.id, duplicate: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const original = await this.prisma.webhookEvent.findUnique({
        where: { source_externalId: { source, externalId: externalId! } },
      });
      const duplicate = await this.prisma.webhookEvent.create({
        data: {
          ...base,
          externalId: null,
          status: WebhookEventStatus.DUPLICATE,
          leadId: original?.leadId ?? null,
          error: `Duplicate of event ${original?.id} (externalId ${externalId})`,
          processedAt: new Date(),
        },
      });
      return { id: duplicate.id, duplicate: true };
    }
  }

  private enqueue(eventId: string): void {
    this.queue = this.queue.then(() => this.process(eventId)).catch(() => undefined);
  }

  /** Processes one stored event; never throws — failures are recorded on the event. */
  async process(eventId: string): Promise<void> {
    const event = await this.prisma.webhookEvent.findUnique({ where: { id: eventId }, include: { integration: true } });
    if (!event || event.status !== WebhookEventStatus.RECEIVED) return;

    try {
      if (!event.integration) throw new Error('Event has no integration');
      const payload = event.payload as unknown as StoredPayload;

      const input =
        payload.via === 'META_NATIVE'
          ? this.graphLeadToIngest(
              event.integration,
              payload.value,
              await this.fetchGraphLead(event.integration, payload.value.leadgen_id ?? ''),
            )
          : this.relayToIngest(event.integration, payload.body);

      await this.ingestion.ingest(input, { webhookEventId: event.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Lead webhook event ${eventId} failed: ${message}`);
      const current = await this.prisma.webhookEvent.findUnique({ where: { id: eventId }, select: { status: true } });
      if (current?.status === WebhookEventStatus.RECEIVED) {
        await this.ingestion.markEvent(eventId, WebhookEventStatus.FAILED, null, message);
      }
    }
  }

  private compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
  }

  private safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}

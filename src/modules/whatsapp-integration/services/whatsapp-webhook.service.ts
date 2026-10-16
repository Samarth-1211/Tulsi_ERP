import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  LeadSource,
  Prisma,
  WhatsAppIntegration,
  WhatsAppIntegrationStatus,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
  WhatsAppWebhookEventStatus,
} from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { CLOSED_LEAD_STATUSES } from '../../lead-ingestion/services/lead-dedup.service';
import { LeadIngestionService } from '../../lead-ingestion/services/lead-ingestion.service';
import { MetaWhatsAppClientService } from './meta-whatsapp-client.service';
import { MAX_WHATSAPP_MEDIA_BYTES, WhatsAppMediaStorageService } from './whatsapp-media-storage.service';
import { describeAd, WhatsAppAdSourceService } from './whatsapp-ad-source.service';
import { isValidWebhookSignature } from '../utils/whatsapp-signature.util';
import {
  extractAdReferral,
  extractContent,
  mapMetaStatus,
  MetaMessage,
  MetaStatus,
  MetaWebhookPayload,
  MetaWebhookValue,
  nextMessageStatus,
  referralAttribution,
  summarizeWebhookPayload,
} from '../utils/whatsapp-payload.util';

const DEFAULT_EVENT_RETENTION_DAYS = 14;

/** What processing one webhook POST found: failures mark the event FAILED, notes are informational. */
export interface WebhookProcessingResult {
  failures: string[];
  notes: string[];
}

@Injectable()
export class WhatsAppWebhookService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  // Events are processed one at a time, in arrival order: two messages from
  // a brand-new number can't race each other into creating two leads, and
  // statuses can't overtake the message they're about.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly metaClient: MetaWhatsAppClientService,
    private readonly mediaStorage: WhatsAppMediaStorageService,
    private readonly ingestion: LeadIngestionService,
    private readonly adSources: WhatsAppAdSourceService,
  ) {}

  findBySlug(slug: string): Promise<WhatsAppIntegration | null> {
    return this.prisma.whatsAppIntegration.findUnique({ where: { webhookSlug: slug } });
  }

  /** Constant-time comparison — the verify token doubles as a shared secret during the handshake. */
  isVerifyTokenValid(integration: WhatsAppIntegration, providedToken: string): boolean {
    const expected = Buffer.from(integration.verifyToken);
    const actual = Buffer.from(providedToken ?? '');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Called once the GET handshake succeeds — this is what flips Pending -> Connected. */
  async markVerified(integrationId: string): Promise<void> {
    await this.prisma.whatsAppIntegration.update({
      where: { id: integrationId },
      data: { status: WhatsAppIntegrationStatus.CONNECTED, verifiedAt: new Date(), lastError: null },
    });
  }

  /**
   * The App Secret webhook signatures are checked with: the integration's
   * own, else the app-wide META_APP_SECRET, else null (nothing to check
   * with). Throws if a stored secret can't be decrypted — callers treat that
   * as a failed check, never as "no secret".
   */
  resolveAppSecret(integration: WhatsAppIntegration): string | null {
    if (integration.appSecretEncrypted) return this.encryption.decrypt(integration.appSecretEncrypted);
    return this.config.get<string>('META_APP_SECRET') || null;
  }

  /**
   * Entry point for every webhook POST: checks the signature, stores the raw
   * event, and queues the real work — so Meta gets its 200 in milliseconds
   * no matter how slow lead allocation or media downloads are. Returns
   * `accepted: false` only for a bad signature (the controller answers 401).
   */
  async receive(
    integration: WhatsAppIntegration,
    rawBody: Buffer | undefined,
    payload: MetaWebhookPayload,
    signatureHeader: string | undefined,
  ): Promise<{ accepted: boolean; signatureValid: boolean | null }> {
    let signatureValid: boolean | null;
    let signatureError: string | null = null;
    try {
      const secret = this.resolveAppSecret(integration);
      signatureValid = secret ? isValidWebhookSignature(rawBody, signatureHeader, secret) : null;
      if (signatureValid === false) {
        signatureError = signatureHeader
          ? 'Rejected: X-Hub-Signature-256 does not match the App Secret'
          : 'Rejected: X-Hub-Signature-256 header missing';
      }
    } catch {
      signatureValid = false;
      signatureError = 'Rejected: the stored App Secret could not be decrypted — re-enter it on the Integrations page';
    }

    const summary = summarizeWebhookPayload(payload);
    const ignoredReason = signatureError ?? (integration.isActive ? null : 'Ignored: WhatsApp integration is disabled');

    const event = await this.prisma.whatsAppWebhookEvent.create({
      data: {
        orgId: integration.orgId,
        integrationId: integration.id,
        signatureValid,
        object: summary.object,
        phoneNumberId: summary.phoneNumberId,
        eventType: summary.eventType,
        rawPayload: (payload ?? {}) as Prisma.InputJsonValue,
        processingStatus: ignoredReason ? WhatsAppWebhookEventStatus.IGNORED : WhatsAppWebhookEventStatus.PENDING,
        errorMessage: ignoredReason,
        processedAt: ignoredReason ? new Date() : null,
      },
    });

    if (signatureValid === null) {
      this.logger.warn(
        `WhatsApp webhook event ${event.id} accepted WITHOUT signature check — set an App Secret for org ${integration.orgId} (or META_APP_SECRET)`,
      );
    }

    if (!ignoredReason) this.enqueue(event.id);

    return { accepted: signatureValid !== false, signatureValid };
  }

  /** Queues a stored event for processing; failures are recorded on the event, never thrown. */
  enqueue(eventId: string): void {
    this.queue = this.queue
      .then(() => this.processEvent(eventId))
      .catch((err) => this.logger.error(`WhatsApp webhook event ${eventId} crashed: ${err}`));
  }

  /** Resolves once everything queued so far has been processed — used by tests and the simulator. */
  drain(): Promise<void> {
    return this.queue;
  }

  async processEvent(eventId: string): Promise<void> {
    const event = await this.prisma.whatsAppWebhookEvent.findUnique({
      where: { id: eventId },
      include: { integration: true },
    });
    if (!event || event.processingStatus !== WhatsAppWebhookEventStatus.PENDING) return;

    let status: WhatsAppWebhookEventStatus;
    let errorMessage: string | null;
    try {
      const { failures, notes } = await this.handleEvent(event.integration, event.rawPayload as MetaWebhookPayload);
      status = failures.length ? WhatsAppWebhookEventStatus.FAILED : WhatsAppWebhookEventStatus.PROCESSED;
      errorMessage = [...failures, ...notes].join(' | ') || null;
    } catch (err) {
      status = WhatsAppWebhookEventStatus.FAILED;
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (status === WhatsAppWebhookEventStatus.FAILED) {
      this.logger.error(`WhatsApp webhook event ${eventId} failed: ${errorMessage}`);
    }

    await this.prisma.whatsAppWebhookEvent.update({
      where: { id: eventId },
      data: { processingStatus: status, errorMessage: errorMessage?.slice(0, 2000) ?? null, processedAt: new Date() },
    });
  }

  /**
   * Applies one webhook payload. Each message/status is handled on its own —
   * one bad item is recorded as a failure without blocking the rest, and an
   * unknown payload shape is simply skipped.
   */
  async handleEvent(integration: WhatsAppIntegration, payload: MetaWebhookPayload): Promise<WebhookProcessingResult> {
    const failures: string[] = [];
    const notes: string[] = [];

    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') {
          notes.push(`Skipped "${change.field}" change (only "messages" is handled)`);
          continue;
        }
        const value = change.value;
        if (!value) continue;

        // The slug picked the integration; the payload must agree about
        // which business number it's for, or it isn't ours to apply.
        const phoneNumberId = value.metadata?.phone_number_id;
        if (phoneNumberId && phoneNumberId !== integration.phoneNumberId) {
          failures.push(
            `phone_number_id ${phoneNumberId} doesn't match this integration's number (${integration.phoneNumberId}) — change skipped`,
          );
          continue;
        }

        for (const message of value.messages ?? []) {
          try {
            const result = await this.ingestInboundMessage(integration, value, message);
            if (result.duplicate) notes.push(`Duplicate message ${message.id} skipped`);
            if (result.mediaError) notes.push(`Media for ${message.id} not stored: ${result.mediaError}`);
          } catch (err) {
            failures.push(`Message ${message.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
        for (const status of value.statuses ?? []) {
          try {
            const applied = await this.applyStatusUpdate(status);
            if (!applied) notes.push(`Status "${status.status}" for unknown message ${status.id} ignored`);
          } catch (err) {
            failures.push(`Status ${status.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    return { failures, notes };
  }

  async ingestInboundMessage(
    integration: WhatsAppIntegration,
    value: MetaWebhookValue,
    message: MetaMessage,
  ): Promise<{ duplicate: boolean; mediaError?: string }> {
    if (message.id) {
      const existing = await this.prisma.whatsAppMessage.findUnique({ where: { waMessageId: message.id } });
      if (existing) return { duplicate: true }; // webhook retry — already logged
    }

    // wa_id is digits only (E.164 without the +); stored with the + everywhere.
    const waId = String(message.from ?? '').replace(/\D/g, '');
    if (!waId) throw new Error('Message has no sender (from)');
    const phone = `+${waId}`;
    const contact = value.contacts?.find((c) => c.wa_id === message.from) ?? value.contacts?.[0];
    const profileName = contact?.profile?.name;

    const content = extractContent(message);
    const lead = await this.findOrCreateLead(integration, phone, profileName, message);

    let created;
    try {
      created = await this.prisma.whatsAppMessage.create({
        data: {
          orgId: integration.orgId,
          integrationId: integration.id,
          leadId: lead.id,
          waMessageId: message.id,
          direction: WhatsAppMessageDirection.INBOUND,
          fromPhone: phone,
          toPhone: integration.displayPhoneNumber ?? integration.phoneNumberId,
          messageType: content.messageType,
          textBody: content.textBody,
          mediaId: content.mediaId,
          mediaMimeType: content.mediaMimeType,
          mediaFileName: content.mediaFileName,
          phoneNumberId: value.metadata?.phone_number_id ?? integration.phoneNumberId,
          rawPayload: { message, contact: contact ?? null } as unknown as Prisma.InputJsonValue,
          status: WhatsAppMessageStatus.DELIVERED,
          waTimestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
        },
      });
    } catch (err) {
      // Lost a race with a concurrent retry of the same message — the unique
      // waMessageId already did the deduping.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { duplicate: true };
      throw err;
    }

    await this.prisma.whatsAppIntegration.update({
      where: { id: integration.id },
      data: { lastInboundAt: new Date() },
    });

    const mediaError = content.mediaId
      ? await this.storeMedia(integration, created.id, content.mediaId, content.mediaMimeType)
      : null;

    return { duplicate: false, ...(mediaError ? { mediaError } : {}) };
  }

  /**
   * Copies an inbound attachment into our own storage: GET /{media-id} gives
   * a URL valid for ~5 minutes, which is then downloaded with the same token.
   * Returns the failure reason (also saved on the message), or null.
   */
  private async storeMedia(
    integration: WhatsAppIntegration,
    messageId: string,
    mediaId: string,
    mimeType: string | undefined,
  ): Promise<string | null> {
    try {
      const accessToken = this.encryption.decrypt(integration.accessTokenEncrypted);
      const info = await this.metaClient.fetchMediaInfo(mediaId, accessToken);
      if (info.file_size && info.file_size > MAX_WHATSAPP_MEDIA_BYTES) {
        throw new Error(`file is ${Math.round(info.file_size / 1024 / 1024)} MB, over the limit`);
      }
      const res = await this.metaClient.downloadMedia(info.url, accessToken);
      const effectiveMime = info.mime_type ?? mimeType;
      const { key, size } = await this.mediaStorage.save(res.body!, effectiveMime);

      await this.prisma.whatsAppMessage.update({
        where: { id: messageId },
        data: { mediaStorageKey: key, mediaSize: size, mediaMimeType: effectiveMime, mediaError: null },
      });
      return null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not store WhatsApp media ${mediaId} for message ${messageId}: ${reason}`);
      await this.prisma.whatsAppMessage.update({ where: { id: messageId }, data: { mediaError: reason.slice(0, 500) } });
      return reason;
    }
  }

  /**
   * Every inbound message from the same person lands on the same Lead. A
   * number whose open lead already has a WhatsApp thread just keeps chatting
   * on it. Anything else — a new number, the first WhatsApp contact from
   * someone already in the CRM, a closed lead writing again, or a fresh ad
   * click — goes through LeadIngestionService.ingest() (§5): it creates the
   * lead (WHATSAPP_CTWA with ad attribution, or WHATSAPP_ORGANIC) or records
   * a re-enquiry on the open one. The thread's assignee is the lead's.
   */
  private async findOrCreateLead(
    integration: WhatsAppIntegration,
    phone: string,
    profileName: string | undefined,
    message: MetaMessage,
  ) {
    const { orgId } = integration;
    const referral = extractAdReferral(message);
    const adSource = referral ? await this.adSources.record(orgId, referral) : null;

    if (!referral) {
      const open = await this.prisma.lead.findFirst({
        where: { orgId, phone, deletedAt: null, status: { notIn: CLOSED_LEAD_STATUSES } },
        orderBy: { createdAt: 'asc' },
      });
      if (open) {
        const hasThread = await this.prisma.whatsAppMessage.findFirst({ where: { leadId: open.id }, select: { id: true } });
        if (hasThread) return open;
      }
    }

    const attribution = referralAttribution(message);
    const { lead } = await this.ingestion.ingest({
      orgId,
      source: referral ? LeadSource.WHATSAPP_CTWA : LeadSource.WHATSAPP_ORGANIC,
      sourceLeadId: message.id,
      name: profileName,
      phone,
      adSourceId: adSource?.id,
      attribution: attribution
        ? { ...attribution, raw: attribution.raw as Prisma.InputJsonValue }
        : undefined,
      rawPayload: { message },
      channel: adSource ? describeAd(adSource) : 'WhatsApp',
    });
    return lead;
  }

  /** Returns false when the status is for a message we never stored (e.g. sent from Meta's own test tools). */
  async applyStatusUpdate(status: MetaStatus): Promise<boolean> {
    const message = await this.prisma.whatsAppMessage.findUnique({ where: { waMessageId: status.id } });
    if (!message) return false;

    const incoming = mapMetaStatus(status.status);
    const error = status.errors?.[0];
    const errorDetail = error ? [error.title ?? error.message, error.error_data?.details].filter(Boolean).join(' — ') : null;

    await this.prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        status: nextMessageStatus(message.status, incoming),
        errorCode: error ? String(error.code) : message.errorCode,
        errorMessage: errorDetail ?? message.errorMessage,
      },
    });

    if (incoming !== WhatsAppMessageStatus.FAILED) {
      await this.prisma.whatsAppIntegration.update({
        where: { id: message.integrationId },
        data: { lastOutboundAt: new Date() },
      });
    }
    return true;
  }

  /** Events still PENDING were cut off by a restart — pick them back up. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const pending = await this.prisma.whatsAppWebhookEvent.findMany({
        where: { processingStatus: WhatsAppWebhookEventStatus.PENDING },
        orderBy: { receivedAt: 'asc' },
        select: { id: true },
        take: 500,
      });
      pending.forEach((e) => this.enqueue(e.id));
      if (pending.length) this.logger.log(`Re-queued ${pending.length} unprocessed WhatsApp webhook event(s)`);
    } catch (err) {
      this.logger.error(`Could not re-queue pending WhatsApp webhook events: ${err}`);
    }
  }

  /** Daily retention purge of the raw webhook log. */
  @Cron('30 3 * * *')
  async purgeOldEvents(): Promise<void> {
    const days = Number(this.config.get('WHATSAPP_WEBHOOK_EVENT_RETENTION_DAYS')) || DEFAULT_EVENT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.whatsAppWebhookEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    if (count) this.logger.log(`Purged ${count} WhatsApp webhook event(s) older than ${days} days`);
  }
}

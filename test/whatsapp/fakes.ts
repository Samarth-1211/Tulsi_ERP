import { randomUUID } from 'crypto';
import { Prisma, WhatsAppIntegration, WhatsAppIntegrationStatus } from '@prisma/client';
import { WhatsAppWebhookService } from '../../src/modules/whatsapp-integration/services/whatsapp-webhook.service';
import { MetaReferral, MetaStatus, MetaWebhookPayload } from '../../src/modules/whatsapp-integration/utils/whatsapp-payload.util';

export const APP_SECRET = '0123456789abcdef0123456789abcdef';

export function makeIntegration(overrides: Partial<WhatsAppIntegration> = {}): WhatsAppIntegration {
  return {
    id: 'int-1',
    orgId: 'org-1',
    wabaId: 'waba-1',
    phoneNumberId: '1111111111',
    displayPhoneNumber: '+911234567890',
    businessName: 'Test Realty',
    businessManagerId: null,
    accessTokenEncrypted: 'enc:access-token',
    appSecretEncrypted: `enc:${APP_SECRET}`,
    webhookSlug: 'slug-abcdef',
    verifyToken: 'verify-token-123',
    status: WhatsAppIntegrationStatus.CONNECTED,
    verifiedAt: new Date(),
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

/**
 * Just enough of PrismaService, in memory, for the WhatsApp webhook paths.
 * `failNextMessageCreateWithP2002` simulates losing a race on the unique
 * waMessageId constraint.
 */
export class FakePrisma {
  integrations: WhatsAppIntegration[] = [];
  events: Row[] = [];
  messages: Row[] = [];
  leads: Row[] = [];
  activityLogs: Row[] = [];
  failNextMessageCreateWithP2002 = false;

  whatsAppIntegration = {
    findUnique: async ({ where }: { where: Row }) => this.integrations.find((i) => matches(i as Row, where)) ?? null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = this.integrations.find((i) => matches(i as Row, where))!;
      Object.assign(row, data);
      return row;
    },
  };

  whatsAppWebhookEvent = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), receivedAt: new Date(), ...data };
      this.events.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) => {
      const row = this.events.find((e) => e.id === where.id);
      return row ? { ...row, integration: this.integrations.find((i) => i.id === row.integrationId) } : null;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(this.events.find((e) => e.id === where.id)!, data),
    findMany: async () => [],
  };

  whatsAppMessage = {
    findUnique: async ({ where }: { where: Row }) => this.messages.find((m) => matches(m, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) => this.messages.find((m) => matches(m, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (this.failNextMessageCreateWithP2002) {
        this.failNextMessageCreateWithP2002 = false;
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      }
      const row = { id: randomUUID(), createdAt: new Date(), errorCode: null, errorMessage: null, ...data };
      this.messages.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(this.messages.find((m) => m.id === where.id)!, data),
  };

  lead = {
    // findOrCreateLead looks up the open lead for a phone (closed statuses excluded).
    findFirst: async ({ where }: { where: Row }) =>
      this.leads.find((l) => l.orgId === where.orgId && l.phone === where.phone && !['CONVERTED', 'LOST'].includes(l.status)) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...data };
      this.leads.push(row);
      return row;
    },
  };

  leadActivityLog = {
    create: async ({ data }: { data: Row }) => {
      this.activityLogs.push(data);
      return data;
    },
  };
}

/** What LeadIngestionService.ingest() and the ad-source recorder were asked. */
export class RoutingStubs {
  /** The lead's assignee, as ingest() would allocate it. */
  assigneeId: string | null = 'user-1';

  recordedAds: Row[] = [];
  ingested: Row[] = [];
}

/** A real WhatsAppWebhookService over FakePrisma, with every other collaborator stubbed. */
export function makeWebhookService(prisma: FakePrisma, env: Record<string, string> = {}, routing = new RoutingStubs()) {
  const config = { get: (key: string) => env[key] };
  const encryption = { decrypt: (value: string) => value.replace(/^enc:/, '') };
  const metaClient = {
    fetchMediaInfo: async () => ({ url: 'https://lookaside.example/media', mime_type: 'image/jpeg', file_size: 10 }),
    downloadMedia: async () => ({ body: null }),
  };
  const mediaStorage = { save: async () => ({ key: `${randomUUID()}.jpg`, size: 10 }) };
  // Stands in for LeadIngestionService.ingest(): creates the lead in FakePrisma, or
  // returns the open lead for the phone (a re-enquiry).
  const ingestion = {
    ingest: async (input: Row) => {
      routing.ingested.push(input);
      const open = await prisma.lead.findFirst({ where: { orgId: input.orgId, phone: input.phone } });
      if (open) return { lead: open, outcome: 'RE_ENQUIRY', assignment: null };
      const lead = await prisma.lead.create({
        data: {
          orgId: input.orgId,
          source: input.source,
          sourceLeadId: input.sourceLeadId,
          name: input.name ?? null,
          phone: input.phone,
          adSourceId: input.adSourceId ?? null,
          status: routing.assigneeId ? 'ASSIGNED' : 'NEW',
          assignedToId: routing.assigneeId,
        },
      });
      return { lead, outcome: 'CREATED', assignment: routing.assigneeId ? 'AUTO_ROUND_ROBIN' : null };
    },
  };
  const adSources = {
    record: async (orgId: string, referral: Row) => {
      const row = { id: `ad-source-${referral.adId}`, orgId, ...referral };
      routing.recordedAds.push(row);
      return row;
    },
  };

  return new WhatsAppWebhookService(
    prisma as never,
    config as never,
    encryption as never,
    metaClient as never,
    mediaStorage as never,
    ingestion as never,
    adSources as never,
  );
}

/** A realistic Cloud API webhook body: one inbound message and/or statuses. */
export function inboundTextPayload(
  opts: { wamid?: string; from?: string; text?: string; phoneNumberId?: string; referral?: MetaReferral } = {},
): MetaWebhookPayload {
  const from = opts.from ?? '919812345678';
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '911234567890', phone_number_id: opts.phoneNumberId ?? '1111111111' },
              contacts: [{ profile: { name: 'Asha Verma' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: opts.wamid ?? 'wamid.TEST1',
                  timestamp: '1759500000',
                  type: 'text',
                  text: { body: opts.text ?? 'Is the 3BHK still available?' },
                  ...(opts.referral ? { referral: opts.referral } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(wamid: string, status: string, errors?: MetaStatus['errors']): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '911234567890', phone_number_id: '1111111111' },
              statuses: [{ id: wamid, status, timestamp: '1759500100', recipient_id: '919812345678', ...(errors ? { errors } : {}) }],
            },
          },
        ],
      },
    ],
  };
}

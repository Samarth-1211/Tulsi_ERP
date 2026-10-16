import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  WhatsAppIntegration,
  WhatsAppIntegrationStatus,
  WhatsAppMessageDirection,
  WhatsAppWebhookEventStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { MetaRawResponse, MetaWhatsAppClientService } from './meta-whatsapp-client.service';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import { signWebhookBody } from '../utils/whatsapp-signature.util';
import { inboundMessageIds, MetaWebhookPayload } from '../utils/whatsapp-payload.util';
import { DebugEventFilter, SendTestMessageDto, SimulateInboundDto } from '../dto/whatsapp-debug.dto';

type CheckStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  reason: string;
  details?: Record<string, unknown>;
}

type TraceStatus = CheckStatus | 'skipped';

interface MetaGraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'];
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function graphError(body: unknown): string {
  const err = (body as MetaGraphError)?.error;
  if (!err) return 'Graph request failed';
  return `${err.error_data?.details || err.message || 'Graph error'}${err.code ? ` (code ${err.code})` : ''}`;
}

/**
 * Backs the admin-only WhatsApp Debug Console. Every Graph call uses the
 * org's stored token server-side; nothing returned here contains the access
 * token, App Secret or verify token.
 */
@Injectable()
export class WhatsAppDebugService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly metaClient: MetaWhatsAppClientService,
    private readonly webhookService: WhatsAppWebhookService,
    private readonly messagingService: WhatsAppMessagingService,
  ) {}

  private async getIntegration(orgId: string): Promise<WhatsAppIntegration> {
    const integration = await this.prisma.whatsAppIntegration.findUnique({ where: { orgId } });
    if (!integration) {
      throw new NotFoundException('WhatsApp is not connected for this organization yet — connect it on the Integrations page first');
    }
    return integration;
  }

  private webhookUrl(integration: WhatsAppIntegration): string | null {
    const base = this.config.get<string>('WEBHOOK_BASE_URL');
    return base ? `${base.replace(/\/+$/, '')}/webhooks/whatsapp/${integration.webhookSlug}` : null;
  }

  simulateEnabled(): boolean {
    const flag = this.config.get<string>('WHATSAPP_DEBUG_SIMULATE_ENABLED');
    if (flag !== undefined && flag !== '') return flag === 'true';
    return this.config.get<string>('NODE_ENV') !== 'production';
  }

  // ---------------------------------------------------------------- health

  async health(actor: AuthenticatedUser) {
    const integration = await this.prisma.whatsAppIntegration.findUnique({
      where: { orgId: actor.orgId },
    });

    const checks: HealthCheck[] = [this.checkConfig(integration)];

    if (!integration) {
      checks.push({
        id: 'integration',
        label: 'WhatsApp integration',
        status: 'fail',
        reason: 'No WhatsApp integration saved for this organization — connect it on the Integrations page.',
      });
      return this.healthResponse(checks);
    }

    let accessToken: string | null = null;
    try {
      accessToken = this.encryption.decrypt(integration.accessTokenEncrypted);
    } catch {
      checks.push({
        id: 'token',
        label: 'Access token',
        status: 'fail',
        reason: 'The stored access token could not be decrypted (CREDENTIALS_ENCRYPTION_KEY changed?) — re-enter it on the Integrations page.',
      });
    }

    if (accessToken) {
      const [token, phone, numbers, subscription] = await Promise.all([
        this.checkToken(integration, accessToken),
        this.checkPhoneNumber(integration, accessToken),
        this.checkWabaNumbers(integration, accessToken),
        this.checkSubscription(integration, accessToken),
      ]);
      checks.push(token, phone, numbers, subscription);
    }

    checks.push(this.checkVerification(integration), await this.checkLastWebhook(integration), await this.checkCallbackUrl(integration));

    return this.healthResponse(checks);
  }

  private healthResponse(checks: HealthCheck[]) {
    return {
      checkedAt: new Date(),
      graphApiVersion: this.metaClient.apiVersion,
      simulateEnabled: this.simulateEnabled(),
      checks,
    };
  }

  /** Names and present/missing only — values never leave the server. */
  private checkConfig(integration: WhatsAppIntegration | null): HealthCheck {
    const env = (name: string) => !!this.config.get<string>(name);
    const hasOrgSecret = !!integration?.appSecretEncrypted;

    const vars = [
      { name: 'CREDENTIALS_ENCRYPTION_KEY', scope: 'env', required: true, present: env('CREDENTIALS_ENCRYPTION_KEY') },
      { name: 'WEBHOOK_BASE_URL', scope: 'env', required: true, present: env('WEBHOOK_BASE_URL') },
      { name: 'META_GRAPH_API_VERSION', scope: 'env', required: false, present: env('META_GRAPH_API_VERSION') },
      { name: 'META_APP_SECRET', scope: 'env', required: !hasOrgSecret, present: env('META_APP_SECRET') },
      { name: 'META_APP_ID', scope: 'env', required: false, present: env('META_APP_ID') },
      { name: 'WABA ID', scope: 'integration', required: true, present: !!integration?.wabaId },
      { name: 'Phone Number ID', scope: 'integration', required: true, present: !!integration?.phoneNumberId },
      { name: 'Access token', scope: 'integration', required: true, present: !!integration?.accessTokenEncrypted },
      { name: 'App Secret', scope: 'integration', required: false, present: hasOrgSecret },
    ];

    const missingRequired = vars.filter((v) => v.required && !v.present).map((v) => v.name);
    const noSecret = !hasOrgSecret && !env('META_APP_SECRET');

    return {
      id: 'config',
      label: 'Configuration',
      status: missingRequired.length ? 'fail' : noSecret ? 'warn' : 'pass',
      reason: missingRequired.length
        ? `Missing: ${missingRequired.join(', ')}`
        : noSecret
          ? 'No App Secret anywhere — webhook signatures are NOT being checked. Add it on the Integrations page or set META_APP_SECRET.'
          : 'All required settings are present.',
      details: { vars },
    };
  }

  private async checkToken(integration: WhatsAppIntegration, accessToken: string): Promise<HealthCheck> {
    const appId = this.config.get<string>('META_APP_ID');
    let appSecret: string | null = null;
    try {
      appSecret = this.webhookService.resolveAppSecret(integration);
    } catch {
      appSecret = null;
    }
    // debug_token is best asked with an app token; a token can also inspect itself.
    const inspector = appId && appSecret ? `${appId}|${appSecret}` : accessToken;

    try {
      const res = await this.metaClient.requestRaw(
        `/debug_token?input_token=${encodeURIComponent(accessToken)}`,
        inspector,
      );
      const data = (res.body as { data?: Record<string, unknown> })?.data;

      if (!res.ok || !data) {
        // Fall back to the simplest "does this token work at all" call.
        const me = await this.metaClient.requestRaw('/me?fields=id,name', accessToken);
        return me.ok
          ? { id: 'token', label: 'Access token', status: 'pass', reason: 'Token works (GET /me succeeded; debug_token was unavailable).', details: { me: me.body } }
          : { id: 'token', label: 'Access token', status: 'fail', reason: `Token rejected by Meta: ${graphError(me.body)}` };
      }

      const scopes = (data.scopes as string[] | undefined) ?? [];
      const expiresAt = Number(data.expires_at ?? 0);
      const granular = (data.granular_scopes as { scope: string; target_ids?: string[] }[] | undefined) ?? [];
      const details = {
        type: data.type ?? null,
        application: data.application ?? null,
        appId: data.app_id ?? null,
        expiresAt: expiresAt ? new Date(expiresAt * 1000) : 'never',
        scopes,
      };

      if (!data.is_valid) {
        const err = (data.error as { message?: string } | undefined)?.message;
        return { id: 'token', label: 'Access token', status: 'fail', reason: `Token is invalid or expired${err ? `: ${err}` : ''}`, details };
      }

      const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      if (missing.length) {
        return { id: 'token', label: 'Access token', status: 'fail', reason: `Insufficient permissions — missing ${missing.join(', ')}`, details };
      }

      const wabaTargets = granular.find((g) => g.scope === 'whatsapp_business_management')?.target_ids;
      if (wabaTargets?.length && !wabaTargets.includes(integration.wabaId)) {
        return {
          id: 'token',
          label: 'Access token',
          status: 'fail',
          reason: `Token isn't granted access to WABA ${integration.wabaId} — assign the WABA to the System User in Business Settings`,
          details,
        };
      }

      if (expiresAt) {
        return {
          id: 'token',
          label: 'Access token',
          status: 'warn',
          reason: `Valid, but temporary — expires ${new Date(expiresAt * 1000).toISOString()}. Replace it with a permanent System User token.`,
          details,
        };
      }

      return {
        id: 'token',
        label: 'Access token',
        status: 'pass',
        reason: `Valid${data.type ? ` ${data.type}` : ''} token, never expires, has WhatsApp permissions.`,
        details,
      };
    } catch (err) {
      return { id: 'token', label: 'Access token', status: 'fail', reason: `Could not reach Meta: ${err instanceof Error ? err.message : err}` };
    }
  }

  private async graph(path: string, accessToken: string, init?: RequestInit): Promise<MetaRawResponse> {
    try {
      return await this.metaClient.requestRaw(path, accessToken, init);
    } catch (err) {
      return { ok: false, status: 0, body: { error: { message: `Could not reach Meta: ${err instanceof Error ? err.message : err}` } } };
    }
  }

  private async checkPhoneNumber(integration: WhatsAppIntegration, accessToken: string): Promise<HealthCheck> {
    const res = await this.graph(
      `/${integration.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput`,
      accessToken,
    );
    if (!res.ok) {
      return {
        id: 'phone',
        label: 'Phone number',
        status: 'fail',
        reason: `Phone Number ID ${integration.phoneNumberId} could not be read: ${graphError(res.body)}`,
      };
    }

    const phone = res.body as Record<string, unknown>;
    if (phone.platform_type && phone.platform_type !== 'CLOUD_API') {
      return {
        id: 'phone',
        label: 'Phone number',
        status: 'fail',
        reason: `Number isn't registered on the Cloud API (platform_type=${phone.platform_type}) — register it: POST /${integration.phoneNumberId}/register with your 2-step PIN.`,
        details: phone,
      };
    }
    return {
      id: 'phone',
      label: 'Phone number',
      status: phone.code_verification_status === 'VERIFIED' ? 'pass' : 'warn',
      reason:
        phone.code_verification_status === 'VERIFIED'
          ? `${phone.display_phone_number} (${phone.verified_name}) is on the Cloud API.`
          : `${phone.display_phone_number}: code_verification_status is ${phone.code_verification_status} — finish verifying it in WhatsApp Manager.`,
      details: phone,
    };
  }

  private async checkWabaNumbers(integration: WhatsAppIntegration, accessToken: string): Promise<HealthCheck> {
    const res = await this.graph(
      `/${integration.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type`,
      accessToken,
    );
    if (!res.ok) {
      return { id: 'waba-numbers', label: 'WABA phone numbers', status: 'fail', reason: `WABA ${integration.wabaId} could not be read: ${graphError(res.body)}` };
    }

    const numbers = ((res.body as { data?: { id: string }[] }).data ?? []) as Record<string, unknown>[];
    if (!numbers.length) {
      return {
        id: 'waba-numbers',
        label: 'WABA phone numbers',
        status: 'fail',
        reason:
          "No phone number is attached to this WhatsApp Business Account — that's why the \"From\" dropdown on Meta's API Setup page is empty. Add and verify a number in WhatsApp Manager → Phone numbers.",
        details: { numbers },
      };
    }
    if (!numbers.some((n) => n.id === integration.phoneNumberId)) {
      return {
        id: 'waba-numbers',
        label: 'WABA phone numbers',
        status: 'fail',
        reason: `The configured Phone Number ID ${integration.phoneNumberId} isn't one of this WABA's ${numbers.length} number(s) — update the integration with the right ID.`,
        details: { numbers },
      };
    }
    return { id: 'waba-numbers', label: 'WABA phone numbers', status: 'pass', reason: `${numbers.length} number(s) on the WABA, including the configured one.`, details: { numbers } };
  }

  private async checkSubscription(integration: WhatsAppIntegration, accessToken: string): Promise<HealthCheck> {
    const res = await this.graph(`/${integration.wabaId}/subscribed_apps`, accessToken);
    if (!res.ok) {
      return { id: 'subscription', label: 'App subscribed to WABA', status: 'fail', reason: `Could not read subscribed apps: ${graphError(res.body)}` };
    }

    const apps = ((res.body as { data?: { whatsapp_business_api_data?: { id?: string; name?: string } }[] }).data ?? []).map(
      (a) => a.whatsapp_business_api_data ?? {},
    );
    const appId = this.config.get<string>('META_APP_ID');
    const ours = appId ? apps.some((a) => a.id === appId) : apps.length > 0;

    return {
      id: 'subscription',
      label: 'App subscribed to WABA',
      status: ours ? 'pass' : 'fail',
      reason: ours
        ? `Subscribed: ${apps.map((a) => a.name ?? a.id).join(', ')}`
        : apps.length
          ? `Our app (${appId}) isn't subscribed — only ${apps.map((a) => a.name ?? a.id).join(', ')}. Click "Subscribe app to WABA".`
          : 'No app is subscribed to this WABA, so Meta will never send webhooks. Click "Subscribe app to WABA".',
      details: { apps },
    };
  }

  private checkVerification(integration: WhatsAppIntegration): HealthCheck {
    if (integration.status === WhatsAppIntegrationStatus.CONNECTED) {
      return {
        id: 'verified',
        label: 'Webhook verification handshake',
        status: 'pass',
        reason: `Meta verified the callback URL${integration.verifiedAt ? ` on ${integration.verifiedAt.toISOString()}` : ''}.`,
      };
    }
    return {
      id: 'verified',
      label: 'Webhook verification handshake',
      status: 'fail',
      reason: `Integration is ${integration.status}: Meta has never completed the GET handshake. Paste the callback URL and verify token into Meta App Dashboard → WhatsApp → Configuration → Webhooks and click "Verify and save".`,
    };
  }

  private async checkLastWebhook(integration: WhatsAppIntegration): Promise<HealthCheck> {
    const since = new Date(Date.now() - SERVICE_WINDOW_MS);
    const [last, lastDay, invalidLastDay] = await Promise.all([
      this.prisma.whatsAppWebhookEvent.findFirst({
        where: { integrationId: integration.id },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, eventType: true, processingStatus: true },
      }),
      this.prisma.whatsAppWebhookEvent.count({ where: { integrationId: integration.id, receivedAt: { gte: since } } }),
      this.prisma.whatsAppWebhookEvent.count({
        where: { integrationId: integration.id, receivedAt: { gte: since }, signatureValid: false },
      }),
    ]);

    if (!last) {
      return {
        id: 'last-webhook',
        label: 'Last webhook received',
        status: 'warn',
        reason: 'No webhook POST has ever reached this server for this integration.',
        details: { lastDay, invalidLastDay },
      };
    }

    const minutes = Math.round((Date.now() - last.receivedAt.getTime()) / 60000);
    const age = minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
    return {
      id: 'last-webhook',
      label: 'Last webhook received',
      status: invalidLastDay ? 'warn' : 'pass',
      reason: `${age} ago (${last.eventType}, ${last.processingStatus.toLowerCase()}). ${lastDay} in the last 24 h${invalidLastDay ? `, ${invalidLastDay} with an INVALID signature — check the App Secret` : ''}.`,
      details: { lastReceivedAt: last.receivedAt, lastDay, invalidLastDay },
    };
  }

  private async checkCallbackUrl(integration: WhatsAppIntegration): Promise<HealthCheck> {
    const callbackUrl = this.webhookUrl(integration);
    if (!callbackUrl) {
      return { id: 'callback', label: 'Callback URL', status: 'fail', reason: 'WEBHOOK_BASE_URL is not set, so there is no public callback URL.' };
    }

    const url = new URL(callbackUrl);
    const isLocal = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
    const details: Record<string, unknown> = { callbackUrl, verifyToken: 'Reveal it on the Integrations page (WhatsApp card)' };

    // Probe our own public URL with a wrong verify token: getting our "403
    // Verification failed" back proves DNS, TLS and the reverse proxy all
    // route to this backend (from this server's point of view).
    let reachable: string;
    try {
      const probe = await fetch(`${callbackUrl}?hub.mode=subscribe&hub.verify_token=reachability-probe&hub.challenge=probe`, {
        signal: AbortSignal.timeout(5000),
      });
      const text = await probe.text().catch(() => '');
      reachable = probe.status === 403 && text.includes('Verification failed') ? 'ok' : `unexpected response ${probe.status}`;
    } catch (err) {
      reachable = `unreachable (${err instanceof Error ? err.message : err})`;
    }
    details.reachability = reachable;

    if (url.protocol !== 'https:' || isLocal) {
      return {
        id: 'callback',
        label: 'Callback URL',
        status: 'fail',
        reason: `Meta can't call ${url.origin} — it needs a public HTTPS URL. Set WEBHOOK_BASE_URL to your deployed backend (e.g. https://api.yourdomain.com) or an ngrok/cloudflared tunnel for local testing.`,
        details,
      };
    }
    return {
      id: 'callback',
      label: 'Callback URL',
      status: reachable === 'ok' ? 'pass' : 'warn',
      reason: reachable === 'ok' ? 'Public HTTPS URL, and it routes back to this backend.' : `Public HTTPS URL, but the self-probe got: ${reachable}`,
      details,
    };
  }

  async subscribeApp(actor: AuthenticatedUser) {
    const integration = await this.getIntegration(actor.orgId);
    const accessToken = this.encryption.decrypt(integration.accessTokenEncrypted);
    const res = await this.graph(`/${integration.wabaId}/subscribed_apps`, accessToken, { method: 'POST' });
    return { ok: res.ok, status: res.status, body: res.body };
  }

  // ------------------------------------------------------------ event log

  async listEvents(actor: AuthenticatedUser, filter: DebugEventFilter = 'all') {
    const where: Prisma.WhatsAppWebhookEventWhereInput = { orgId: actor.orgId };
    if (filter === 'messages') where.eventType = { in: ['messages', 'messages+statuses'] };
    if (filter === 'statuses') where.eventType = { in: ['statuses', 'messages+statuses'] };
    if (filter === 'errors') where.processingStatus = WhatsAppWebhookEventStatus.FAILED;
    if (filter === 'invalid-signature') where.signatureValid = false;

    return this.prisma.whatsAppWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        receivedAt: true,
        eventType: true,
        object: true,
        phoneNumberId: true,
        signatureValid: true,
        processingStatus: true,
        errorMessage: true,
        processedAt: true,
      },
    });
  }

  async getEvent(actor: AuthenticatedUser, id: string) {
    const event = await this.prisma.whatsAppWebhookEvent.findFirst({ where: { id, orgId: actor.orgId } });
    if (!event) throw new NotFoundException('Webhook event not found');
    return event;
  }

  // ---------------------------------------------------------- send test

  async sendTest(actor: AuthenticatedUser, dto: SendTestMessageDto) {
    const integration = await this.getIntegration(actor.orgId);
    const to = dto.to.replace(/\D/g, '');

    if (dto.type === 'text') {
      if (!dto.text?.trim()) throw new BadRequestException('Enter the message text');
      const lastInbound = await this.prisma.whatsAppMessage.findFirst({
        where: {
          orgId: actor.orgId,
          direction: WhatsAppMessageDirection.INBOUND,
          fromPhone: `+${to}`,
        },
        orderBy: { waTimestamp: 'desc' },
        select: { waTimestamp: true },
      });
      if (!lastInbound?.waTimestamp || lastInbound.waTimestamp.getTime() + SERVICE_WINDOW_MS < Date.now()) {
        throw new BadRequestException(
          `+${to} hasn't messaged this number in the last 24 hours, so WhatsApp only allows a template. Use "hello_world" instead.`,
        );
      }
    }

    const body =
      dto.type === 'hello_world'
        ? this.metaClient.templateMessageBody(to, 'hello_world', 'en_US')
        : this.metaClient.textMessageBody(to, dto.text!.trim());
    const path = `/${integration.phoneNumberId}/messages`;
    const request = {
      method: 'POST',
      url: `${this.metaClient.baseUrl}${path}`,
      headers: { Authorization: 'Bearer ••••••••', 'Content-Type': 'application/json' },
      body,
    };

    const accessToken = this.encryption.decrypt(integration.accessTokenEncrypted);
    const response = await this.graph(path, accessToken, { method: 'POST', body: JSON.stringify(body) });

    return { request, response };
  }

  // ------------------------------------------------------- simulate inbound

  async simulateInbound(actor: AuthenticatedUser, dto: SimulateInboundDto) {
    if (!this.simulateEnabled()) {
      throw new ForbiddenException(
        'Simulating webhooks is disabled in production. Set WHATSAPP_DEBUG_SIMULATE_ENABLED=true to allow it (staging only).',
      );
    }
    const integration = await this.getIntegration(actor.orgId);

    const from = (dto.from ?? '+919000000001').replace(/\D/g, '');
    const wamid = `wamid.SIMULATED.${randomUUID()}`;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: integration.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: (integration.displayPhoneNumber ?? '').replace(/\D/g, ''),
                  phone_number_id: integration.phoneNumberId,
                },
                contacts: [{ profile: { name: dto.name?.trim() || 'Simulated Customer' }, wa_id: from }],
                messages: [
                  {
                    from,
                    id: wamid,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: dto.text?.trim() || 'Hi! This is a simulated WhatsApp message from the debug console.' },
                    ...(dto.adId?.trim()
                      ? {
                          referral: {
                            source_type: 'ad',
                            source_id: dto.adId.trim(),
                            source_url: `https://fb.me/simulated-${dto.adId.trim()}`,
                            headline: dto.adHeadline?.trim() || undefined,
                            body: dto.adBody?.trim() || undefined,
                          },
                        }
                      : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawBody = JSON.stringify(payload);
    let secret: string | null = null;
    try {
      secret = this.webhookService.resolveAppSecret(integration);
    } catch {
      secret = null;
    }

    // Through the real HTTP endpoint on loopback, so raw-body capture,
    // signature check, storage and processing are all exercised.
    const port = this.config.get<string>('PORT') || '3000';
    const url = `http://127.0.0.1:${port}/webhooks/whatsapp/${integration.webhookSlug}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Hub-Signature-256': signWebhookBody(rawBody, secret) } : {}),
      },
      body: rawBody,
    });
    const responseBody = await res.json().catch(() => ({}));

    await this.webhookService.drain();
    const message = await this.prisma.whatsAppMessage.findUnique({
      where: { waMessageId: wamid },
      select: { id: true, leadId: true, lead: { select: { name: true } } },
    });

    return {
      request: {
        method: 'POST',
        url: `/webhooks/whatsapp/${integration.webhookSlug.slice(0, 6)}…`,
        signed: !!secret,
        payload,
      },
      response: { status: res.status, body: responseBody },
      wamid,
      savedMessageId: message?.id ?? null,
      leadId: message?.leadId ?? null,
      leadName: message?.lead.name ?? null,
    };
  }

  // ------------------------------------------------------------- trace

  async trace(actor: AuthenticatedUser) {
    const event = await this.prisma.whatsAppWebhookEvent.findFirst({
      where: { orgId: actor.orgId, eventType: { in: ['messages', 'messages+statuses'] } },
      orderBy: { receivedAt: 'desc' },
    });

    const stages: { key: string; label: string; status: TraceStatus; detail: string }[] = [];
    let stopped = false;
    const add = (key: string, label: string, status: CheckStatus, detail: string) => {
      stages.push({ key, label, status: stopped ? 'skipped' : status, detail: stopped ? 'Not reached' : detail });
      if (status === 'fail') stopped = true;
    };

    if (!event) {
      add('received', 'Received by webhook', 'fail', 'No webhook carrying an inbound message has been received yet.');
      add('signature', 'Signature valid', 'fail', '');
      add('processed', 'Processed', 'fail', '');
      add('saved', 'Saved to messages', 'fail', '');
      add('linked', 'Linked to lead', 'fail', '');
      add('visible', 'Visible via inbox API', 'fail', '');
      return { eventId: null, receivedAt: null, stages };
    }

    add('received', 'Received by webhook', 'pass', `Event ${event.id} at ${event.receivedAt.toISOString()}`);
    add(
      'signature',
      'Signature valid',
      event.signatureValid === false ? 'fail' : event.signatureValid === null ? 'warn' : 'pass',
      event.signatureValid === false
        ? event.errorMessage ?? 'X-Hub-Signature-256 did not match'
        : event.signatureValid === null
          ? 'Not checked — no App Secret configured'
          : 'X-Hub-Signature-256 matched the App Secret',
    );
    add(
      'processed',
      'Processed',
      event.processingStatus === WhatsAppWebhookEventStatus.PROCESSED
        ? 'pass'
        : event.processingStatus === WhatsAppWebhookEventStatus.PENDING
          ? 'warn'
          : 'fail',
      event.processingStatus === WhatsAppWebhookEventStatus.PENDING
        ? 'Still queued for processing'
        : event.errorMessage ?? event.processingStatus.toLowerCase(),
    );

    const wamids = inboundMessageIds(event.rawPayload as MetaWebhookPayload);
    const messages = wamids.length
      ? await this.prisma.whatsAppMessage.findMany({
          where: { waMessageId: { in: wamids }, orgId: actor.orgId },
          select: { id: true, waMessageId: true, leadId: true, createdAt: true },
        })
      : [];
    add(
      'saved',
      'Saved to messages',
      messages.length ? 'pass' : 'fail',
      messages.length ? `${messages.length} of ${wamids.length} message(s) stored` : `No row for ${wamids.join(', ') || 'this event'}`,
    );

    const leadId = messages[0]?.leadId;
    const lead = leadId
      ? await this.prisma.lead.findFirst({
          where: { id: leadId, orgId: actor.orgId },
          select: { id: true, name: true, phone: true, assignedTo: { select: { name: true } } },
        })
      : null;
    add(
      'linked',
      'Linked to lead',
      lead ? 'pass' : 'fail',
      lead
        ? `${lead.name ?? lead.phone}${lead.assignedTo ? ` — assigned to ${lead.assignedTo.name}` : ' — unassigned'}`
        : 'The message points at a lead that no longer exists',
    );

    const visible = lead
      ? await this.prisma.lead.findFirst({ where: { id: lead.id, ...this.messagingService.inboxWhere(actor) }, select: { id: true } })
      : null;
    add(
      'visible',
      'Visible via inbox API',
      visible ? 'pass' : 'fail',
      visible ? 'Returned by GET /whatsapp/inbox for you' : 'Not returned by GET /whatsapp/inbox for you',
    );

    return { eventId: event.id, receivedAt: event.receivedAt, leadId: lead?.id ?? null, stages };
  }
}

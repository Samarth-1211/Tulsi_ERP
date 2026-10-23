import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Integration, IntegrationStatus, IntegrationType, Prisma, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { SAMPLE_LEAD_WEBHOOK_PAYLOAD } from '../../lead-ingestion/dto/incoming-lead-webhook.dto';
import { GoogleSheetSyncService } from '../../lead-ingestion/services/google-sheet-sync.service';
import { GoogleSheetsApiService } from '../../lead-ingestion/services/google-sheets-api.service';
import { GoogleSheetConfig, parseGoogleSheetUrl } from '../../lead-ingestion/utils/google-sheet.util';
import { CreatePlatformIntegrationDto, LEAD_INTEGRATION_TYPES } from '../dto/create-platform-integration.dto';
import { UpdatePlatformIntegrationDto } from '../dto/update-platform-integration.dto';

const token = () => randomBytes(24).toString('hex');

interface IntegrationConfig extends Partial<GoogleSheetConfig> {
  formIds?: string[];
  fieldMapping?: Record<string, string>;
}

/**
 * Lead-source integrations (Meta Lead Forms, generic webhook). Same pattern
 * as RCRM: the Admin creates one, the system generates the webhook URL plus
 * the expected payload, and the URL is configured on the sender's side.
 */
@Injectable()
export class PlatformIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly sheetSync: GoogleSheetSyncService,
    private readonly sheetsApi: GoogleSheetsApiService,
  ) {}

  private baseUrl(): string {
    const base = this.config.get<string>('WEBHOOK_BASE_URL');
    if (!base) throw new Error('WEBHOOK_BASE_URL is not set in the environment');
    return base.replace(/\/$/, '');
  }

  // The webhook URL embeds the token, which on its own is enough to post
  // leads into the org — so it's a credential. Only Admins see it; Managers
  // get the monitoring fields only.
  private canSeeCredentials(role: Role): boolean {
    return role === Role.ADMIN;
  }

  private toResponse(integration: Integration, includeCredentials: boolean) {
    const { encryptedSecrets, webhookToken, verifyToken, ...rest } = integration;
    const base = { ...rest, hasPageAccessToken: !!encryptedSecrets };
    if (integration.type === IntegrationType.GOOGLE_SHEET) {
      // A public sheet's link opens every lead in it — a credential like the webhook URL.
      if (includeCredentials) return base;
      const { sheetUrl, spreadsheetId, ...config } = (integration.config ?? {}) as IntegrationConfig;
      return { ...base, config };
    }
    if (!includeCredentials) return base;

    return {
      ...base,
      webhookUrl: `${this.baseUrl()}/webhooks/leads/${webhookToken}`,
      samplePayload: SAMPLE_LEAD_WEBHOOK_PAYLOAD,
      ...(integration.type === IntegrationType.META_LEAD_FORM
        ? {
            metaWebhook: {
              callbackUrl: `${this.baseUrl()}/webhooks/meta/leadgen`,
              verifyToken,
              note: 'Subscribe the page to the "leadgen" field; set externalAccountId (page_id) and pageAccessToken here.',
            },
          }
        : {}),
    };
  }

  private encryptSecrets(pageAccessToken: string): string {
    return this.encryption.encrypt(JSON.stringify({ pageAccessToken }));
  }

  /** The sheet link → config; the link is required for a GOOGLE_SHEET source. */
  private sheetConfig(sheetUrl: string | undefined): Pick<GoogleSheetConfig, 'sheetUrl' | 'spreadsheetId' | 'gid'> {
    const parsed = sheetUrl ? parseGoogleSheetUrl(sheetUrl) : null;
    if (!parsed) {
      throw new BadRequestException('Paste the Google Sheet’s link, e.g. https://docs.google.com/spreadsheets/d/…/edit#gid=0');
    }
    return { sheetUrl: sheetUrl!.trim(), ...parsed };
  }

  async create(orgId: string, dto: CreatePlatformIntegrationDto) {
    const isSheet = dto.type === IntegrationType.GOOGLE_SHEET;
    const config: IntegrationConfig = {
      ...(isSheet ? this.sheetConfig(dto.sheetUrl) : {}),
      ...(dto.formIds ? { formIds: dto.formIds } : {}),
      ...(dto.fieldMapping ? { fieldMapping: dto.fieldMapping } : {}),
    };
    const integration = await this.prisma.integration.create({
      data: {
        orgId,
        type: dto.type,
        name: dto.name,
        status: IntegrationStatus.ACTIVE,
        webhookToken: token(),
        verifyToken: dto.type === IntegrationType.META_LEAD_FORM ? token() : null,
        externalAccountId: dto.externalAccountId,
        config: config as Prisma.InputJsonValue,
        encryptedSecrets: dto.pageAccessToken ? this.encryptSecrets(dto.pageAccessToken) : null,
      },
    });
    // Every row already in the sheet is imported now; new ones on each sync after.
    if (isSheet) this.sheetSync.syncInBackground(integration.id);
    return this.toResponse(integration, true);
  }

  async findAllForOrg(orgId: string, role: Role) {
    const integrations = await this.prisma.integration.findMany({
      where: { orgId, type: { in: [...LEAD_INTEGRATION_TYPES] } },
      orderBy: { createdAt: 'desc' },
    });
    return integrations.map((i) => this.toResponse(i, this.canSeeCredentials(role)));
  }

  async findOneForOrg(id: string, orgId: string, role: Role) {
    return this.toResponse(await this.findOrThrow(id, orgId), this.canSeeCredentials(role));
  }

  /** Explicit action to re-show the webhook URL, sample payload and Meta verify token. */
  async revealSecret(id: string, orgId: string) {
    return this.toResponse(await this.findOrThrow(id, orgId), true);
  }

  async update(id: string, orgId: string, dto: UpdatePlatformIntegrationDto) {
    const existing = await this.findOrThrow(id, orgId);
    const current = (existing.config ?? {}) as IntegrationConfig;
    const config: IntegrationConfig = {
      ...current,
      ...(existing.type === IntegrationType.GOOGLE_SHEET && dto.sheetUrl !== undefined ? this.sheetConfig(dto.sheetUrl) : {}),
      ...(dto.formIds !== undefined ? { formIds: dto.formIds } : {}),
      ...(dto.fieldMapping !== undefined ? { fieldMapping: dto.fieldMapping } : {}),
    };

    const updated = await this.prisma.integration.update({
      where: { id },
      data: {
        name: dto.name,
        status: dto.status,
        externalAccountId: dto.externalAccountId,
        config: config as Prisma.InputJsonValue,
        ...(dto.pageAccessToken !== undefined
          ? { encryptedSecrets: dto.pageAccessToken ? this.encryptSecrets(dto.pageAccessToken) : null }
          : {}),
      },
    });
    // A new link or a re-activation is read straight away rather than at the next sync.
    if (updated.type === IntegrationType.GOOGLE_SHEET) this.sheetSync.syncInBackground(updated.id);
    return this.toResponse(updated, true);
  }

  /** Who a private sheet must be shared with; null when the server has no Google service account. */
  googleSheetSetup() {
    return { serviceAccountEmail: this.sheetsApi.serviceAccountEmail };
  }

  /** Reads a Google Sheet source now instead of waiting for the next sync. */
  syncSheet(id: string, orgId: string) {
    return this.sheetSync.syncNow(id, orgId);
  }

  /** Soft action — INACTIVE stops the webhook; past leads keep referencing the integration. */
  async deactivate(id: string, orgId: string) {
    await this.findOrThrow(id, orgId);
    const updated = await this.prisma.integration.update({ where: { id }, data: { status: IntegrationStatus.INACTIVE } });
    return this.toResponse(updated, true);
  }

  private async findOrThrow(id: string, orgId: string): Promise<Integration> {
    const integration = await this.prisma.integration.findFirst({
      where: { id, orgId, type: { in: [...LEAD_INTEGRATION_TYPES] } },
    });
    if (!integration) throw new NotFoundException('Integration not found');
    return integration;
  }
}

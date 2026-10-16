import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, WhatsAppIntegration, WhatsAppIntegrationStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { ConnectWhatsAppIntegrationDto } from '../dto/connect-whatsapp-integration.dto';
import { UpdateWhatsAppIntegrationDto } from '../dto/update-whatsapp-integration.dto';
import { MetaApiError, MetaWhatsAppClientService } from './meta-whatsapp-client.service';
import { WhatsAppMediaStorageService } from './whatsapp-media-storage.service';

@Injectable()
export class WhatsAppIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly metaClient: MetaWhatsAppClientService,
    private readonly mediaStorage: WhatsAppMediaStorageService,
  ) {}

  private buildWebhookUrl(slug: string): string {
    const base = this.config.get<string>('WEBHOOK_BASE_URL');
    if (!base) {
      throw new Error('WEBHOOK_BASE_URL is not set in the environment');
    }
    return `${base}/webhooks/whatsapp/${slug}`;
  }

  private toResponse(integration: WhatsAppIntegration, includeVerifyToken = false) {
    const { accessTokenEncrypted, appSecretEncrypted, verifyToken, webhookSlug, ...rest } = integration;
    return {
      ...rest,
      // Whether webhook signatures can be checked — never the secret itself.
      hasAppSecret: !!appSecretEncrypted || !!this.config.get<string>('META_APP_SECRET'),
      webhookUrl: this.buildWebhookUrl(webhookSlug),
      ...(includeVerifyToken ? { verifyToken } : {}),
    };
  }

  /** Live credential check against Meta before anything gets saved — catches typos/expired tokens up front. */
  private async validateWithMeta(
    wabaId: string,
    phoneNumberId: string,
    accessToken: string,
  ): Promise<{ verifiedName?: string; displayPhoneNumber?: string }> {
    try {
      const [phone, waba] = await Promise.all([
        this.metaClient.fetchPhoneNumberDetails(phoneNumberId, accessToken),
        this.metaClient.fetchWabaDetails(wabaId, accessToken),
      ]);

      if (phone.id !== phoneNumberId || waba.id !== wabaId) {
        throw new BadRequestException(
          'Meta returned unexpected IDs for the given credentials — double-check the WABA ID and Phone Number ID',
        );
      }

      return { verifiedName: phone.verified_name ?? waba.name, displayPhoneNumber: phone.display_phone_number };
    } catch (err) {
      if (err instanceof MetaApiError) {
        throw new BadRequestException(
          `Meta rejected these credentials: ${err.message}${err.code ? ` (code ${err.code})` : ''}`,
        );
      }
      throw err;
    }
  }

  async connect(orgId: string, dto: ConnectWhatsAppIntegrationDto) {
    const existing = await this.prisma.whatsAppIntegration.findUnique({ where: { orgId } });
    if (existing) {
      throw new ConflictException(
        'WhatsApp is already connected for this organization — disconnect the existing integration first, or update it instead',
      );
    }

    const { verifiedName, displayPhoneNumber } = await this.validateWithMeta(
      dto.wabaId,
      dto.phoneNumberId,
      dto.accessToken,
    );

    const integration = await this.prisma.whatsAppIntegration.create({
      data: {
        orgId,
        wabaId: dto.wabaId,
        phoneNumberId: dto.phoneNumberId,
        displayPhoneNumber: dto.displayPhoneNumber ?? displayPhoneNumber,
        businessName: dto.businessName ?? verifiedName,
        businessManagerId: dto.businessManagerId,
        accessTokenEncrypted: this.encryption.encrypt(dto.accessToken),
        appSecretEncrypted: dto.appSecret ? this.encryption.encrypt(dto.appSecret) : null,
        webhookSlug: crypto.randomBytes(24).toString('hex'),
        verifyToken: crypto.randomBytes(32).toString('hex'),
        status: WhatsAppIntegrationStatus.PENDING,
      },
    });

    return this.toResponse(integration, true);
  }

  async getForOrg(orgId: string, role: Role) {
    const integration = await this.prisma.whatsAppIntegration.findUnique({ where: { orgId } });
    if (!integration) {
      throw new NotFoundException('WhatsApp is not connected for this organization yet');
    }
    if (role !== Role.ADMIN && role !== Role.SUPER_ADMIN) {
      return this.toStatusResponse(integration);
    }
    return this.toResponse(integration, false);
  }

  /**
   * Status-only view for non-admin roles (the Integrations page for
   * Managers, the WhatsApp Inbox for everyone): enough to know whether and
   * which number is connected, but none of the Meta account identifiers or
   * the webhook URL, which are admin-only credentials.
   */
  private toStatusResponse(integration: WhatsAppIntegration) {
    return {
      id: integration.id,
      orgId: integration.orgId,
      displayPhoneNumber: integration.displayPhoneNumber,
      businessName: integration.businessName,
      status: integration.status,
      verifiedAt: integration.verifiedAt,
      lastInboundAt: integration.lastInboundAt,
      lastOutboundAt: integration.lastOutboundAt,
      isActive: integration.isActive,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    };
  }

  async revealVerifyToken(orgId: string) {
    const integration = await this.findOrThrow(orgId);
    return this.toResponse(integration, true);
  }

  async update(orgId: string, dto: UpdateWhatsAppIntegrationDto) {
    const integration = await this.findOrThrow(orgId);

    let accessTokenEncrypted: string | undefined;
    let metaDisplayPhoneNumber: string | undefined;
    let metaVerifiedName: string | undefined;

    // New IDs (e.g. a number was added to the WABA after connecting) or a
    // new token are re-validated live as a set — whichever parts weren't
    // given keep their saved values.
    const idsChanged =
      (!!dto.wabaId && dto.wabaId !== integration.wabaId) ||
      (!!dto.phoneNumberId && dto.phoneNumberId !== integration.phoneNumberId);

    if (dto.accessToken || idsChanged) {
      const validated = await this.validateWithMeta(
        dto.wabaId ?? integration.wabaId,
        dto.phoneNumberId ?? integration.phoneNumberId,
        dto.accessToken ?? this.encryption.decrypt(integration.accessTokenEncrypted),
      );
      if (dto.accessToken) accessTokenEncrypted = this.encryption.encrypt(dto.accessToken);
      metaDisplayPhoneNumber = validated.displayPhoneNumber;
      metaVerifiedName = validated.verifiedName;
    }

    const updated = await this.prisma.whatsAppIntegration.update({
      where: { orgId },
      data: {
        ...(accessTokenEncrypted ? { accessTokenEncrypted, lastError: null } : {}),
        ...(idsChanged ? { wabaId: dto.wabaId ?? undefined, phoneNumberId: dto.phoneNumberId ?? undefined } : {}),
        ...(dto.appSecret ? { appSecretEncrypted: this.encryption.encrypt(dto.appSecret) } : {}),
        displayPhoneNumber: dto.displayPhoneNumber ?? metaDisplayPhoneNumber ?? undefined,
        businessName: dto.businessName ?? metaVerifiedName ?? undefined,
        businessManagerId: dto.businessManagerId,
        isActive: dto.isActive,
        // A token rotation re-proves the credentials work, so a previously
        // FAILED integration is worth giving another shot at verification.
        ...(accessTokenEncrypted && integration.status === WhatsAppIntegrationStatus.FAILED
          ? { status: WhatsAppIntegrationStatus.PENDING }
          : {}),
      },
    });

    return this.toResponse(updated, false);
  }

  async disable(orgId: string) {
    await this.findOrThrow(orgId);
    const updated = await this.prisma.whatsAppIntegration.update({
      where: { orgId },
      data: { isActive: false },
    });
    return this.toResponse(updated, false);
  }

  async enable(orgId: string) {
    await this.findOrThrow(orgId);
    const updated = await this.prisma.whatsAppIntegration.update({
      where: { orgId },
      data: { isActive: true },
    });
    return this.toResponse(updated, false);
  }

  /**
   * Permanently removes the org's WhatsApp setup so a different number can
   * be connected from scratch: the integration row, its webhook event log
   * (cascades), every stored message and their media files. Leads that were
   * captured from WhatsApp are kept.
   */
  async remove(orgId: string) {
    const integration = await this.findOrThrow(orgId);

    const withMedia = await this.prisma.whatsAppMessage.findMany({
      where: { integrationId: integration.id, mediaStorageKey: { not: null } },
      select: { mediaStorageKey: true },
    });

    // Messages have no cascade onto the integration, so they go first.
    await this.prisma.$transaction([
      this.prisma.whatsAppMessage.deleteMany({ where: { integrationId: integration.id } }),
      this.prisma.whatsAppIntegration.delete({ where: { id: integration.id } }),
    ]);

    // Only once the rows are gone, so a failed delete never orphans a message.
    await Promise.all(withMedia.map((m) => this.mediaStorage.delete(m.mediaStorageKey!)));

    return { success: true };
  }

  private async findOrThrow(orgId: string): Promise<WhatsAppIntegration> {
    const integration = await this.prisma.whatsAppIntegration.findUnique({ where: { orgId } });
    if (!integration) {
      throw new NotFoundException('WhatsApp is not connected for this organization yet');
    }
    return integration;
  }
}

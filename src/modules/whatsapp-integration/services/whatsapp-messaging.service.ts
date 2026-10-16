import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Lead,
  Prisma,
  Role,
  WhatsAppIntegration,
  WhatsAppIntegrationStatus,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { leadVisibilityWhere } from '../../../common/utils/lead-scope.util';
import { MetaApiError, MetaWhatsAppClientService } from './meta-whatsapp-client.service';
import { uploadedFileName } from '../../../common/utils/upload.util';
import {
  MAX_OUTBOUND_DOCUMENT_BYTES,
  MAX_OUTBOUND_IMAGE_BYTES,
  WhatsAppMediaStorageService,
} from './whatsapp-media-storage.service';

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta's re-engagement error for messages sent outside the 24h window.
const OUTSIDE_WINDOW_META_CODE = 131047;

// Columns safe to hand to the browser — rawPayload (Meta's full message
// object) stays server-side; the debug console reads it from the event log.
const MESSAGE_SELECT = {
  id: true,
  orgId: true,
  integrationId: true,
  leadId: true,
  waMessageId: true,
  direction: true,
  fromPhone: true,
  toPhone: true,
  messageType: true,
  textBody: true,
  mediaId: true,
  mediaMimeType: true,
  mediaFileName: true,
  mediaSize: true,
  mediaError: true,
  mediaStorageKey: true,
  status: true,
  errorCode: true,
  errorMessage: true,
  sentByUserId: true,
  waTimestamp: true,
  createdAt: true,
} satisfies Prisma.WhatsAppMessageSelect;

@Injectable()
export class WhatsAppMessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly metaClient: MetaWhatsAppClientService,
    private readonly mediaStorage: WhatsAppMediaStorageService,
  ) {}

  /**
   * Feeds the WhatsApp Inbox screen: every lead with a WhatsApp conversation
   * the caller can see — WHATSAPP-sourced leads plus leads from other
   * channels who later messaged in (matched by phone number) — each with
   * its most recent message for a preview snippet and the caller's unread
   * count.
   * Scoping mirrors LeadsService.findAll exactly — individual contributors
   * (Agent/Presales/Postsales) see only their own assigned leads, Managers
   * their own and their team's, Admin/Super Admin the whole organization's.
   */
  async listInbox(actor: AuthenticatedUser) {
    const leads = await this.prisma.lead.findMany({
      where: this.inboxWhere(actor),
      include: {
        assignedTo: { select: { id: true, name: true } },
        whatsappMessages: { orderBy: { createdAt: 'desc' }, take: 1, select: MESSAGE_SELECT },
      },
    });

    const unreadByLead = await this.countUnread(actor.userId, leads.map((l) => l.id));

    return leads
      .map((lead) => ({
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        status: lead.status,
        assignedTo: lead.assignedTo,
        lastMessage: lead.whatsappMessages[0] ?? null,
        unreadCount: unreadByLead.get(lead.id) ?? 0,
      }))
      .sort((a, b) => {
        const aTime = new Date(a.lastMessage?.createdAt ?? 0).getTime();
        const bTime = new Date(b.lastMessage?.createdAt ?? 0).getTime();
        return bTime - aTime;
      });
  }

  /** The inbox's lead filter — shared with the debug console's pipeline trace. */
  inboxWhere(actor: AuthenticatedUser): Prisma.LeadWhereInput {
    return {
      orgId: actor.orgId,
      whatsappMessages: { some: {} },
      ...leadVisibilityWhere(actor),
    };
  }

  /** Inbound messages newer than the user's last look at each thread. */
  private async countUnread(userId: string, leadIds: string[]): Promise<Map<string, number>> {
    if (!leadIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ leadId: string; count: bigint }[]>`
      SELECT m."leadId", COUNT(*)::bigint AS count
      FROM whatsapp_messages m
      LEFT JOIN whatsapp_thread_reads r ON r."leadId" = m."leadId" AND r."userId" = ${userId}
      WHERE m."leadId" IN (${Prisma.join(leadIds)})
        AND m.direction = 'INBOUND'
        AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
      GROUP BY m."leadId"`;
    return new Map(rows.map((r) => [r.leadId, Number(r.count)]));
  }

  async markRead(actor: AuthenticatedUser, leadId: string) {
    const lead = await this.getAccessibleLead(actor, leadId);
    const now = new Date();
    await this.prisma.whatsAppThreadRead.upsert({
      where: { userId_leadId: { userId: actor.userId, leadId: lead.id } },
      create: { userId: actor.userId, leadId: lead.id, lastReadAt: now },
      update: { lastReadAt: now },
    });
    return { leadId: lead.id, lastReadAt: now };
  }

  async listMessages(actor: AuthenticatedUser, leadId: string) {
    const lead = await this.getAccessibleLead(actor, leadId);

    const messages = await this.prisma.whatsAppMessage.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
      select: MESSAGE_SELECT,
    });

    const windowOpenUntil = await this.getWindowOpenUntil(lead.id);

    return {
      lead: { id: lead.id, name: lead.name, phone: lead.phone, source: lead.source },
      messages,
      windowOpenUntil,
      withinServiceWindow: !!windowOpenUntil && windowOpenUntil.getTime() > Date.now(),
    };
  }

  /** A stored attachment, received or sent — same access rule as reading the thread. */
  async openMedia(actor: AuthenticatedUser, leadId: string, messageId: string) {
    const lead = await this.getAccessibleLead(actor, leadId);
    const message = await this.prisma.whatsAppMessage.findFirst({ where: { id: messageId, leadId: lead.id } });
    if (!message?.mediaStorageKey) {
      throw new NotFoundException(message?.mediaError ?? 'This message has no stored media');
    }
    const file = await this.mediaStorage.open(message.mediaStorageKey);
    if (!file) throw new NotFoundException('The media file is missing from storage');

    return {
      ...file,
      mimeType: message.mediaMimeType ?? 'application/octet-stream',
      fileName: message.mediaFileName ?? `${message.messageType}-${message.id}${message.mediaStorageKey.replace(/^[^.]*/, '')}`,
    };
  }

  async sendMessage(actor: AuthenticatedUser, leadId: string, text: string) {
    const lead = await this.getAccessibleLead(actor, leadId);
    const { integration, to } = await this.getReplyTarget(actor, lead);

    return this.recordAndSend(actor, lead, integration, to, { messageType: 'text', textBody: text }, (token) =>
      this.metaClient.sendTextMessage(integration.phoneNumberId, token, to, text),
    );
  }

  /**
   * Sends an image (JPG/PNG) or a PDF from the chat, with an optional
   * caption. Our copy of the file is kept so the thread can show it — also
   * when the send fails.
   */
  async sendMedia(
    actor: AuthenticatedUser,
    leadId: string,
    file: Express.Multer.File | undefined,
    caption: string | undefined,
  ) {
    const lead = await this.getAccessibleLead(actor, leadId);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose a file to send (multipart field "file")');
    }
    const type = this.mediaStorage.detectOutboundType(file.buffer);
    if (!type) {
      throw new BadRequestException('Only JPG or PNG images and PDF files can be sent on WhatsApp from here');
    }
    if (type.messageType === 'image' && file.size > MAX_OUTBOUND_IMAGE_BYTES) {
      throw new BadRequestException('WhatsApp only accepts images up to 5 MB');
    }
    if (file.size > MAX_OUTBOUND_DOCUMENT_BYTES) {
      throw new BadRequestException('The PDF must be 50 MB or smaller');
    }

    const { integration, to } = await this.getReplyTarget(actor, lead);
    const fileName = uploadedFileName(file);
    const text = caption?.trim() || undefined;
    const mediaStorageKey = await this.mediaStorage.saveOutbound(file.buffer, type);

    return this.recordAndSend(
      actor,
      lead,
      integration,
      to,
      {
        messageType: type.messageType,
        textBody: text ?? null,
        mediaMimeType: type.mimeType,
        mediaStorageKey,
        mediaFileName: fileName,
        mediaSize: file.size,
      },
      async (token) => {
        const { id: mediaId } = await this.metaClient.uploadMedia(integration.phoneNumberId, token, {
          buffer: file.buffer,
          mimeType: type.mimeType,
          fileName,
        });
        const result = await this.metaClient.sendMediaMessage(integration.phoneNumberId, token, to, {
          type: type.messageType,
          mediaId,
          caption: text,
          fileName,
        });
        return { ...result, mediaId };
      },
    );
  }

  /** Who a free-form reply goes to — refused once the 24-hour window has closed. */
  private async getReplyTarget(actor: AuthenticatedUser, lead: Lead) {
    // Replies go to the exact WhatsApp number that messaged in — the lead
    // may have come from another channel (matched by phone number), in which
    // case sourceLeadId is that portal's id, not a WhatsApp number.
    const lastInbound = await this.prisma.whatsAppMessage.findFirst({
      where: { leadId: lead.id, direction: WhatsAppMessageDirection.INBOUND },
      orderBy: { createdAt: 'desc' },
      select: { fromPhone: true },
    });
    if (!lastInbound) {
      throw new BadRequestException('This lead has no WhatsApp conversation to reply to');
    }

    const integration = await this.getConnectedIntegration(actor.orgId);

    const windowOpenUntil = await this.getWindowOpenUntil(lead.id);
    if (!windowOpenUntil || windowOpenUntil.getTime() <= Date.now()) {
      throw new BadRequestException(
        "24-hour window closed: this lead hasn't messaged you in the last 24 hours, so WhatsApp blocks free-form replies. Ask them to message you again to reopen the window, or send an approved template message to restart the conversation.",
      );
    }

    return { integration, to: lastInbound.fromPhone.replace(/^\+/, '') };
  }

  /**
   * Approved message templates on the org's WABA. Only templates with no
   * {{variables}} and no media header can be sent from the chat as-is —
   * flagged with `sendable`.
   */
  async listTemplates(actor: AuthenticatedUser) {
    const integration = await this.getConnectedIntegration(actor.orgId);
    const accessToken = this.encryption.decrypt(integration.accessTokenEncrypted);

    try {
      const { data } = await this.metaClient.listApprovedTemplates(integration.wabaId, accessToken);
      return data.map((t) => {
        const components = (t.components ?? []) as { type?: string; format?: string; text?: string }[];
        const body = components.find((c) => c.type === 'BODY')?.text ?? '';
        const needsParams =
          components.some((c) => (c.text ?? '').includes('{{')) ||
          components.some((c) => c.type === 'HEADER' && c.format && c.format !== 'TEXT');
        return { name: t.name, language: t.language, category: t.category ?? null, body, sendable: !needsParams };
      });
    } catch (err) {
      throw new BadRequestException(
        `Could not load templates from Meta: ${err instanceof MetaApiError ? err.message : 'request failed'}`,
      );
    }
  }

  /** Template messages are the one thing WhatsApp allows outside the 24-hour window. */
  async sendTemplate(actor: AuthenticatedUser, leadId: string, templateName: string, languageCode: string) {
    const lead = await this.getAccessibleLead(actor, leadId);
    const integration = await this.getConnectedIntegration(actor.orgId);

    const lastInbound = await this.prisma.whatsAppMessage.findFirst({
      where: { leadId: lead.id, direction: WhatsAppMessageDirection.INBOUND },
      orderBy: { createdAt: 'desc' },
      select: { fromPhone: true },
    });
    // Without a WhatsApp thread, fall back to the lead's own number — but
    // only when it carries a country code; WhatsApp needs full E.164.
    const leadDigits = (lead.phone ?? '').replace(/\D/g, '');
    const to = lastInbound
      ? lastInbound.fromPhone.replace(/^\+/, '')
      : lead.phone?.trim().startsWith('+') && leadDigits.length >= 8
        ? leadDigits
        : null;
    if (!to) {
      throw new BadRequestException(
        "This lead's phone number has no country code (e.g. +91…), so it can't be messaged on WhatsApp — edit the lead's phone first",
      );
    }

    return this.recordAndSend(
      actor,
      lead,
      integration,
      to,
      { messageType: 'template', textBody: `Template: ${templateName} (${languageCode})` },
      (token) => this.metaClient.sendTemplateMessage(integration.phoneNumberId, token, to, templateName, languageCode),
    );
  }

  /**
   * Logs the outbound message as QUEUED, calls Meta, then records the
   * outcome — so a failed send is stored with Meta's error, never swallowed.
   */
  private async recordAndSend(
    actor: AuthenticatedUser,
    lead: Lead,
    integration: WhatsAppIntegration,
    to: string,
    content: {
      messageType: string;
      textBody: string | null;
      mediaMimeType?: string;
      mediaStorageKey?: string;
      mediaFileName?: string;
      mediaSize?: number;
    },
    send: (accessToken: string) => Promise<{ messages?: { id: string }[]; mediaId?: string }>,
  ) {
    const accessToken = this.encryption.decrypt(integration.accessTokenEncrypted);

    const message = await this.prisma.whatsAppMessage.create({
      data: {
        orgId: actor.orgId,
        integrationId: integration.id,
        leadId: lead.id,
        direction: WhatsAppMessageDirection.OUTBOUND,
        fromPhone: integration.displayPhoneNumber ?? integration.phoneNumberId,
        toPhone: to,
        ...content,
        phoneNumberId: integration.phoneNumberId,
        status: WhatsAppMessageStatus.QUEUED,
        sentByUserId: actor.userId,
      },
    });

    try {
      const result = await send(accessToken);

      return await this.prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: {
          waMessageId: result.messages?.[0]?.id,
          mediaId: result.mediaId,
          status: WhatsAppMessageStatus.SENT,
          waTimestamp: new Date(),
        },
        select: MESSAGE_SELECT,
      });
    } catch (err) {
      const metaErr = err instanceof MetaApiError ? err : null;

      await this.prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: {
          status: WhatsAppMessageStatus.FAILED,
          errorCode: metaErr?.code ? String(metaErr.code) : undefined,
          errorMessage: metaErr?.message ?? 'Failed to send message',
        },
      });

      if (metaErr?.code === OUTSIDE_WINDOW_META_CODE) {
        throw new BadRequestException(
          "24-hour window closed: WhatsApp rejected this message because it's been more than 24 hours since this lead last messaged you. Ask them to message you again, or send an approved template message.",
        );
      }

      throw new BadRequestException(metaErr?.message ?? 'Failed to send WhatsApp message');
    }
  }

  private async getConnectedIntegration(orgId: string): Promise<WhatsAppIntegration> {
    const integration = await this.prisma.whatsAppIntegration.findUnique({ where: { orgId } });
    if (!integration || !integration.isActive || integration.status !== WhatsAppIntegrationStatus.CONNECTED) {
      throw new BadRequestException('WhatsApp is not connected for your organization');
    }
    return integration;
  }

  /** Latest inbound message on this lead's thread defines when the 24h free-form window closes. */
  async getWindowOpenUntil(leadId: string): Promise<Date | null> {
    const lastInbound = await this.prisma.whatsAppMessage.findFirst({
      where: { leadId, direction: WhatsAppMessageDirection.INBOUND },
      orderBy: { waTimestamp: 'desc' },
    });
    if (!lastInbound?.waTimestamp) return null;
    return new Date(lastInbound.waTimestamp.getTime() + SERVICE_WINDOW_MS);
  }

  /** Same access rule as lead status changes: the assignee, their manager, or an org admin/super admin. */
  private async getAccessibleLead(actor: AuthenticatedUser, leadId: string): Promise<Lead> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: { assignedTo: { select: { id: true, managerId: true } } },
    });
    if (!lead || lead.orgId !== actor.orgId) {
      throw new NotFoundException('Lead not found');
    }

    const isOwnLead = lead.assignedToId === actor.userId;
    const isManagerOfAssignee = actor.role === Role.MANAGER && lead.assignedTo?.managerId === actor.userId;
    const isPrivileged = ([Role.SUPER_ADMIN, Role.ADMIN] as Role[]).includes(actor.role);

    if (!isOwnLead && !isManagerOfAssignee && !isPrivileged) {
      throw new ForbiddenException("You do not have permission to view this lead's WhatsApp conversation");
    }

    return lead;
  }
}

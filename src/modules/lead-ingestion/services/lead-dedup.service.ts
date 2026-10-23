import { Injectable } from '@nestjs/common';
import { ActivityType, Lead, LeadSource, LeadStatus, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

/** Statuses after which a new enquiry from the same phone starts a new lead. */
export const CLOSED_LEAD_STATUSES: LeadStatus[] = [LeadStatus.CONVERTED, LeadStatus.LOST];

/**
 * Normalizes a phone number to E.164, defaulting to India (+91): spaces,
 * dashes and brackets are dropped, a "00" international prefix becomes "+",
 * a 10-digit number gets +91, and a trunk "0" or bare "91" prefix is
 * reduced to +91. Returns null when the result isn't a plausible E.164
 * number (8–15 digits).
 */
export function toE164(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  let digits = trimmed.replace(/\D/g, '');
  const international = trimmed.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (!international) {
    if (/^\d{10}$/.test(digits)) digits = `91${digits}`;
    else if (/^0\d{10}$/.test(digits)) digits = `91${digits.slice(1)}`;
    else if (!/^91\d{10}$/.test(digits)) return null;
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** "WHATSAPP_CTWA" -> "Whatsapp Ctwa", for timeline/notification text. */
export function formatSourceLabel(source: LeadSource): string {
  return source
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** How a lead is named in notifications: its name, else its phone. */
export function leadLabel(lead: Pick<Lead, 'name' | 'phone'>): string {
  return lead.name?.trim() || lead.phone;
}

export interface ReEnquiry {
  source: LeadSource;
  /** Human-readable channel for the timeline/notification, e.g. "Meta Lead Form" or "manual entry by a@b.com". */
  channel: string;
  performedById?: string | null;
  /** What the repeat enquiry carried, kept on the timeline entry. */
  details?: Record<string, unknown>;
  /** False inside a bulk import, which sends one summary instead of a notification per lead. */
  notify?: boolean;
}

/**
 * Phone is the identity of a lead (§2.5 of the DB spec): an enquiry from a
 * phone that already has an open lead in the org is attached to it as a
 * RE_ENQUIRY activity instead of creating a duplicate. A phone whose leads
 * are all CONVERTED / LOST gets a new lead linked to the latest one
 * (previousLeadId).
 */
@Injectable()
export class LeadDedupService {
  constructor(private readonly prisma: PrismaService) {}

  /** The open (not converted / lost / deleted) lead for this E.164 phone, oldest first. */
  findOpenByPhone(orgId: string, phone: string, tx: Tx = this.prisma): Promise<Lead | null> {
    return tx.lead.findFirst({
      where: { orgId, phone, deletedAt: null, status: { notIn: CLOSED_LEAD_STATUSES } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The most recent earlier lead for this phone — becomes the new lead's previousLeadId. */
  findLatestByPhone(orgId: string, phone: string, tx: Tx = this.prisma): Promise<Lead | null> {
    return tx.lead.findFirst({ where: { orgId, phone }, orderBy: { createdAt: 'desc' } });
  }

  /** Logs the repeat enquiry on the existing lead and tells its assignee. */
  async recordReEnquiry(tx: Tx, lead: Lead, enquiry: ReEnquiry): Promise<Lead> {
    const now = new Date();
    await tx.leadActivityLog.create({
      data: {
        orgId: lead.orgId,
        leadId: lead.id,
        userId: enquiry.performedById ?? null,
        type: ActivityType.RE_ENQUIRY,
        message: `Enquired again via ${enquiry.channel} — matched to this lead by phone number, so no duplicate was created`,
        meta: {
          source: enquiry.source,
          channel: enquiry.channel,
          ...(enquiry.details ? { details: enquiry.details as Prisma.InputJsonObject } : {}),
        },
      },
    });

    const updated = await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: now } });

    if (enquiry.notify !== false && lead.assignedToId && lead.assignedToId !== enquiry.performedById) {
      await tx.notification.create({
        data: {
          orgId: lead.orgId,
          userId: lead.assignedToId,
          type: NotificationType.GENERIC,
          title: 'Lead enquired again',
          message: `${leadLabel(lead)} enquired again via ${enquiry.channel}.`,
          leadId: lead.id,
        },
      });
    }

    return updated;
  }
}

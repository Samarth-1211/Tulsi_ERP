import { Injectable } from '@nestjs/common';
import { LeadStatus, WhatsAppAdSource } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { AdReferral } from '../utils/whatsapp-payload.util';


/** `a Click-to-WhatsApp ad ("Green Valley Plots")`, for timeline and notification text. */
export function describeAd(ad: Pick<WhatsAppAdSource, 'headline'>): string {
  return `a Click-to-WhatsApp ad${ad.headline ? ` ("${ad.headline}")` : ''}`;
}

/**
 * The Click-to-WhatsApp ads an organization's leads come from, recorded the
 * first time each one sends a lead (with its copy as last seen).
 */
@Injectable()
export class WhatsAppAdSourceService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  /** Remembers the ad a message came from — its copy as last seen, and when. */
  record(orgId: string, referral: AdReferral): Promise<WhatsAppAdSource> {
    const seen = {
      sourceType: referral.sourceType,
      // An ad's copy can be edited while it runs; a referral that omits a
      // field doesn't blank what was seen before.
      ...(referral.headline ? { headline: referral.headline } : {}),
      ...(referral.body ? { body: referral.body } : {}),
      ...(referral.sourceUrl ? { sourceUrl: referral.sourceUrl } : {}),
    };

    return this.prisma.whatsAppAdSource.upsert({
      where: { orgId_adId: { orgId, adId: referral.adId } },
      create: { orgId, adId: referral.adId, ...seen },
      update: { ...seen, lastSeenAt: new Date() },
    });
  }


  /** Every ad seen so far, most recently active first, with how many leads it sent and how many still wait unassigned. */
  async list(actor: AuthenticatedUser) {
    const adSources = await this.prisma.whatsAppAdSource.findMany({
      where: { orgId: actor.orgId },
      include: {
        mappedBy: { select: { id: true, name: true } },
        _count: { select: { leads: true } },
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    const waiting = await this.prisma.lead.groupBy({
      by: ['adSourceId'],
      where: {
        orgId: actor.orgId,
        adSourceId: { in: adSources.map((a) => a.id) },
        assignedToId: null,
        status: LeadStatus.NEW,
      },
      _count: { _all: true },
    });
    const waitingByAd = new Map(waiting.map((w) => [w.adSourceId as string, w._count._all]));

    return adSources.map(({ _count, ...adSource }) => ({
      ...adSource,
      leadCount: _count.leads,
      waitingLeadCount: waitingByAd.get(adSource.id) ?? 0,
    }));
  }

}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UpdateAllocationSettingsDto } from './dto/update-allocation-settings.dto';

const SETTINGS_SELECT = {
  allocationMode: true,
  allocationTargetRole: true,
  allocateOnlyCheckedIn: true,
  autoReallocateLostLeads: true,
  updatedAt: true,
} as const;

/** GET/PATCH /settings/allocation — the org's OrgSettings allocation fields (row created on first use). */
@Injectable()
export class LeadAllocationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  get(actor: AuthenticatedUser) {
    return this.prisma.orgSettings.upsert({
      where: { orgId: actor.orgId },
      create: { orgId: actor.orgId },
      update: {},
      select: SETTINGS_SELECT,
    });
  }

  update(actor: AuthenticatedUser, dto: UpdateAllocationSettingsDto) {
    return this.prisma.orgSettings.upsert({
      where: { orgId: actor.orgId },
      create: { orgId: actor.orgId, ...dto },
      update: dto,
      select: SETTINGS_SELECT,
    });
  }
}

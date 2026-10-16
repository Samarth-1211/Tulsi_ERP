import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { WhatsAppAdSourceService } from '../services/whatsapp-ad-source.service';

// The Click-to-WhatsApp ads leads came from — Admin only, like the rest of
// the organization's WhatsApp setup.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('whatsapp/ad-sources')
export class WhatsAppAdSourcesController {
  constructor(private readonly adSources: WhatsAppAdSourceService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.adSources.list(user);
  }

}

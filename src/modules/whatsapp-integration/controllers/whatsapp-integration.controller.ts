import { Body, Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { WhatsAppIntegrationService } from '../services/whatsapp-integration.service';
import { ConnectWhatsAppIntegrationDto } from '../dto/connect-whatsapp-integration.dto';
import { UpdateWhatsAppIntegrationDto } from '../dto/update-whatsapp-integration.dto';

// Admin/Super Admin only, same as platform-integrations — this is org-wide
// WhatsApp API credential configuration, not a per-user setting.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('integrations/whatsapp')
export class WhatsAppIntegrationController {
  constructor(private readonly service: WhatsAppIntegrationService) {}

  // Validates WABA ID + Phone Number ID + Access Token against Meta live
  // before saving anything. On success, returns the generated webhook URL +
  // verify token (shown once here, then only via reveal-verify-token).
  @Post()
  connect(@Body() dto: ConnectWhatsAppIntegrationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.connect(user.orgId, dto);
  }

  // Read-only status check — opened up to every role (not just Admin/Super
  // Admin) so the WhatsApp Inbox page can tell whether to show real
  // conversations or its "not connected yet" demo preview, regardless of
  // who's viewing it. Non-admins get a status-only view with no Meta
  // account identifiers or webhook URL.
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CALLER)
  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getForOrg(user.orgId, user.role);
  }

  @Post('reveal-verify-token')
  revealVerifyToken(@CurrentUser() user: AuthenticatedUser) {
    return this.service.revealVerifyToken(user.orgId);
  }

  // Also how a rotated/expired access token gets replaced — re-validated
  // live against Meta before the new one is saved.
  @Patch()
  update(@Body() dto: UpdateWhatsAppIntegrationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(user.orgId, dto);
  }

  @Post('enable')
  enable(@CurrentUser() user: AuthenticatedUser) {
    return this.service.enable(user.orgId);
  }

  @Delete()
  disable(@CurrentUser() user: AuthenticatedUser) {
    return this.service.disable(user.orgId);
  }

  // Unlike DELETE above (a reversible "disable"), this wipes the integration,
  // its chat history and webhook log so another number can be connected.
  @Delete('permanent')
  remove(@CurrentUser() user: AuthenticatedUser) {
    return this.service.remove(user.orgId);
  }
}

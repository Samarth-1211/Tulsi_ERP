import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { PlatformIntegrationService } from '../services/platform-integration.service';
import { CreatePlatformIntegrationDto } from '../dto/create-platform-integration.dto';
import { UpdatePlatformIntegrationDto } from '../dto/update-platform-integration.dto';

// Default: Admin only. Managers get read-only access via
// per-method @Roles overrides on findAll/findOne below (see there) —
// they can see where leads come from, but never the webhook credentials
// (URL/token/secret) and cannot touch webhook config.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('platform-integrations')
export class PlatformIntegrationController {
  constructor(
    private readonly platformIntegrationService: PlatformIntegrationService,
  ) {}

  // Creates the integration and returns the webhook URL + sample payload
  // (and, for Meta forms, the native callback URL + verify token).
  @Post()
  create(
    @Body() dto: CreatePlatformIntegrationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.platformIntegrationService.create(user.orgId, dto);
  }

  // List view — secret withheld here. This is for monitoring status
  // (isActive, lastReceivedAt), not credential retrieval. Managers can
  // view integrations for visibility into where their leads come from,
  // but get no webhook URL/secret and cannot create/edit/deactivate them.
  @Roles(Role.ADMIN, Role.MANAGER)
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.platformIntegrationService.findAllForOrg(user.orgId, user.role);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.platformIntegrationService.findOneForOrg(
      id,
      user.orgId,
      user.role,
    );
  }

  // Explicit, separate action to re-reveal the secret (e.g. RM lost
  // it, needs to be resent). Keeping this apart from GET means the
  // secret is never returned on a routine page load.
  @Post(':id/reveal-secret')
  revealSecret(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.platformIntegrationService.revealSecret(
      id,
      user.orgId,
    );
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePlatformIntegrationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.platformIntegrationService.update(
      id,
      user.orgId,
      dto,
    );
  }

  // Soft action — sets status INACTIVE rather than hard-deleting.
  // Past leads still reference this platform, and RM contact history
  // is worth keeping even after a platform relationship ends.
  @Delete(':id')
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.platformIntegrationService.deactivate(
      id,
      user.orgId,
    );
  }
}

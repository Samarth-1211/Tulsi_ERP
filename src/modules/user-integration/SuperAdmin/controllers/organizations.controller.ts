import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { OrganizationsService } from '../services/organizations.service';
import { CreateOrganizationDto } from '../dto/organisations.dto';
import { UpdateOrganizationDto } from '../dto/update-organization.dto';
import { SuspendOrganizationDto } from '../dto/suspend-organization.dto';
import { ReactivateOrganizationDto } from '../dto/reactivate-organization.dto';
import { ListOrganizationsQueryDto } from '../dto/list-organizations-query.dto';
import { CreateOrgAdminDto } from '../dto/create-org-admin.dto';

@ApiTags('organizations')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new Organization and its first Admin user' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.organizationsService.createOrganization(actor, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all Organizations, optionally filtered by status/plan/search' })
  findAll(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListOrganizationsQueryDto) {
    return this.organizationsService.findAll(actor, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single Organization by id' })
  findOne(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.organizationsService.findOne(actor, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace an Organization\'s editable details (full update)' })
  replace(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOrganization(actor, id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Partially update an Organization\'s editable details' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOrganization(actor, id, dto);
  }

  @Post(':id/admin')
  @ApiOperation({ summary: 'Add an Admin user to an Organization — any number of Admins allowed, any time' })
  addAdmin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateOrgAdminDto,
  ) {
    return this.organizationsService.addAdmin(actor, id, dto);
  }

  @Post(':id/resend-verification')
  @ApiOperation({ summary: "Resend the verification email to every not-yet-verified admin in this organization" })
  resendAdminVerification(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.organizationsService.resendAdminVerification(actor, id);
  }

  @Patch(':id/suspend')
  @ApiOperation({ summary: 'Suspend an Organization, disabling all of its users' })
  suspend(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SuspendOrganizationDto,
  ) {
    return this.organizationsService.suspendOrganization(actor, id, dto);
  }

  @Patch(':id/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended Organization' })
  reactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReactivateOrganizationDto,
  ) {
    return this.organizationsService.reactivateOrganization(actor, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive (soft-delete) an Organization' })
  archive(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.organizationsService.archiveOrganization(actor, id);
  }
}

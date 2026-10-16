import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { ManagerService } from '../services/manager.service';
import { CreateTeamMemberDto } from '../dto/create-team-member.dto';
import { UpdateTeamMemberDto } from '../dto/update-team-member.dto';
import { TeamMemberQueryDto } from '../dto/team-member-query.dto';
import { AssignLeadToTeamMemberDto } from '../dto/assign-lead-to-team-member.dto';
import { DeleteUserDto } from '../../SuperAdmin/dto/delete-user.dto';

// Managers create/manage their own CALLER, DELIVERY_PARTNER and WAREHOUSE_STAFF team
// members. ADMIN/SUPER_ADMIN can also hit these endpoints (e.g. support,
// org setup) — the service layer still scopes queries/mutations to the
// acting user's own managerId relationship for MANAGER-role actors.
@ApiTags('manager')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
@Controller('manager')
export class ManagerController {
  constructor(private readonly managerService: ManagerService) {}

  @Post('team-members')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Create a CALLER, DELIVERY_PARTNER or WAREHOUSE_STAFF under the acting manager (managerId = self)' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTeamMemberDto) {
    return this.managerService.createTeamMember(actor, dto);
  }

  @Get('team-members')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "List the manager's team, filterable by role/status" })
  findAll(@CurrentUser() actor: AuthenticatedUser, @Query() query: TeamMemberQueryDto) {
    return this.managerService.findTeamMembers(actor, query);
  }

  @Get('team-members/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Fetch a single team member' })
  findOne(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managerService.findOneTeamMember(actor, id);
  }

  @Patch('team-members/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Update a team member (name / active status)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.managerService.updateTeamMember(actor, id, dto);
  }

  @Post('team-members/:id/resend-verification')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Resend a team member's verification email with a fresh 24-hour link" })
  resendVerification(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managerService.resendVerification(actor, id);
  }

  @Get('team-members/:id/deletion-impact')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'What deleting a team member would hand over (open leads, tasks) and who can take it' })
  deletionImpact(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managerService.getTeamMemberDeletionImpact(actor, id);
  }

  @Delete('team-members/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Delete a team member — their open leads and tasks go to the chosen teammate' })
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: DeleteUserDto) {
    return this.managerService.deleteTeamMember(actor, id, dto);
  }

  @Get('peers')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The other active Managers in the org — who a manager can hand one of their leads over to' })
  findPeers(@CurrentUser() actor: AuthenticatedUser) {
    return this.managerService.findPeerManagers(actor);
  }

  @Patch('leads/:leadId/assign')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Assign a lead to one of the manager's own team members" })
  assignLead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('leadId') leadId: string,
    @Body() dto: AssignLeadToTeamMemberDto,
  ) {
    return this.managerService.assignLeadToTeamMember(actor, leadId, dto.userId);
  }
}

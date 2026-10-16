import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { EmployeesService } from '../services/employees.service';
import { UpdateProfileDto, UpdateEmployeeCodeDto, ChangeEmailDto, ChangePasswordDto } from '../dto/update-profile.dto';

@ApiTags('employees')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get('team-summary')
  @Roles(Role.MANAGER)
  @ApiOperation({ summary: "Manager's view of their direct team's active lead workload" })
  getTeamSummary(@CurrentUser() actor: AuthenticatedUser) {
    return this.employeesService.getTeamSummary(actor);
  }

  @Get('team-rollup')
  @Roles(Role.MANAGER)
  @ApiOperation({ summary: "Manager's single-view rollup: today's attendance + lead snapshot + target progress per team member" })
  getTeamRollup(@CurrentUser() actor: AuthenticatedUser) {
    return this.employeesService.getTeamRollup(actor);
  }

  // Declared before ':id/profile' so a literal path of "/employees/me/profile"
  // is not swallowed by the dynamic ':id' route below.
  @Patch('me/profile')
  @ApiOperation({ summary: 'Update the caller\'s own phone number / profile photo' })
  updateMyProfile(@CurrentUser() actor: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.employeesService.updateMyProfile(actor, dto);
  }

  @Patch('me/email')
  @ApiOperation({ summary: "Change the caller's own login email (requires current password)" })
  changeMyEmail(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ChangeEmailDto) {
    return this.employeesService.changeEmail(actor, dto);
  }

  @Patch('me/password')
  @ApiOperation({ summary: "Change the caller's own password (requires current password)" })
  changeMyPassword(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.employeesService.changePassword(actor, dto);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Active workload, conversions, and status breakdown for a single employee' })
  getSummary(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.employeesService.getSummary(actor, id);
  }

  @Get(':id/profile')
  @ApiOperation({ summary: 'Profile details (contact, joining date, manager, active status) for a single employee' })
  getProfile(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.employeesService.getProfile(actor, id);
  }

  @Get(':id/overview')
  @ApiOperation({
    summary:
      'Full detail for a single employee (Admin user detail page): profile, lead pipeline and assigned leads, leave history, target, projects, direct reports and tasks',
  })
  getOverview(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.employeesService.getOverview(actor, id);
  }

  @Patch(':id/employee-code')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Assign a human-readable employee code (Manager for their own reports, Admin for anyone in the org)' })
  setEmployeeCode(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateEmployeeCodeDto) {
    return this.employeesService.setEmployeeCode(actor, id, dto);
  }
}

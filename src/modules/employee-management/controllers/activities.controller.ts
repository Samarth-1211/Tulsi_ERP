import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ActivitiesService } from '../services/activities.service';
import { LogActivityDto } from '../dto/log-activity.dto';
import { ActivityReportQueryDto } from '../dto/activity-report-query.dto';

@ApiTags('activities')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Post()
  @ApiOperation({ summary: 'Log what you did today (call, WhatsApp, site visit, etc.) — optionally linked to a lead' })
  log(@CurrentUser() actor: AuthenticatedUser, @Body() dto: LogActivityDto) {
    return this.activitiesService.log(actor, dto);
  }

  @Get('me')
  @ApiQuery({ name: 'date', required: false, example: '2026-09-16' })
  @ApiOperation({ summary: "Get the caller's own activity log for a single day (defaults to today)" })
  getMine(@CurrentUser() actor: AuthenticatedUser, @Query('date') date?: string) {
    return this.activitiesService.getMine(actor, date);
  }

  @Get('team')
  @Roles(Role.MANAGER)
  @ApiQuery({ name: 'date', required: false, example: '2026-09-16' })
  @ApiOperation({ summary: "Manager's rollup of their team's activity for a single day (defaults to today)" })
  getTeam(@CurrentUser() actor: AuthenticatedUser, @Query('date') date?: string) {
    return this.activitiesService.getTeamForDate(actor, date);
  }

  @Get('org')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiQuery({ name: 'date', required: false, example: '2026-09-16' })
  @ApiOperation({ summary: 'Org-wide activity rollup for a single day (Admin/Super Admin only)' })
  getOrg(@CurrentUser() actor: AuthenticatedUser, @Query('date') date?: string) {
    return this.activitiesService.getOrgForDate(actor, date);
  }

  @Get('report')
  @ApiOperation({
    summary:
      'Day-by-day attendance + activity report for one employee over a date range (self, their Manager, or Admin) — the source for the Daily/Weekly/Monthly employee report',
  })
  getReport(@CurrentUser() actor: AuthenticatedUser, @Query() query: ActivityReportQueryDto) {
    return this.activitiesService.getReport(actor, query.employeeId, query.from, query.to);
  }

  @Get(':employeeId')
  @ApiQuery({ name: 'date', required: false, example: '2026-09-16' })
  @ApiOperation({ summary: 'Activity log for a specific employee (self, their Manager, or Admin)' })
  getForEmployee(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
    @Query('date') date?: string,
  ) {
    return this.activitiesService.getForEmployee(actor, employeeId, date);
  }
}

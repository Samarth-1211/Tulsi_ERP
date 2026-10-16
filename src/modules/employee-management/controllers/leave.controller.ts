import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LeaveStatus, Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { LeaveService } from '../services/leave.service';
import { ApplyLeaveDto } from '../dto/apply-leave.dto';
import { ReviewLeaveDto } from '../dto/review-leave.dto';

@ApiTags('leave')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('leave')
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Post('apply')
  @ApiOperation({ summary: 'Apply for leave for a date range, pending Manager approval' })
  apply(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ApplyLeaveDto) {
    return this.leaveService.apply(actor, dto);
  }

  @Get('me')
  @ApiOperation({ summary: "Caller's own leave request history" })
  getMine(@CurrentUser() actor: AuthenticatedUser) {
    return this.leaveService.getMine(actor);
  }

  @Get('team/pending')
  @Roles(Role.MANAGER)
  @ApiOperation({ summary: "Pending leave requests from the Manager's direct team" })
  getTeamPending(@CurrentUser() actor: AuthenticatedUser) {
    return this.leaveService.getTeamPending(actor);
  }

  @Get('org')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiQuery({ name: 'status', required: false, enum: LeaveStatus })
  @ApiOperation({ summary: 'All leave requests org-wide, optionally filtered by status (Admin/Super Admin only)' })
  getOrg(@CurrentUser() actor: AuthenticatedUser, @Query('status') status?: LeaveStatus) {
    return this.leaveService.getOrgLeaveRequests(actor, status);
  }

  @Patch(':id/approve')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve a leave request; backfills attendance as On-Leave for the requested dates' })
  approve(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReviewLeaveDto) {
    return this.leaveService.approve(actor, id, dto);
  }

  @Patch(':id/reject')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Reject a leave request' })
  reject(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReviewLeaveDto) {
    return this.leaveService.reject(actor, id, dto);
  }
}

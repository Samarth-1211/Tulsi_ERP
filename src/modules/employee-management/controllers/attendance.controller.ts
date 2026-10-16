import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ATTENDANCE_ROLES, AttendanceService } from '../services/attendance.service';
import { CheckInDto } from '../dto/check-in.dto';
import { CheckOutDto } from '../dto/check-out.dto';
import { AttendanceListQueryDto, AttendanceRangeQueryDto } from '../dto/attendance-range-query.dto';

@ApiTags('attendance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('check-in')
  @Roles(...ATTENDANCE_ROLES)
  @ApiOperation({ summary: 'Check in for today (once per org-local day; a second check-in returns 409)' })
  checkIn(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CheckInDto) {
    return this.attendanceService.checkIn(actor, dto);
  }

  @Post('check-out')
  @Roles(...ATTENDANCE_ROLES)
  @ApiOperation({ summary: 'Check out with the required work summary (min length from org settings, else 400); computes workedMinutes' })
  checkOut(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CheckOutDto) {
    return this.attendanceService.checkOut(actor, dto);
  }

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Attendance rows for a date range — Admin: whole org; Manager: own team only. Optional userId filter.' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: AttendanceListQueryDto) {
    return this.attendanceService.list(actor, query);
  }

  @Get('today')
  @ApiOperation({ summary: "Get the caller's own attendance status for today" })
  getToday(@CurrentUser() actor: AuthenticatedUser) {
    return this.attendanceService.getToday(actor);
  }

  @Get('me')
  @ApiOperation({ summary: "Get the caller's own attendance history for a date range" })
  getMine(@CurrentUser() actor: AuthenticatedUser, @Query() query: AttendanceRangeQueryDto) {
    return this.attendanceService.getMyAttendance(actor, query);
  }

  @Get('team')
  @Roles(Role.MANAGER)
  @ApiQuery({ name: 'date', required: false, example: '2026-09-16' })
  @ApiOperation({ summary: "Manager's rollup of their team's attendance for a single day (defaults to today)" })
  getTeam(@CurrentUser() actor: AuthenticatedUser, @Query('date') date?: string) {
    return this.attendanceService.getTeamAttendanceForDate(actor, date);
  }

  @Get('org')
  @Roles(Role.ADMIN)
  @ApiQuery({ name: 'date', required: false, example: '2026-09-16' })
  @ApiOperation({ summary: 'Org-wide attendance rollup for a single day; no row = ABSENT (Admin only)' })
  getOrg(@CurrentUser() actor: AuthenticatedUser, @Query('date') date?: string) {
    return this.attendanceService.getOrgAttendanceForDate(actor, date);
  }

  @Get(':employeeId')
  @ApiOperation({ summary: 'Attendance history for a specific employee (self, their Manager, or Admin)' })
  getForEmployee(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
    @Query() query: AttendanceRangeQueryDto,
  ) {
    return this.attendanceService.getEmployeeAttendance(actor, employeeId, query);
  }
}

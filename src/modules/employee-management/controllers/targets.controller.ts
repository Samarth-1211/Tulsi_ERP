import { Controller, Get, Put, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseTargetPeriod, TargetsService } from '../services/targets.service';
import { SetTargetDto } from '../dto/set-target.dto';

@ApiTags('targets')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('targets')
export class TargetsController {
  constructor(private readonly targetsService: TargetsService) {}

  @Put()
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: "Set (or update) an employee's monthly target — a Manager for their direct reports, an Admin for any Manager or executive",
  })
  setTarget(@CurrentUser() actor: AuthenticatedUser, @Body() dto: SetTargetDto) {
    return this.targetsService.setTarget(actor, dto);
  }

  @Get('me')
  @ApiQuery({ name: 'year', required: false, example: 2026 })
  @ApiQuery({ name: 'month', required: false, example: 9 })
  @ApiOperation({ summary: "Caller's own target vs actual for a given month (defaults to current month)" })
  getMine(@CurrentUser() actor: AuthenticatedUser, @Query('year') year?: string, @Query('month') month?: string) {
    const period = parseTargetPeriod(year, month);
    return this.targetsService.getMyProgress(actor, period.year, period.month);
  }

  @Get('team')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiQuery({ name: 'year', required: false, example: 2026 })
  @ApiQuery({ name: 'month', required: false, example: 9 })
  @ApiOperation({
    summary: "Target vs actual for a month — a Manager's direct reports, or every Manager and executive for an Admin",
  })
  getTeam(@CurrentUser() actor: AuthenticatedUser, @Query('year') year?: string, @Query('month') month?: string) {
    const period = parseTargetPeriod(year, month);
    return this.targetsService.getTeamProgress(actor, period.year, period.month);
  }
}

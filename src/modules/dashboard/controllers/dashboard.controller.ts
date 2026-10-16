import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { DashboardService } from '../services/dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Role-specific stats: Admin — org lead totals + source breakdown; Manager — team leads + team attendance; ' +
      "Caller — my leads, today's follow-ups, my attendance; Delivery/Warehouse — attendance only",
  })
  me(@CurrentUser() actor: AuthenticatedUser) {
    return this.dashboardService.forUser(actor);
  }
}

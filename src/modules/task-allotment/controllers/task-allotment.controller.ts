import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { TaskAllotmentService } from '../services/task-allotment.service';
import { UpdateTaskAllotmentSettingsDto } from '../dto/update-task-allotment-settings.dto';

@ApiTags('task-allotment')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('task-allotment')
export class TaskAllotmentController {
  constructor(private readonly allotment: TaskAllotmentService) {}

  @Get('me')
  @Roles(Role.ADMIN, Role.MANAGER, Role.CALLER)
  @ApiOperation({
    summary: "Today's automatically allotted old leads",
    description:
      'Built on the first call of the day once the user has no untouched leads and no follow-ups due today. ' +
      '`workLeft` counts what still comes first; `items` is the batch, rank 1 first.',
  })
  forMe(@CurrentUser() actor: AuthenticatedUser) {
    return this.allotment.forMe(actor);
  }

  @Get('overview')
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "Per person: today's batch progress and allotted leads converted over the look-back window (Manager: self + team)" })
  overview(@CurrentUser() actor: AuthenticatedUser) {
    return this.allotment.overview(actor);
  }

  @Patch(':id/skip')
  @Roles(Role.ADMIN, Role.MANAGER, Role.CALLER)
  @ApiOperation({ summary: "Skip one of today's allotted leads" })
  skip(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.allotment.skip(actor, id);
  }
}

@ApiTags('settings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('settings')
export class TaskAllotmentSettingsController {
  constructor(private readonly allotment: TaskAllotmentService) {}

  @Get('task-allotment')
  @ApiOperation({ summary: 'Automated Task Allotment settings (Admin)' })
  get(@CurrentUser() actor: AuthenticatedUser) {
    return this.allotment.getSettings(actor);
  }

  @Patch('task-allotment')
  @ApiOperation({ summary: 'Set batch size, look-back window, eligibility, priority and filters (Admin)' })
  update(@CurrentUser() actor: AuthenticatedUser, @Body() dto: UpdateTaskAllotmentSettingsDto) {
    return this.allotment.updateSettings(actor, dto);
  }
}

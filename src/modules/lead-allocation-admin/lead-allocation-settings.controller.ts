import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { LeadAllocationSettingsService } from './lead-allocation-settings.service';
import { UpdateAllocationSettingsDto } from './dto/update-allocation-settings.dto';

@ApiTags('settings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('settings')
export class LeadAllocationSettingsController {
  constructor(private readonly settingsService: LeadAllocationSettingsService) {}

  @Get('allocation')
  @ApiOperation({ summary: 'Allocation mode, round-robin target role and allocateOnlyCheckedIn (Admin)' })
  get(@CurrentUser() actor: AuthenticatedUser) {
    return this.settingsService.get(actor);
  }

  @Patch('allocation')
  @ApiOperation({ summary: 'Set allocation mode (ROUND_ROBIN / MANUAL), target role and allocateOnlyCheckedIn (Admin)' })
  update(@CurrentUser() actor: AuthenticatedUser, @Body() dto: UpdateAllocationSettingsDto) {
    return this.settingsService.update(actor, dto);
  }
}

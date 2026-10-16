import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { ManagersService } from '../services/managers.service';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { DeleteManagerDto } from '../dto/delete-manager.dto';

@ApiTags('managers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('managers')
export class ManagersController {
  constructor(private readonly managersService: ManagersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a Manager within the Admin\'s organization' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateManagerDto) {
    return this.managersService.createManager(actor, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all Managers in the Admin\'s organization' })
  findAll(@CurrentUser() actor: AuthenticatedUser) {
    return this.managersService.findAll(actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single Manager, enforcing organization scoping' })
  findOne(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managersService.findOne(actor, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a Manager\'s details' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateManagerDto,
  ) {
    return this.managersService.updateManager(actor, id, dto);
  }

  @Post(':id/resend-verification')
  @ApiOperation({ summary: "Resend a Manager's verification email with a fresh 24-hour link" })
  resendVerification(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managersService.resendVerification(actor, id);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a Manager account' })
  deactivate(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managersService.deactivateManager(actor, id);
  }

  @Patch(':id/reactivate')
  @ApiOperation({ summary: 'Reactivate a deactivated Manager account' })
  reactivate(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.managersService.reactivateManager(actor, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a Manager — their team and open work must be handed over (see GET /users/:id/deletion-impact)' })
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeleteManagerDto,
  ) {
    return this.managersService.deleteManager(actor, id, dto);
  }
}

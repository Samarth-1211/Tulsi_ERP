import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { UsersService } from '../services/users.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { DeleteUserDto } from '../dto/delete-user.dto';

@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Create a subordinate user account according to the role hierarchy' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.usersService.createUser(actor, dto);
  }

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'List users scoped to the caller organization (and team, for Managers)' })
  @ApiQuery({ name: 'deleted', required: false, description: '"true" lists deleted (archived) accounts instead — Admins only' })
  findAll(@CurrentUser() actor: AuthenticatedUser, @Query('deleted') deleted?: string) {
    return this.usersService.findAll(actor, deleted === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single user, enforcing organization/team scoping' })
  findOne(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.findOne(actor, id);
  }

  @Patch(':id/deactivate')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Deactivate a user account' })
  deactivate(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.deactivate(actor, id);
  }

  @Patch(':id/reactivate')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Reactivate a deactivated user account' })
  reactivate(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.reactivate(actor, id);
  }

  @Get(':id/deletion-impact')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'What deleting this user would hand over (open leads, tasks, team) and who can take it' })
  deletionImpact(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.getDeletionImpact(actor, id);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: 'Delete a user — hands over their open work, archives the account and frees the email for re-use',
  })
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeleteUserDto,
  ) {
    return this.usersService.deleteUser(actor, id, dto);
  }
}

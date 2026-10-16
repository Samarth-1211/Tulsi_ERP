import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { TasksService } from '../services/tasks.service';
import { CreateTaskDto } from '../dto/create-task.dto';
import { UpdateTaskDto } from '../dto/update-task.dto';
import { TaskQueryDto } from '../dto/task-query.dto';

@ApiTags('tasks')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @ApiOperation({ summary: 'Create a personal to-do task, optionally linked to a lead with reminder offsets' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(actor, dto);
  }

  @Get('me')
  @ApiOperation({ summary: "List the caller's own tasks (personal + assigned to them), optionally filtered by source" })
  findMine(@CurrentUser() actor: AuthenticatedUser, @Query() query: TaskQueryDto) {
    return this.tasksService.findMine(actor, query);
  }

  @Get('assigned-by-me')
  @ApiOperation({ summary: 'List tasks the caller has assigned to other users (Manager/Admin delegation view)' })
  findAssignedByMe(@CurrentUser() actor: AuthenticatedUser, @Query() query: TaskQueryDto) {
    return this.tasksService.findAssignedByMe(actor, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single task (owner only)' })
  findOne(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.findOne(actor, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a task (owner only) — recomputes reminders if dueAt or offsets change' })
  update(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasksService.update(actor, id, dto);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Mark a task complete and cancel its pending reminders' })
  complete(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.complete(actor, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task (owner only)' })
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.remove(actor, id);
  }
}

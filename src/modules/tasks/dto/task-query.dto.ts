import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { TaskStatus } from '@prisma/client';

/** Bifurcates the caller's own task list: tasks they created for themselves
 * vs tasks a Manager/Admin assigned to them. `ALL` (default) returns both. */
export enum TaskSourceFilter {
  ALL = 'ALL',
  PERSONAL = 'PERSONAL',
  ASSIGNED_TO_ME = 'ASSIGNED_TO_ME',
}

export class TaskQueryDto {
  @ApiProperty({ enum: TaskStatus, required: false })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiProperty({ enum: TaskSourceFilter, required: false, default: TaskSourceFilter.ALL })
  @IsOptional()
  @IsEnum(TaskSourceFilter)
  source?: TaskSourceFilter;

  @ApiProperty({ required: false, example: '2026-09-01', description: 'Only tasks due on/after this date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, example: '2026-09-30', description: 'Only tasks due on/before this date' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, description: 'Only tasks linked to this lead' })
  @IsOptional()
  @IsString()
  leadId?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { TaskPriority, TaskType } from '@prisma/client';

export class CreateTaskDto {
  @ApiProperty({ example: 'Follow up with Rahul about the Bandra 3BHK' })
  @IsNotEmpty()
  @IsString()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: TaskType, required: false })
  @IsOptional()
  @IsEnum(TaskType)
  taskType?: TaskType;

  @ApiProperty({ enum: TaskPriority, required: false, default: TaskPriority.NORMAL })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiProperty({
    required: false,
    description:
      'Assign this task to another user instead of yourself. Managers may only assign to their own direct reports; Admins/Super Admins may assign to anyone in the organization.',
  })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiProperty({ required: false, example: '2026-09-20T10:30:00.000Z', description: 'When this task is due; drives reminders' })
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @ApiProperty({ required: false, description: 'Link this task to a specific lead' })
  @IsOptional()
  @IsString()
  leadId?: string;

  @ApiProperty({
    required: false,
    type: [Number],
    example: [1440, 360],
    description:
      'Minutes before dueAt to send a reminder. Defaults to [1440, 360] (1 day + 6 hours before) when dueAt is set and this is omitted. Pass [] for no reminders.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  reminderOffsetsMinutes?: number[];
}

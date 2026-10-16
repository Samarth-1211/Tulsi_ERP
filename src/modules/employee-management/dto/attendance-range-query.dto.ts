import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

export class AttendanceRangeQueryDto {
  @ApiProperty({ required: false, example: '2026-09-01', description: 'Defaults to the start of the current month' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, example: '2026-09-30', description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AttendanceListQueryDto extends AttendanceRangeQueryDto {
  @ApiProperty({ required: false, description: 'Only this employee (Managers: must be on their team)' })
  @IsOptional()
  @IsString()
  userId?: string;
}

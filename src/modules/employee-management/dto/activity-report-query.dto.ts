import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

export class ActivityReportQueryDto {
  @ApiProperty({ required: false, description: 'Defaults to the caller themself' })
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-09-30' })
  @IsDateString()
  to!: string;
}

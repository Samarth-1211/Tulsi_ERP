import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

export class ApplyLeaveDto {
  @ApiProperty({ example: '2026-09-20' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-09-21' })
  @IsDateString()
  endDate!: string;

  @ApiProperty({ example: 'Family function' })
  @IsNotEmpty()
  @IsString()
  reason!: string;
}

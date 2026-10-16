import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsString, Max, Min } from 'class-validator';
import { TargetMetric } from '@prisma/client';

export class SetTargetDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsString()
  userId!: string;

  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(2020)
  periodYear!: number;

  @ApiProperty({ example: 9, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth!: number;

  @ApiProperty({ enum: TargetMetric, example: TargetMetric.CONVERSIONS })
  @IsEnum(TargetMetric)
  metric!: TargetMetric;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  targetValue!: number;
}

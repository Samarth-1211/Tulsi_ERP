import { ApiProperty } from '@nestjs/swagger';
import { AllotmentEligibility, AllotmentPriority } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Priorities an org can pick — HIGHEST_VALUE is retired with lead value. */
export const ALLOTMENT_PRIORITIES = Object.values(AllotmentPriority).filter((p) => p !== AllotmentPriority.HIGHEST_VALUE);

export class UpdateTaskAllotmentSettingsDto {
  @ApiProperty({ required: false, description: 'Hand callers a batch of old leads once their day’s work is done' })
  @IsOptional()
  @IsBoolean()
  autoAllotEnabled?: boolean;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, description: 'Leads per caller per day (default 15)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  autoAllotBatchSize?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 365, description: 'Only leads that came in within this many days (default 30, rolling)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  autoAllotLookbackDays?: number;

  @ApiProperty({ required: false, minimum: 0, maximum: 60, description: 'Skip leads contacted within this many days (default 2)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  autoAllotRestDays?: number;


  @ApiProperty({ required: false, description: 'Also allot leads already marked LOST' })
  @IsOptional()
  @IsBoolean()
  autoAllotIncludeLost?: boolean;

  @ApiProperty({ required: false, enum: AllotmentEligibility, description: 'NOT_CONNECTED: last call was NO_ANSWER. CONTACTED_OPEN: any contacted lead not converted.' })
  @IsOptional()
  @IsEnum(AllotmentEligibility)
  autoAllotEligibility?: AllotmentEligibility;

  @ApiProperty({ required: false, enum: ALLOTMENT_PRIORITIES, description: 'Which leads are called first' })
  @IsOptional()
  @IsIn(ALLOTMENT_PRIORITIES)
  autoAllotPriority?: AllotmentPriority;

  @ApiProperty({ required: false, enum: ALLOTMENT_PRIORITIES, description: 'Tie-breaker when two leads rank the same' })
  @IsOptional()
  @IsIn(ALLOTMENT_PRIORITIES)
  autoAllotThenBy?: AllotmentPriority;
}

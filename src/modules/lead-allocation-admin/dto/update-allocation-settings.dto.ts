import { ApiProperty } from '@nestjs/swagger';
import { AllocationMode, Role } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsOptional } from 'class-validator';

/** Roles new leads may be round-robined to. */
export const ALLOCATION_TARGET_ROLES = [Role.MANAGER, Role.CALLER] as const;

export class UpdateAllocationSettingsDto {
  @ApiProperty({ required: false, enum: AllocationMode, description: 'ROUND_ROBIN: auto-assign new leads. MANUAL: leave them NEW for an Admin.' })
  @IsOptional()
  @IsEnum(AllocationMode)
  allocationMode?: AllocationMode;

  @ApiProperty({ required: false, enum: ALLOCATION_TARGET_ROLES, description: 'Who new leads rotate across (default MANAGER)' })
  @IsOptional()
  @IsIn(ALLOCATION_TARGET_ROLES)
  allocationTargetRole?: (typeof ALLOCATION_TARGET_ROLES)[number];

  @ApiProperty({ required: false, description: 'Only users with a CHECKED_IN attendance row today receive leads' })
  @IsOptional()
  @IsBoolean()
  allocateOnlyCheckedIn?: boolean;

  @ApiProperty({ required: false, description: 'Hand a lead to someone else the moment it is marked LOST (RCRM feature)' })
  @IsOptional()
  @IsBoolean()
  autoReallocateLostLeads?: boolean;
}

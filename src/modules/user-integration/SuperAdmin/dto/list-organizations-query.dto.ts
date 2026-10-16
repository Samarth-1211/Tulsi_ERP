import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type OrganizationStatusFilter = (typeof ORGANIZATION_STATUSES)[number];

export class ListOrganizationsQueryDto {
  @ApiProperty({ enum: ORGANIZATION_STATUSES, required: false })
  @IsOptional()
  @IsIn(ORGANIZATION_STATUSES)
  status?: OrganizationStatusFilter;

  @ApiProperty({ required: false, example: 'tulsi' })
  @IsOptional()
  @IsString()
  search?: string;
}

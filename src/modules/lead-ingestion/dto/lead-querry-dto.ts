import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CustomerType, LeadSource, LeadStatus } from '@prisma/client';

/** GET /leads filters + pagination (page / pageSize, as in RCRM's team-member list). */
export class LeadQueryDto {
  @ApiProperty({ required: false, enum: LeadStatus }) @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;
  @ApiProperty({ required: false, enum: LeadSource }) @IsOptional() @IsEnum(LeadSource) source?: LeadSource;
  @ApiProperty({ required: false, enum: CustomerType }) @IsOptional() @IsEnum(CustomerType) customerType?: CustomerType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() assignedToId?: string;
  @ApiProperty({ required: false, example: 'Indore' }) @IsOptional() @IsString() city?: string;

  @ApiProperty({ required: false, example: '2026-10-01', description: 'createdAt from (inclusive)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, example: '2026-10-31', description: 'createdAt to (inclusive, whole day)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, description: 'Name or phone contains' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 25;
}

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LeadSource, LeadStatus } from '@prisma/client';

/** GET /leads filters + pagination (page / pageSize, as in RCRM's team-member list). */
export class LeadQueryDto {
  @ApiProperty({ required: false, enum: LeadStatus }) @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;
  @ApiProperty({ required: false, enum: LeadSource }) @IsOptional() @IsEnum(LeadSource) source?: LeadSource;
  @ApiProperty({ required: false }) @IsOptional() @IsString() assignedToId?: string;
  @ApiProperty({ required: false, example: 'Indore' }) @IsOptional() @IsString() city?: string;
  @ApiProperty({ required: false, description: 'Exact stored value (see GET /leads/filter-options)' }) @IsOptional() @IsString() buyingFor?: string;
  @ApiProperty({ required: false, description: 'Exact stored value (see GET /leads/filter-options)' }) @IsOptional() @IsString() requirement?: string;
  @ApiProperty({ required: false, description: 'Admin only: a Meta ad id, or "none" for leads without one' }) @IsOptional() @IsString() adId?: string;
  @ApiProperty({ required: false, enum: ['newest', 'oldest', 'ad'], description: '"ad" (group by ad id) is Admin only' })
  @IsOptional()
  @IsIn(['newest', 'oldest', 'ad'])
  sort?: 'newest' | 'oldest' | 'ad';
  @ApiProperty({ required: false, enum: ['true', 'false'] }) @IsOptional() @IsIn(['true', 'false']) hasFeedback?: 'true' | 'false';

  @ApiProperty({ required: false, example: '2026-10-01', description: 'Lead date from (inclusive)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, example: '2026-10-31', description: 'createdAt to (inclusive, whole day)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, description: 'Name or phone contains; names also match across Hindi/English spellings ("ramesh" finds "रमेश")' })
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

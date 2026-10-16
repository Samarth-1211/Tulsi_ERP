import { ApiProperty } from '@nestjs/swagger';
import { CustomerType, LeadSource } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export const MANUAL_LEAD_SOURCES = [LeadSource.MANUAL, LeadSource.WALK_IN, LeadSource.REFERRAL, LeadSource.OTHER] as const;

export class CreateLeadManualDto {
  @ApiProperty({ example: 'Sharma Hardware' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+919812345678', description: 'Any format; normalized to E.164 (default +91)' })
  @IsNotEmpty()
  @IsString()
  phone!: string;

  @ApiProperty({ required: false, enum: MANUAL_LEAD_SOURCES, default: LeadSource.MANUAL })
  @IsOptional()
  @IsIn(MANUAL_LEAD_SOURCES)
  source?: (typeof MANUAL_LEAD_SOURCES)[number];

  @ApiProperty({ required: false, example: '+919812300000' })
  @IsOptional()
  @IsString()
  altPhone?: string;

  @ApiProperty({ required: false, example: 'sharma@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: 'Indore' }) @IsOptional() @IsString() city?: string;
  @ApiProperty({ required: false, example: '452001' }) @IsOptional() @IsString() pincode?: string;
  @ApiProperty({ required: false, example: 'Siyaganj, Indore' }) @IsOptional() @IsString() address?: string;

  @ApiProperty({ required: false, enum: CustomerType })
  @IsOptional()
  @IsEnum(CustomerType)
  customerType?: CustomerType;

  @ApiProperty({ required: false, example: '18mm BWP 8x4, 50 sheets' })
  @IsOptional()
  @IsString()
  requirementNotes?: string;

  @ApiProperty({ required: false, example: 85000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimatedValue?: number;

  @ApiProperty({
    required: false,
    description: 'Admin: any active user in the org. Manager: self or own team. Callers cannot set it (the lead is theirs).',
  })
  @IsOptional()
  @IsString()
  assignToId?: string;
}

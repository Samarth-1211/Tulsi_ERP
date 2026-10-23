import { ApiProperty } from '@nestjs/swagger';
import { LeadSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const MANUAL_LEAD_SOURCES = [LeadSource.MANUAL, LeadSource.WALK_IN, LeadSource.REFERRAL, LeadSource.OTHER] as const;

export class CreateLeadManualDto {
  @ApiProperty({ example: 'Sharma Hardware' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(200)
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


  @ApiProperty({ required: false, example: '18mm BWP 8x4, 50 sheets' })
  @IsOptional()
  @IsString()
  requirementNotes?: string;

  @ApiProperty({ required: false, example: 'Dealer / retailer', description: 'Who the plywood is for ("Buying For")' })
  @IsOptional()
  @IsString()
  buyingFor?: string;

  @ApiProperty({ required: false, example: '2026-09-16', description: 'The lead\'s date when it came in earlier than today (default: now)' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({ required: false, example: '120249746455520716', description: 'Meta ad id — Admin only, ignored for others' })
  @IsOptional()
  @IsString()
  adId?: string;

  @ApiProperty({ required: false, example: 'Call after 5 pm' })
  @IsOptional()
  @IsString()
  feedback?: string;


  @ApiProperty({
    required: false,
    description: 'Admin: any active user in the org. Manager: self or own team. Callers cannot set it (the lead is theirs).',
  })
  @IsOptional()
  @IsString()
  assignToId?: string;
}

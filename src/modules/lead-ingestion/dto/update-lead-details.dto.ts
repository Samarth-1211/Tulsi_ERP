import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** PATCH /leads/:id — the lead's own fields. Status and assignee have their own endpoints. */
export class UpdateLeadDetailsDto {
  @ApiProperty({ required: false })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @ApiProperty({ required: false, description: 'Normalized to E.164; must not belong to another open lead' })
  @IsOptional()
  @IsString()
  phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() altPhone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() city?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pincode?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() address?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() requirementNotes?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() buyingFor?: string;
  @ApiProperty({ required: false, description: 'Meta ad id — Admin only, ignored for others; empty clears it' }) @IsOptional() @IsString() adId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() feedback?: string;

}

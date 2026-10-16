import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { CustomerType } from '@prisma/client';

/** PATCH /leads/:id — the lead's own fields. Status and assignee have their own endpoints. */
export class UpdateLeadDetailsDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @ApiProperty({ required: false, description: 'Normalized to E.164; must not belong to another open lead' })
  @IsOptional()
  @IsString()
  phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() altPhone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() city?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pincode?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() address?: string;
  @ApiProperty({ required: false, enum: CustomerType }) @IsOptional() @IsEnum(CustomerType) customerType?: CustomerType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() requirementNotes?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimatedValue?: number;
}

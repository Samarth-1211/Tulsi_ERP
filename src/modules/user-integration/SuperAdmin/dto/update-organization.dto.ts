import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

export class UpdateOrganizationDto {
  @ApiProperty({ required: false, example: 'Tulsi Plywood Pvt Ltd' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, example: 'contact@tulsiplywood.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: '+91 98765 43210' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false, example: 'MG Road, Indore, MP' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false, example: '23AAAAA0000A1Z5' })
  @IsOptional()
  @IsString()
  gstin?: string;

  @ApiProperty({ required: false, example: 'Indore' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false, example: 'Madhya Pradesh' })
  @IsOptional()
  @IsString()
  state?: string;
}

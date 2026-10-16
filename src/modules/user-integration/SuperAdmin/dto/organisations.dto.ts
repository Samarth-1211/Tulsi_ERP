import { ApiProperty } from '@nestjs/swagger';
import {
  IsDefined,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateOrgAdminDto } from './create-org-admin.dto';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Tulsi Plywood' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'contact@tulsiplywood.com' })
  @IsEmail()
  email!: string;

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

  @ApiProperty({
    type: CreateOrgAdminDto,
    description:
      'Required — the first Admin for this organization. They are created alongside the org and emailed a welcome + verification link immediately, and the org stays unverified until they click it. Further Admins are added via POST /organizations/:id/admin.',
  })
  @IsDefined({ message: 'First admin details are required to create an organization' })
  @ValidateNested()
  @Type(() => CreateOrgAdminDto)
  admin!: CreateOrgAdminDto;
}

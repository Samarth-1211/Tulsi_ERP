import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateManagerDto {
  // Lower-cased like CreateManagerDto — login looks accounts up by email.toLowerCase().
  // Changing it emails a verification link to the new address and marks the account unverified until clicked.
  @ApiProperty({ required: false, example: 'manager@aakashrealty.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: 'Ravi' })
  @IsOptional()
  @IsString()
  name?: string;

  // null clears the stored number; omitting the field leaves it unchanged.
  @ApiProperty({ required: false, nullable: true, example: '+919876543210' })
  @IsOptional()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone?: string | null;
}

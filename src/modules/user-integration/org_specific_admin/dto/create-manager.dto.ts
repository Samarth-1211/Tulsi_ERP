import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';

export class CreateManagerDto {
  // Lower-cased on the way in: login looks the account up by
  // email.toLowerCase(), so an address stored with any capitals could never
  // be signed into.
  @ApiProperty({ example: 'manager@aakashrealty.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass@123' })
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: 'Ravi' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone!: string;
}

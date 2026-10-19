import { StrongPassword } from '../../../../common/validators/strong-password.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CreateOrgAdminDto {
  // Lower-cased on the way in: login looks the account up by
  // email.toLowerCase(), so an address stored with any capitals could never
  // be signed into.
  @ApiProperty({ example: 'admin@clientcompany.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  adminEmail!: string;

  @ApiProperty({ example: 'StrongPass@123' })
  @StrongPassword()
  adminPassword!: string;

  @ApiProperty({ example: 'Ramesh Kumar' })
  @IsNotEmpty()
  @IsString()
  adminName!: string;
}

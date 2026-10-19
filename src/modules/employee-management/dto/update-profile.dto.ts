import { StrongPassword } from '../../../common/validators/strong-password.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({ required: false, example: 'Ramesh Kumar' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, example: '+919876543210' })
  @IsOptional()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiProperty({ required: false, example: 'https://cdn.example.com/avatars/u123.jpg' })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class UpdateEmployeeCodeDto {
  @ApiProperty({ example: 'EMP-0042' })
  @IsString()
  employeeCode!: string;
}

export class ChangeEmailDto {
  // Lower-cased because login looks accounts up by email.toLowerCase().
  @ApiProperty({ example: 'new-email@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  newEmail!: string;

  @ApiProperty({ description: 'Current password, required to confirm this change' })
  @IsNotEmpty()
  @IsString()
  currentPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: "The account's current password" })
  @IsNotEmpty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ example: 'NewStrongPass123' })
  @StrongPassword()
  newPassword!: string;
}

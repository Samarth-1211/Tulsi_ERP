import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ example: 'admin@demorealty.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: '6-digit OTP sent to the registered email' })
  @IsNotEmpty()
  otp!: string;

  @ApiProperty({ example: 'NewStrongPass123' })
  @MinLength(8)
  newPassword!: string;
}

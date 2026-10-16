import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'The raw verification token from the emailed link' })
  @IsNotEmpty()
  @IsString()
  token!: string;
}

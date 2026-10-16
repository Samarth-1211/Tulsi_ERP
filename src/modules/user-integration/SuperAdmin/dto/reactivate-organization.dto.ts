import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReactivateOrganizationDto {
  @ApiProperty({ required: false, example: 'Payment received, reactivating account' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

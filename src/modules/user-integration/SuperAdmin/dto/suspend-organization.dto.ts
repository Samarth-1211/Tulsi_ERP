import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SuspendOrganizationDto {
  @ApiProperty({ example: 'Non-payment of subscription for 30+ days' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  reason!: string;
}

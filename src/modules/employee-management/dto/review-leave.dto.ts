import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ReviewLeaveDto {
  @ApiProperty({ required: false, example: 'Approved, please handover pending leads before you go' })
  @IsOptional()
  @IsString()
  comment?: string;
}

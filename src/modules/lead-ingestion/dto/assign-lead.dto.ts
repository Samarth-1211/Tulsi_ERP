import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class AssignLeadDto {
  @ApiProperty({ description: 'User the lead goes to. Admin: anyone active in the org. Manager: self or own team.' })
  @IsNotEmpty()
  @IsString()
  toUserId!: string;

  @ApiProperty({ required: false, example: 'Customer asked for a Hindi-speaking caller' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

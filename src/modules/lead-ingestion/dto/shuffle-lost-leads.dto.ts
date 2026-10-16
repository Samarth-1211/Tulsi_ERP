import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class ShuffleLostLeadsDto {
  @ApiProperty({
    required: false,
    type: [String],
    description: 'Specific lost lead ids to shuffle. Omit to shuffle every currently-lost lead in scope.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  leadIds?: string[];
}

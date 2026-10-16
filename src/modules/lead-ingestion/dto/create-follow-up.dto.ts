import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateFollowUpDto {
  @ApiProperty({ example: 'Called, shared BWP rate list. Wants 40 sheets next week.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;

  @ApiProperty({ required: false, example: 'INTERESTED' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  outcome?: string;

  @ApiProperty({ required: false, example: '2026-10-20T11:00:00+05:30', description: 'Sets lead.nextFollowUpAt' })
  @IsOptional()
  @IsDateString()
  nextFollowUpAt?: string;
}

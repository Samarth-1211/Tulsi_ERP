import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** A note on a lead — from a Manager/Admin it also notifies the lead's assignee. */
export class AddLeadNoteDto {
  @ApiProperty({ example: 'Customer prefers a call after 4 pm — offer the Century rate.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;
}

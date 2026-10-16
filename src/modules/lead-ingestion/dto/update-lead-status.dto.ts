import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { LeadStatus } from '@prisma/client';

export class UpdateLeadStatusDto {
  @ApiProperty({ enum: LeadStatus, example: LeadStatus.IN_PROGRESS })
  @IsEnum(LeadStatus)
  status!: LeadStatus;

  @ApiProperty({ required: false, description: 'Required when status is CONVERTED (how the deal closed)' })
  @ValidateIf((dto: UpdateLeadStatusDto) => dto.status === LeadStatus.CONVERTED || dto.note !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'A note is required to mark a lead CONVERTED' })
  @MaxLength(2000)
  note?: string;

  @ApiProperty({ required: false, description: 'Required when status is LOST' })
  @ValidateIf((dto: UpdateLeadStatusDto) => dto.status === LeadStatus.LOST)
  @IsString()
  @IsNotEmpty({ message: 'lostReason is required to mark a lead LOST' })
  @MaxLength(500)
  lostReason?: string;
}

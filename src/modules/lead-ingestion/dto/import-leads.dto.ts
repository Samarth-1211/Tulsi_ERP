import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { LeadImportAllocationMode } from '@prisma/client';

// Multipart sends one id as a plain string and repeats as an array; a JSON array string is accepted too.
function toIdList({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return trimmed ? [trimmed] : [];
}

/** Multipart form fields sent alongside the uploaded sheet. */
export class ImportLeadsDto {
  @ApiProperty({
    required: false,
    enum: LeadImportAllocationMode,
    description:
      'Who gets the sheet’s leads. ALL_TEAMS: every Manager’s presales team. MANAGERS_AND_TEAMS: the Managers in ' +
      '`managerIds`, each sharing their part with their presales team. MANAGERS_ONLY: those Managers themselves. ' +
      'CUSTOM: the people and numbers in `customAllocations`. ' +
      'Left out, an Admin’s upload is ALL_TEAMS and a Manager’s MANAGERS_AND_TEAMS for themselves.',
  })
  @IsOptional()
  @IsEnum(LeadImportAllocationMode)
  allocationMode?: LeadImportAllocationMode;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'The Managers to share the sheet with — required for MANAGERS_AND_TEAMS and MANAGERS_ONLY, not allowed with ' +
      'ALL_TEAMS. A Manager lists themselves to take a share. Send the field once per id (or as a JSON array).',
  })
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  managerIds?: string[];

  @ApiProperty({
    required: false,
    example: '[{"userId":"…","count":200},{"userId":"…","count":300}]',
    description:
      'Required for CUSTOM, not allowed otherwise: a JSON array saying how many of the sheet’s leads each person ' +
      'gets. An Admin may name any Manager or team member; a Manager themselves, their own team or another Manager. ' +
      'The numbers can’t add up to more than the sheet has rows.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  customAllocations?: string;

  @ApiProperty({
    required: false,
    type: [String],
    deprecated: true,
    description:
      'Older clients, Managers only: other Managers who share the sheet on top of the uploader. Use `allocationMode` ' +
      'with `managerIds` instead — the two can’t be combined.',
  })
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  collaboratorIds?: string[];
}

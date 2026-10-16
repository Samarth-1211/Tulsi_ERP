import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class DeleteUserDto {
  @ApiProperty({ required: false, example: 'Account no longer with the organization' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @ApiProperty({
    example: 'delete',
    description: 'Must be the literal word "delete" (case-insensitive) — confirms this is an intentional deletion.',
  })
  @IsString()
  @Matches(/^delete$/i, { message: 'Type "delete" to confirm this deletion.' })
  confirmation!: string;

  @ApiProperty({
    required: false,
    description: "Who takes over the user's open leads and pending tasks. Required when they have any.",
  })
  @IsOptional()
  @IsUUID()
  reassignWorkToId?: string;

  @ApiProperty({
    required: false,
    description: "Manager who takes over the user's direct reports. Required when they have any.",
  })
  @IsOptional()
  @IsUUID()
  reassignTeamToId?: string;
}

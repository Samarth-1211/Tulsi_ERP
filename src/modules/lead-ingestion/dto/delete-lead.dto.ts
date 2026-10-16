import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class DeleteLeadDto {
  @ApiProperty({
    example: 'delete',
    description: 'Must be the literal word "delete" (case-insensitive) — confirms this is an intentional, permanent deletion.',
  })
  @IsString()
  @Matches(/^delete$/i, { message: 'Type "delete" to confirm this deletion.' })
  confirmation!: string;
}

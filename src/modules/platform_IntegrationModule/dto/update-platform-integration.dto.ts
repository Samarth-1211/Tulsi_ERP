import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { IntegrationStatus } from '@prisma/client';
import { IsIn, IsOptional } from 'class-validator';
import { CreatePlatformIntegrationDto } from './create-platform-integration.dto';

// `type` is the identity the webhook token was generated for — not editable.
export class UpdatePlatformIntegrationDto extends PartialType(OmitType(CreatePlatformIntegrationDto, ['type'] as const)) {
  @ApiProperty({ required: false, enum: [IntegrationStatus.ACTIVE, IntegrationStatus.INACTIVE] })
  @IsOptional()
  @IsIn([IntegrationStatus.ACTIVE, IntegrationStatus.INACTIVE])
  status?: IntegrationStatus;
}

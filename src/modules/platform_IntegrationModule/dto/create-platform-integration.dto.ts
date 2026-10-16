import { ApiProperty } from '@nestjs/swagger';
import { IntegrationType } from '@prisma/client';
import { IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/** Lead-source integrations managed here; WhatsApp has its own module (/whatsapp/integration). */
export const LEAD_INTEGRATION_TYPES = [IntegrationType.META_LEAD_FORM, IntegrationType.WEBHOOK_GENERIC] as const;

export class CreatePlatformIntegrationDto {
  @ApiProperty({ enum: LEAD_INTEGRATION_TYPES })
  @IsIn(LEAD_INTEGRATION_TYPES)
  type!: (typeof LEAD_INTEGRATION_TYPES)[number];

  @ApiProperty({ example: 'Meta Lead Forms — Tulsi Plywood page' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ required: false, description: 'Meta page_id — routes native leadgen webhooks to this integration' })
  @IsOptional()
  @IsString()
  externalAccountId?: string;

  @ApiProperty({ required: false, description: 'Page access token for the Graph API (stored encrypted, never returned)' })
  @IsOptional()
  @IsString()
  pageAccessToken?: string;

  @ApiProperty({ required: false, type: [String], description: 'Meta form ids this integration covers (informational)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  formIds?: string[];

  @ApiProperty({
    required: false,
    example: { full_name: 'name', phone_number: 'phone', which_product_do_you_need: 'requirementNotes' },
    description:
      'Meta form question key → lead field (name, phone, email, city, pincode, customerType, requirementNotes). ' +
      'Unmapped answers go to customFields.',
  })
  @IsOptional()
  @IsObject()
  fieldMapping?: Record<string, string>;
}

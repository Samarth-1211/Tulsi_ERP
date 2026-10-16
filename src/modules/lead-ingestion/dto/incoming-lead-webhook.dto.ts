import { ApiProperty } from '@nestjs/swagger';
import { CustomerType } from '@prisma/client';
import { IsEmail, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * The payload accepted at POST /webhooks/leads/:webhookToken — sent by
 * n8n / Pabbly / Zapier / Make relaying Meta Lead Form leads, and by website
 * forms. Only name and phone are required. Validated by LeadsWebhookService
 * (not the global ValidationPipe), so unknown fields are ignored rather than
 * rejected — a rejected webhook is a lost lead.
 */
export class IncomingLeadWebhookDto {
  @ApiProperty({ example: 'Sharma Hardware' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '+919812345678', description: 'Any format; normalized to E.164 (default +91)' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiProperty({ required: false }) @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() city?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pincode?: string;

  @ApiProperty({ required: false, enum: CustomerType })
  @IsOptional()
  @IsEnum(CustomerType)
  customerType?: CustomerType;

  @ApiProperty({ required: false, example: '18mm BWP 8x4, 50 sheets' })
  @IsOptional()
  @IsString()
  requirement?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() campaign_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() campaign_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() adset_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() adset_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() ad_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() ad_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() form_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() form_name?: string;

  @ApiProperty({ required: false, description: 'Meta leadgen_id — retries with the same id are stored as DUPLICATE' })
  @IsOptional()
  @IsString()
  leadgen_id?: string;

  @ApiProperty({ required: false, description: 'Any other answers; stored on the lead as customFields' })
  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown>;
}

/** Returned with every generic/Meta-form integration so the sender knows the exact format. */
export const SAMPLE_LEAD_WEBHOOK_PAYLOAD = {
  name: 'Sharma Hardware',
  phone: '+919812345678',
  email: 'sharma@example.com',
  city: 'Indore',
  pincode: '452001',
  customerType: 'DEALER',
  requirement: '18mm BWP 8x4, 50 sheets',
  campaign_id: '120200000000001',
  campaign_name: 'Plywood Leads Oct',
  adset_id: '120200000000002',
  adset_name: 'Indore Dealers',
  ad_id: '120200000000003',
  ad_name: 'BWP Offer',
  form_id: '120200000000004',
  form_name: 'Bulk Enquiry Form',
  leadgen_id: '120200000000005',
  extra: { preferred_brand: 'Century', delivery_needed: 'yes' },
} as const;

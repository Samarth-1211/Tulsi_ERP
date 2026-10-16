import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateWhatsAppIntegrationDto {
  // Correcting the Meta IDs (e.g. a phone number was only added to the WABA
  // after connecting). Validated live against Meta together with the token.
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]+$/, { message: 'wabaId must be the numeric WhatsApp Business Account ID' })
  wabaId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]+$/, { message: 'phoneNumberId must be the numeric Phone Number ID' })
  phoneNumberId?: string;

  // Rotate the access token (e.g. it was regenerated in Meta Business
  // Manager). Re-validated live against Meta before being saved, same as on
  // initial connect — never trusted blindly.
  @IsOptional()
  @IsString()
  accessToken?: string;

  // The Meta app's App Secret (App Dashboard → App settings → Basic) — used
  // to verify the X-Hub-Signature-256 header on webhook POSTs. Optional:
  // falls back to the META_APP_SECRET env var when not given.
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{32}$/i, { message: 'appSecret must be the 32-character App Secret from your Meta app settings' })
  appSecret?: string;

  @IsOptional()
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'displayPhoneNumber must be a valid phone number (digits, optional leading +)',
  })
  displayPhoneNumber?: string;

  @IsOptional()
  @IsString()
  businessManagerId?: string;

  @IsOptional()
  @IsString()
  businessName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

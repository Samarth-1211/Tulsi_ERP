import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class ConnectWhatsAppIntegrationDto {
  @IsNotEmpty({ message: 'wabaId is required' })
  @IsString()
  wabaId!: string;

  @IsNotEmpty({ message: 'phoneNumberId is required' })
  @IsString()
  phoneNumberId!: string;

  @IsNotEmpty({ message: 'accessToken is required' })
  @IsString()
  accessToken!: string;

  // The Meta app's App Secret (App Dashboard → App settings → Basic) — used
  // to verify the X-Hub-Signature-256 header on webhook POSTs. Optional:
  // falls back to the META_APP_SECRET env var when not given.
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{32}$/i, { message: 'appSecret must be the 32-character App Secret from your Meta app settings' })
  appSecret?: string;

  // Display-only — the CRM shows this so admins recognize which number is
  // connected. Not sent to Meta; if omitted, we fall back to whatever Meta
  // itself reports for this phone number during validation.
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
}

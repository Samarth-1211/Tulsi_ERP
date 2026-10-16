import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendWhatsAppMessageDto {
  @IsNotEmpty({ message: 'text is required' })
  @IsString()
  @MaxLength(4096)
  text!: string;
}

// Sent as multipart form fields alongside the file.
export class SendWhatsAppMediaDto {
  // WhatsApp's caption limit.
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;
}

export class SendWhatsAppTemplateDto {
  @IsNotEmpty({ message: 'templateName is required' })
  @IsString()
  @MaxLength(512)
  templateName!: string;

  // Meta's template language code, e.g. "en_US" or "hi".
  @IsNotEmpty({ message: 'languageCode is required' })
  @IsString()
  @MaxLength(15)
  languageCode!: string;
}

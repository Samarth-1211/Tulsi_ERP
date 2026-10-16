import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from 'class-validator';

export class CheckOutDto {
  @ApiProperty({
    example: 'Called 12 assigned leads, shared the rate list on WhatsApp, 3 follow-ups scheduled.',
    description: 'Required end-of-day work summary; must be at least OrgSettings.checkoutSummaryMinLength characters',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(5000)
  summary!: string;

  @ApiProperty({ required: false, example: 22.7196 })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiProperty({ required: false, example: 75.8577 })
  @IsOptional()
  @IsLongitude()
  lng?: number;
}

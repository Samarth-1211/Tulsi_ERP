import { IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export const DEBUG_EVENT_FILTERS = ['all', 'messages', 'statuses', 'errors', 'invalid-signature'] as const;
export type DebugEventFilter = (typeof DEBUG_EVENT_FILTERS)[number];

export class DebugEventsQueryDto {
  @IsOptional()
  @IsIn(DEBUG_EVENT_FILTERS)
  filter?: DebugEventFilter;
}

export class SendTestMessageDto {
  @Matches(/^\+?[1-9][0-9]{7,14}$/, { message: 'to must be a phone number in E.164 format, e.g. +919812345678' })
  to!: string;

  @IsIn(['hello_world', 'text'])
  type!: 'hello_world' | 'text';

  @ValidateIf((o: SendTestMessageDto) => o.type === 'text')
  @IsString()
  @MaxLength(4096)
  text?: string;
}

export class SimulateInboundDto {
  @IsOptional()
  @Matches(/^\+?[1-9][0-9]{7,14}$/, { message: 'from must be a phone number in E.164 format' })
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  // Set to simulate the first message after a Click-to-WhatsApp ad is
  // tapped: Meta's ad id, plus the ad's copy.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  adId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  adHeadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adBody?: string;
}

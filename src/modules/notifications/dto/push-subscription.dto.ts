import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';

export class PushSubscriptionKeysDto {
  @ApiProperty({ description: "The browser's P-256 ECDH public key (base64url)" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  p256dh!: string;

  @ApiProperty({ description: 'The subscription auth secret (base64url)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  auth!: string;
}

/** The parts of a browser `PushSubscription.toJSON()` the server needs. */
export class PushSubscriptionDto {
  @ApiProperty({ example: 'https://fcm.googleapis.com/fcm/send/…' })
  @IsUrl({ protocols: ['https'], require_tld: false })
  @MaxLength(1000)
  endpoint!: string;

  @ApiProperty({ type: PushSubscriptionKeysDto })
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;
}

export class PushUnsubscribeDto {
  @ApiProperty({ example: 'https://fcm.googleapis.com/fcm/send/…' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  endpoint!: string;
}

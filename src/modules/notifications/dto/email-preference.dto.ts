import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum } from 'class-validator';

export class UpdateEmailPreferenceDto {
  @ApiProperty({ description: 'Email me CRM updates (lead allotted, task assigned, reminders…)' })
  @IsBoolean()
  enabled!: boolean;
}

export class UpdateEmailNotificationSettingsDto {
  @ApiProperty({ enum: NotificationType, isArray: true, description: 'Notification types that are also emailed to the user' })
  @IsArray()
  @IsEnum(NotificationType, { each: true })
  emailNotificationTypes!: NotificationType[];
}

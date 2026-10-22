import { Module } from '@nestjs/common';
import { NotificationsController, NotificationSettingsController } from './controllers/notifications.controller';
import { NotificationsService } from './services/notifications.service';
import { PushService } from './services/push.service';
import { EmailNotificationService } from './services/email-notification.service';

@Module({
  controllers: [NotificationsController, NotificationSettingsController],
  providers: [NotificationsService, PushService, EmailNotificationService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

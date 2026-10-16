import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { NotificationsService } from '../services/notifications.service';
import { PushService } from '../services/push.service';
import { PushSubscriptionDto, PushUnsubscribeDto } from '../dto/push-subscription.dto';

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  @Get()
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiOperation({ summary: "List the caller's notifications (newest first, max 50)" })
  findMine(@CurrentUser() actor: AuthenticatedUser, @Query('unreadOnly') unreadOnly?: string) {
    return this.notificationsService.findMine(actor, unreadOnly === 'true');
  }

  @Get('unread-count')
  @ApiOperation({ summary: "Get the caller's unread notification count (for the bell badge)" })
  unreadCount(@CurrentUser() actor: AuthenticatedUser) {
    return this.notificationsService.unreadCount(actor);
  }

  @Get('push/public-key')
  @ApiOperation({ summary: 'VAPID public key for subscribing this browser to push notifications (null when push is off)' })
  pushPublicKey() {
    return this.pushService.getPublicKey();
  }

  @Post('push/subscribe')
  @ApiOperation({ summary: "Turn on device (phone/desktop) notifications for this browser — send its PushSubscription" })
  pushSubscribe(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: PushSubscriptionDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.pushService.subscribe(actor, dto, userAgent);
  }

  @Post('push/unsubscribe')
  @ApiOperation({ summary: 'Turn off device notifications for this browser (e.g. on logout)' })
  pushUnsubscribe(@CurrentUser() actor: AuthenticatedUser, @Body() dto: PushUnsubscribeDto) {
    return this.pushService.unsubscribe(actor, dto.endpoint);
  }

  @Post('push/test')
  @ApiOperation({ summary: "Send a test notification to every device the caller turned push on for" })
  pushTest(@CurrentUser() actor: AuthenticatedUser) {
    return this.pushService.sendTest(actor);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  markRead(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.notificationsService.markRead(actor, id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: "Mark all of the caller's notifications as read" })
  markAllRead(@CurrentUser() actor: AuthenticatedUser) {
    return this.notificationsService.markAllRead(actor);
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { WhatsAppDebugService } from '../services/whatsapp-debug.service';
import { DebugEventsQueryDto, SendTestMessageDto, SimulateInboundDto } from '../dto/whatsapp-debug.dto';

// WhatsApp Debug Console — Admin/Super Admin only, always scoped to the
// caller's own organization. Never returns the access token, App Secret or
// verify token.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('whatsapp/debug')
export class WhatsAppDebugController {
  constructor(private readonly debugService: WhatsAppDebugService) {}

  @Get('health')
  health(@CurrentUser() user: AuthenticatedUser) {
    return this.debugService.health(user);
  }

  // POST /{WABA_ID}/subscribed_apps — subscribes the token's app to the
  // WABA's webhooks.
  @Post('subscribe-app')
  subscribeApp(@CurrentUser() user: AuthenticatedUser) {
    return this.debugService.subscribeApp(user);
  }

  @Get('events')
  listEvents(@Query() query: DebugEventsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.debugService.listEvents(user, query.filter);
  }

  @Get('events/:id')
  getEvent(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.debugService.getEvent(user, id);
  }

  @Post('send-test')
  sendTest(@Body() dto: SendTestMessageDto, @CurrentUser() user: AuthenticatedUser) {
    return this.debugService.sendTest(user, dto);
  }

  // Disabled when NODE_ENV=production unless WHATSAPP_DEBUG_SIMULATE_ENABLED=true.
  @Post('simulate-inbound')
  simulateInbound(@Body() dto: SimulateInboundDto, @CurrentUser() user: AuthenticatedUser) {
    return this.debugService.simulateInbound(user, dto);
  }

  @Get('trace')
  trace(@CurrentUser() user: AuthenticatedUser) {
    return this.debugService.trace(user);
  }
}

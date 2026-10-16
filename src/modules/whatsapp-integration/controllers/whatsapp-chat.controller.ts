import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { contentDisposition } from '../../../common/utils/upload.util';
import { WhatsAppMessagingService } from '../services/whatsapp-messaging.service';
import { MAX_OUTBOUND_DOCUMENT_BYTES } from '../services/whatsapp-media-storage.service';
import {
  SendWhatsAppMediaDto,
  SendWhatsAppMessageDto,
  SendWhatsAppTemplateDto,
} from '../dto/send-whatsapp-message.dto';

// Feeds the WhatsApp Inbox page: every WhatsApp-sourced lead the caller can
// see (scoped the same way as /leads), each with a last-message preview.
@UseGuards(JwtAuthGuard)
@Controller('whatsapp')
export class WhatsAppInboxController {
  constructor(private readonly messagingService: WhatsAppMessagingService) {}

  @Get('inbox')
  listInbox(@CurrentUser() user: AuthenticatedUser) {
    return this.messagingService.listInbox(user);
  }

  // Approved templates on the org's WABA — what the chat offers once the
  // 24-hour window has closed.
  @Get('templates')
  listTemplates(@CurrentUser() user: AuthenticatedUser) {
    return this.messagingService.listTemplates(user);
  }
}

// Lead-scoped WhatsApp thread — lives here rather than on LeadsController so
// all WhatsApp-specific logic (Meta API calls, 24h window, access checks)
// stays contained in this module.
@UseGuards(JwtAuthGuard)
@Controller('leads/:leadId/whatsapp')
export class WhatsAppChatController {
  constructor(private readonly messagingService: WhatsAppMessagingService) {}

  @Get('messages')
  listMessages(@Param('leadId') leadId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.messagingService.listMessages(user, leadId);
  }

  @Post('messages')
  sendMessage(
    @Param('leadId') leadId: string,
    @Body() dto: SendWhatsAppMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.messagingService.sendMessage(user, leadId, dto.text);
  }

  // An image (JPG/PNG) or a PDF, with an optional caption.
  @Post('media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OUTBOUND_DOCUMENT_BYTES, files: 1 } }))
  sendMedia(
    @Param('leadId') leadId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: SendWhatsAppMediaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.messagingService.sendMedia(user, leadId, file, dto.caption);
  }

  @Post('template')
  sendTemplate(
    @Param('leadId') leadId: string,
    @Body() dto: SendWhatsAppTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.messagingService.sendTemplate(user, leadId, dto.templateName, dto.languageCode);
  }

  // Clears this thread's unread count for the calling user.
  @Post('read')
  markRead(@Param('leadId') leadId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.messagingService.markRead(user, leadId);
  }

  @Get('messages/:messageId/media')
  async media(
    @Param('leadId') leadId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.messagingService.openMedia(user, leadId, messageId);
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.size,
      disposition: contentDisposition('inline', file.fileName),
    });
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LeadsWebhookService } from '../services/leads-webhook.service';
import { IncomingLeadWebhookDto } from '../dto/incoming-lead-webhook.dto';

// Deliberately NO JwtAuthGuard on these routes — they are hit by external
// systems. The unguessable :webhookToken (relay) or Meta's signature
// (native) IS the authentication.
@ApiTags('webhooks')
@Controller('webhooks')
export class LeadsWebhookController {
  constructor(private readonly leadsWebhookService: LeadsWebhookService) {}

  @Post('leads/:webhookToken')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Common lead URL for n8n / Pabbly / Zapier / Make relays and website forms' })
  @ApiBody({ type: IncomingLeadWebhookDto })
  async receiveRelay(
    @Param('webhookToken') webhookToken: string,
    // A plain object on purpose: the global ValidationPipe (whitelist +
    // forbidNonWhitelisted) would reject unknown fields — validated in the service.
    @Body() body: Record<string, unknown>,
  ) {
    const integration = await this.leadsWebhookService.findIntegrationByToken(webhookToken);
    if (!integration) {
      // Deliberately vague — don't reveal whether a token exists.
      throw new NotFoundException('Webhook not found');
    }

    const receipt = await this.leadsWebhookService.receiveRelay(integration, body);
    if (receipt.status === 'invalid') {
      throw new BadRequestException({ message: receipt.errors, eventId: receipt.eventId });
    }
    return receipt;
  }

  @Get('meta/leadgen')
  @ApiOperation({ summary: 'Meta Lead Ads webhook verification (hub.challenge)' })
  async verifyMeta(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode !== 'subscribe' || !(await this.leadsWebhookService.isValidMetaVerifyToken(token))) {
      res.status(HttpStatus.FORBIDDEN).type('text/plain').send('Verification failed');
      return;
    }
    res.status(HttpStatus.OK).type('text/plain').send(challenge ?? '');
  }

  @Post('meta/leadgen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Meta Lead Ads webhook — signed with META_APP_SECRET, routed by page_id' })
  async receiveMeta(
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.leadsWebhookService.isValidMetaSignature(req.rawBody, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }
    return { status: 'received', ...(await this.leadsWebhookService.receiveMetaLeadgen(body)) };
  }
}

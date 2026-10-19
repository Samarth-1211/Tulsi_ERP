import { Body, Controller, Get, Headers, HttpStatus, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { WhatsAppWebhookService } from '../services/whatsapp-webhook.service';
import { MetaWebhookPayload } from '../utils/whatsapp-payload.util';

// Deliberately NO JwtAuthGuard — this is hit directly by Meta's servers,
// which can't do a login flow. The unguessable :slug in the URL plus the
// verifyToken handshake (GET) and the X-Hub-Signature-256 HMAC (POST) are
// the authentication. Not rate limited: Meta delivers in bursts and retries
// anything that fails, so throttling would only duplicate work.
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(private readonly webhookService: WhatsAppWebhookService) {}

  // Meta's one-time subscription handshake: it GETs this URL with
  // hub.mode=subscribe&hub.verify_token=...&hub.challenge=... and expects
  // the raw challenge string echoed back (plain text) if the token matches.
  // This is also the moment we flip the integration from Pending -> Connected.
  @Get(':slug')
  async verify(
    @Param('slug') slug: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const integration = await this.webhookService.findBySlug(slug);

    if (
      !integration ||
      !integration.isActive ||
      mode !== 'subscribe' ||
      !this.webhookService.isVerifyTokenValid(integration, verifyToken)
    ) {
      this.logger.warn(`WEBHOOK VERIFY FAILED slug=${slug.slice(0, 6)}… mode=${mode ?? '-'}`);
      res.status(HttpStatus.FORBIDDEN).type('text/plain').send('Verification failed');
      return;
    }

    await this.webhookService.markVerified(integration.id);
    this.logger.log(`WEBHOOK VERIFIED slug=${slug.slice(0, 6)}… org=${integration.orgId}`);

    res.status(HttpStatus.OK).type('text/plain').send(challenge ?? '');
  }

  @Post(':slug')
  async receive(
    @Param('slug') slug: string,
    @Body() payload: MetaWebhookPayload,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    this.logger.log(
      `WEBHOOK HIT ${new Date().toISOString()} slug=${slug.slice(0, 6)}… object=${payload?.object ?? '-'} entries=${payload?.entry?.length ?? 0} signed=${!!signature}`,
    );

    const integration = await this.webhookService.findBySlug(slug);

    // An unknown slug still gets a 200 — Meta retries aggressively (and
    // eventually disables the webhook) on non-2xx, and there's nothing to
    // store it against anyway.
    if (!integration) {
      res.status(HttpStatus.OK).json({ status: 'ignored' });
      return;
    }

    // Storing the event is the only work done before answering. If the
    // database is down this throws and Meta gets a 5xx, which is what we
    // want: Meta keeps redelivering for up to 7 days.
    const { accepted, signatureValid } = await this.webhookService.receive(
      integration,
      req.rawBody,
      payload,
      signature,
    );

    if (!accepted) {
      this.logger.warn(`WEBHOOK REJECTED slug=${slug.slice(0, 6)}… invalid signature`);
      res.status(HttpStatus.UNAUTHORIZED).json({ status: 'invalid_signature' });
      return;
    }

    res.status(HttpStatus.OK).json({ status: 'received', signatureChecked: signatureValid !== null });
  }
}

import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Raised when an email could not be handed over to the SMTP server.
 *
 * Mail failures used to be swallowed by MailService, so callers reported
 * success while nothing was delivered. This carries the underlying SMTP
 * reason so each flow can surface it — either straight to the client (when
 * sending the mail *was* the request) or as a warning alongside a resource
 * that has already been created.
 */
export class MailDeliveryException extends ServiceUnavailableException {
  readonly reason: string;

  constructor(reason: string) {
    super(`Email could not be sent — ${reason}`);
    this.reason = reason;
  }
}

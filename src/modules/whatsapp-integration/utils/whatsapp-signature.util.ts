import { createHmac, timingSafeEqual } from 'crypto';

/** The `X-Hub-Signature-256` value Meta would send for this body: "sha256=<hex HMAC of the raw body>". */
export function signWebhookBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Checks Meta's `X-Hub-Signature-256` header against the RAW request body —
 * re-serialising the parsed JSON would change whitespace/escaping and never
 * match. Constant-time comparison; a missing or malformed header is invalid.
 */
export function isValidWebhookSignature(
  rawBody: Buffer | string | undefined,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = Buffer.from(signWebhookBody(rawBody, appSecret));
  const actual = Buffer.from(signatureHeader.trim());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

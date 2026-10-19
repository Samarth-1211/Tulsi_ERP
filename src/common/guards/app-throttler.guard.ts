import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit buckets:
 * - signed-in requests count per user (the token's subject), so a whole
 *   office behind one IP does not share a single limit;
 * - auth requests that name an email count per IP + email, so guessing one
 *   account's password is slowed without locking out colleagues;
 * - everything else counts per client IP.
 * The token is only decoded to pick the bucket — JwtAuthGuard still verifies it.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip: string = req.ip ?? req.socket?.remoteAddress ?? 'unknown';

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email && String(req.url ?? '').startsWith('/auth/')) return `auth:${ip}:${email}`;

    const auth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
    const sub = auth.startsWith('Bearer ') ? tokenSubject(auth.slice(7)) : null;
    return sub ? `user:${sub}` : `ip:${ip}`;
  }
}

function tokenSubject(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

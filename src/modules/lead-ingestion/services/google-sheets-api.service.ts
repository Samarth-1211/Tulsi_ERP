import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';
import { googleServiceAccount, valuesToCsv } from '../utils/google-sheet.util';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
// A fresh token is fetched this long before the cached one expires.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** The service account may not open this sheet (not shared with it, or no such sheet) — the public link may still work. */
export class SheetAccessDeniedError extends Error {}

/**
 * Reads a sheet through the Google Sheets API as the CRM's service account
 * (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY), so a
 * sheet can stay private: the Admin shares it with that email as a Viewer.
 * No Google SDK — the OAuth JWT-bearer sign-in is one signed request.
 */
@Injectable()
export class GoogleSheetsApiService {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get account() {
    return googleServiceAccount((key) => this.config.get<string>(key));
  }

  /** The email to share sheets with; null when no service account is configured. */
  get serviceAccountEmail(): string | null {
    return this.account?.email ?? null;
  }

  /** The tab (by gid) as CSV, in the same shape as Google's public CSV export. */
  async fetchCsv(spreadsheetId: string, gid: string, timeoutMs: number): Promise<Buffer> {
    const token = await this.accessToken(timeoutMs);
    const id = encodeURIComponent(spreadsheetId);

    const meta = await this.get<{ sheets?: { properties?: { sheetId?: number; title?: string } }[] }>(
      `${SHEETS_API}/${id}?fields=sheets.properties(sheetId,title)`,
      token,
      timeoutMs,
    );
    const title = meta.sheets?.find((s) => String(s.properties?.sheetId) === gid)?.properties?.title;
    if (!title) throw new Error('The tab in the link no longer exists — open the right tab and copy its link again.');

    // A1 notation: the whole tab, its name quoted ('' escapes a quote).
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
    const { values } = await this.get<{ values?: unknown[][] }>(
      `${SHEETS_API}/${id}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
      token,
      timeoutMs,
    );
    return Buffer.from(valuesToCsv(values ?? []), 'utf8');
  }

  private async get<T>(url: string, token: string, timeoutMs: number): Promise<T> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { message?: string; status?: string; details?: { reason?: string }[] };
    };
    if (res.ok) return json;

    const error = json.error;
    const disabled =
      error?.details?.some((d) => d.reason === 'SERVICE_DISABLED') || /has not been used|is disabled/i.test(error?.message ?? '');
    if (disabled) {
      throw new Error('The Google Sheets API is not enabled in the CRM’s Google Cloud project — enable it there (APIs & Services → Library → Google Sheets API).');
    }
    if (res.status === 403 || res.status === 404) throw new SheetAccessDeniedError(error?.message ?? res.statusText);
    throw new Error(`Google Sheets API answered ${res.status}: ${error?.message ?? res.statusText}`);
  }

  /** OAuth 2.0 JWT bearer grant: a JWT signed with the service account's key, swapped for an access token. */
  private async accessToken(timeoutMs: number): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.token.value;
    const account = this.account;
    if (!account) throw new Error('No Google service account is configured.');

    const now = Math.floor(Date.now() / 1000);
    const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.privateKey, 'base64url')}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(
        `The CRM’s Google service account couldn’t sign in (${json.error_description ?? json.error ?? res.status}) — check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in the server’s .env.`,
      );
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
}

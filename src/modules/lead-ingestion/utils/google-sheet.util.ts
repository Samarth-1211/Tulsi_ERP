/**
 * A GOOGLE_SHEET integration: a Google Sheet read by GoogleSheetSyncService —
 * through the Sheets API when the CRM has a service account the sheet is
 * shared with, else through its public CSV export ("Anyone with the link").
 */

/** Integration.config of a GOOGLE_SHEET source — what the Admin pasted plus the last sync's outcome. */
export interface GoogleSheetConfig {
  sheetUrl: string;
  spreadsheetId: string;
  /** The tab (worksheet) id from the link's #gid=…; "0" is the first tab. */
  gid: string;
  lastSyncedAt?: string;
  lastSyncError?: string | null;
  /** Lead rows found under the header row at the last sync. */
  rowCount?: number;
}

/**
 * "https://docs.google.com/spreadsheets/d/<id>/edit?gid=123#gid=123" → { spreadsheetId, gid }.
 * Null when it isn't a Google Sheets link. No gid means the first tab.
 */
export function parseGoogleSheetUrl(url: string): { spreadsheetId: string; gid: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname !== 'docs.google.com') return null;
  const id = parsed.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)?.[1];
  if (!id) return null;
  const gid = parsed.hash.match(/gid=(\d+)/)?.[1] ?? parsed.searchParams.get('gid') ?? '0';
  return { spreadsheetId: id, gid: /^\d+$/.test(gid) ? gid : '0' };
}

/**
 * The CRM's Google service account from GOOGLE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY
 * (client_email / private_key of the JSON key file). Null when either is unset.
 * The key may arrive with literal "\n"s (pasted unquoted) — turned back into newlines.
 */
export function googleServiceAccount(get: (key: string) => string | undefined): { email: string; privateKey: string } | null {
  const email = get('GOOGLE_SERVICE_ACCOUNT_EMAIL')?.trim();
  const privateKey = get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')?.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  return email && privateKey ? { email, privateKey } : null;
}

/** Sheets API cell values → RFC 4180 CSV, so the Excel-import reader parses both sources the same way. */
export function valuesToCsv(values: unknown[][]): string {
  const cell = (v: unknown) => {
    const text = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return values.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function googleSheetCsvUrl({ spreadsheetId, gid }: Pick<GoogleSheetConfig, 'spreadsheetId' | 'gid'>): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

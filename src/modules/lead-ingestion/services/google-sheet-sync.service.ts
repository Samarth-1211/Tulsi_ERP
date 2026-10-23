import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Integration, IntegrationStatus, IntegrationType, LeadSource, Prisma, WebhookEventStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { cellText } from '../utils/lead-import.util';
import { GoogleSheetConfig, googleSheetCsvUrl } from '../utils/google-sheet.util';
import { toE164 } from './lead-dedup.service';
import { LeadFields, LeadImportService, ParsedSheet, SheetRow } from './lead-import.service';
import { LeadIngestionService } from './lead-ingestion.service';
import { LeadNotificationsService } from './lead-notifications.service';
import { GoogleSheetsApiService, SheetAccessDeniedError } from './google-sheets-api.service';

const SYNC_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SHEET_BYTES = 10 * 1024 * 1024;
// More new rows than this in one sync (e.g. the first sync of a full sheet):
// one summary per person instead of a notification per lead (see notifyBulkSheetSync).
const BULK_SILENT_THRESHOLD = 20;
// Row keys looked up per query when finding the rows already seen.
const KEY_LOOKUP_CHUNK = 1000;
// Per extra-column value kept on the lead.
const MAX_EXTRA_TEXT_LENGTH = 2000;

// A column with one of these headers tells two submissions by the same number apart
// (Google Forms' "Timestamp", Meta's "created_time").
const TIMESTAMP_HEADERS = new Set(['timestamp', 'createdtime', 'createdat', 'submittedat', 'submissiontime', 'submissiondate', 'date', 'time']);
// "16/09/2026", "2026-10-17T18:12:34+05:30", "17.10.2026 10:00" — digits on both sides of a date/time separator.
const LOOKS_LIKE_DATE = /\d[-/.:]\d/;

const NOT_SHARED =
  'Google asked for a sign-in — the sheet isn’t shared publicly. In Google Sheets: Share → General access → “Anyone with the link” (Viewer).';
const TOO_BIG = `The sheet is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB — move old rows to another tab.`;
const NO_HEADERS =
  'Couldn’t find the column headers. The first rows need a header row with a name column (e.g. "Name") and a mobile column (e.g. "Phone" or "Mobile No.").';

export interface SheetSyncResult {
  /** Lead rows under the header row. */
  rows: number;
  /** Rows not seen before, ingested in this sync. */
  newRows: number;
  created: number;
  /** New rows whose number already had an open lead — recorded on it as a re-enquiry. */
  reEnquiries: number;
  /** New rows that couldn't become a lead (no name, invalid number…) — see their WebhookEvent. */
  failed: number;
}

/** A problem with the sheet itself (not shared, bad link, no headers) — shown to the Admin as is. */
class SheetSyncError extends Error {}

/**
 * GOOGLE_SHEET integrations: every couple of minutes each sheet is downloaded —
 * through the Sheets API as the CRM's service account when one is configured
 * (private sheets shared with it), else its public CSV export — and read like
 * an Excel upload (same header names), and every
 * row not seen before goes through LeadIngestionService.ingest() — dedup by
 * phone, then allocation per the org's settings.
 *
 * Each row is stored as a WebhookEvent whose externalId is the row's key (its
 * mobile number, plus the timestamp column if the sheet has one), so a row is
 * ingested once however often the sheet is read, re-sorted or edited. A row
 * that fails (say, no mobile number yet) gets a new key once it's fixed, and
 * is tried again.
 *
 * Columns that aren't a lead field ("Budget", "Preferred brand"…) are kept on
 * the lead as customFields under their header, like a Meta form's extra answers.
 */
@Injectable()
export class GoogleSheetSyncService {
  private readonly logger = new Logger(GoogleSheetSyncService.name);
  private readonly syncing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly importService: LeadImportService,
    private readonly ingestion: LeadIngestionService,
    private readonly sheetsApi: GoogleSheetsApiService,
    private readonly leadNotifications: LeadNotificationsService,
  ) {}

  @Interval(SYNC_MS)
  async syncAll(): Promise<void> {
    const integrations = await this.prisma.integration.findMany({
      // ERROR is retried: the Admin may have fixed the sharing since.
      where: { type: IntegrationType.GOOGLE_SHEET, status: { in: [IntegrationStatus.ACTIVE, IntegrationStatus.ERROR] } },
    });
    for (const integration of integrations) {
      if (this.syncing.has(integration.id)) continue;
      await this.sync(integration).catch(() => undefined); // recorded on the integration
    }
  }

  /** "Sync now" on the Integrations page — waits for the result. */
  async syncNow(id: string, orgId: string): Promise<SheetSyncResult> {
    const integration = await this.prisma.integration.findFirst({ where: { id, orgId, type: IntegrationType.GOOGLE_SHEET } });
    if (!integration) throw new NotFoundException('Integration not found');
    if (integration.status === IntegrationStatus.INACTIVE) throw new BadRequestException('This sheet is deactivated — activate it first.');
    if (this.syncing.has(id)) throw new ConflictException('This sheet is already being synced — try again in a minute.');
    try {
      return await this.sync(integration);
    } catch (error) {
      if (error instanceof SheetSyncError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /** Right after the sheet is connected or changed, without making the Admin wait. */
  syncInBackground(id: string): void {
    void this.prisma.integration
      .findUnique({ where: { id } })
      .then((integration) => {
        if (integration?.type === IntegrationType.GOOGLE_SHEET && integration.status !== IntegrationStatus.INACTIVE && !this.syncing.has(id)) {
          return this.sync(integration);
        }
      })
      .catch(() => undefined);
  }

  private async sync(integration: Integration): Promise<SheetSyncResult> {
    this.syncing.add(integration.id);
    try {
      let sheet: ParsedSheet;
      try {
        sheet = await this.readSheet(integration.config as unknown as GoogleSheetConfig);
      } catch (error) {
        const message = error instanceof SheetSyncError ? error.message : `Couldn’t read the sheet: ${String(error)}`;
        this.logger.warn(`Google Sheet ${integration.id} (org ${integration.orgId}): ${message}`);
        await this.recordSync(integration.id, { lastSyncError: message }, false);
        throw new SheetSyncError(message);
      }

      const result = await this.ingestNewRows(integration, sheet);
      await this.recordSync(integration.id, { lastSyncError: null, rowCount: sheet.rows.length }, true, result.newRows > 0);
      if (result.newRows) {
        this.logger.log(
          `Google Sheet ${integration.id} (org ${integration.orgId}): ${result.newRows} new row(s) → ${result.created} created, ` +
            `${result.reEnquiries} re-enquiries, ${result.failed} failed`,
        );
      }
      return result;
    } finally {
      this.syncing.delete(integration.id);
    }
  }

  private async readSheet(config: GoogleSheetConfig | null): Promise<ParsedSheet> {
    if (!config?.spreadsheetId) throw new SheetSyncError('No sheet link saved — edit the integration and paste the link again.');

    const buffer = (await this.readViaApi(config)) ?? (await this.readPublicCsv(config));
    if (buffer.length > MAX_SHEET_BYTES) throw new SheetSyncError(TOO_BIG);

    try {
      return await this.importService.parseFile(buffer, '.csv', { maxRows: Infinity, allowEmpty: true });
    } catch (error) {
      if (error instanceof BadRequestException) throw new SheetSyncError(NO_HEADERS);
      throw error;
    }
  }

  /**
   * Through the Sheets API as the CRM's service account, when one is configured
   * — the sheet can then stay private. Null when the account may not open it:
   * the public link is tried instead.
   */
  private async readViaApi(config: GoogleSheetConfig): Promise<Buffer | null> {
    if (!this.sheetsApi.serviceAccountEmail) return null;
    try {
      return await this.sheetsApi.fetchCsv(config.spreadsheetId, config.gid, FETCH_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof SheetAccessDeniedError) return null;
      throw new SheetSyncError(error instanceof Error ? error.message : String(error));
    }
  }

  /** The CSV export of a sheet shared as "Anyone with the link". */
  private async readPublicCsv(config: GoogleSheetConfig): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(googleSheetCsvUrl(config), { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      throw new SheetSyncError(`Couldn’t reach Google Sheets: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 404) throw new SheetSyncError('Sheet not found — check the link.');
    // A private sheet redirects to Google's sign-in page, which answers 200 with HTML.
    if (res.status === 401 || res.status === 403 || (res.headers.get('content-type') ?? '').includes('text/html')) {
      const email = this.sheetsApi.serviceAccountEmail;
      throw new SheetSyncError(
        email ? `The CRM can’t open this sheet. In Google Sheets: Share → add ${email} as a Viewer (the sheet can stay private).` : NOT_SHARED,
      );
    }
    if (!res.ok) throw new SheetSyncError(`Google Sheets answered ${res.status} — check the link, and that the tab still exists.`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_SHEET_BYTES) throw new SheetSyncError(TOO_BIG);
    return Buffer.from(await res.arrayBuffer());
  }

  private async ingestNewRows(integration: Integration, { rows, ignoredColumns }: ParsedSheet): Promise<SheetSyncResult> {
    const keyed = rows.map((row) => {
      const parsed = this.importService.toLeadFields(row);
      if (parsed.fields) parsed.fields.customFields = this.customFields(row, ignoredColumns, parsed.fields.customFields);
      return { row, parsed, key: this.rowKey(integration.id, row, parsed.fields) };
    });

    // Rows already seen have an event. One still RECEIVED was cut off (a restart) — tried again.
    const seen = new Map<string, { id: string; status: WebhookEventStatus }>();
    const keys = [...new Set(keyed.map((k) => k.key))];
    for (let i = 0; i < keys.length; i += KEY_LOOKUP_CHUNK) {
      const events = await this.prisma.webhookEvent.findMany({
        where: { source: IntegrationType.GOOGLE_SHEET, externalId: { in: keys.slice(i, i + KEY_LOOKUP_CHUNK) } },
        select: { id: true, externalId: true, status: true },
      });
      for (const e of events) seen.set(e.externalId!, { id: e.id, status: e.status });
    }

    const pending = keyed.filter(({ key }) => {
      const event = seen.get(key);
      return !event || event.status === WebhookEventStatus.RECEIVED;
    });
    const silent = pending.length > BULK_SILENT_THRESHOLD;
    const result: SheetSyncResult = { rows: rows.length, newRows: 0, created: 0, reEnquiries: 0, failed: 0 };
    const done = new Set<string>();
    // Assignee of each new / re-enquired lead, for the bulk summary.
    const assignees = { created: [] as (string | null)[], reEnquired: [] as (string | null)[] };

    for (const { row, parsed, key } of pending) {
      if (done.has(key)) continue; // same number (and timestamp) as an earlier row of this sheet
      done.add(key);
      const eventId = seen.get(key)?.id ?? (await this.store(integration, row, key));
      if (!eventId) continue; // another server instance stored it first
      result.newRows++;
      const { outcome, assignedToId } = await this.ingestRow(integration, row, parsed, eventId, silent);
      result[outcome]++;
      if (outcome === 'created') assignees.created.push(assignedToId);
      if (outcome === 'reEnquiries') assignees.reEnquired.push(assignedToId);
    }

    if (silent) {
      await this.leadNotifications.notifyBulkSheetSync({ orgId: integration.orgId, sheetName: integration.name, ...assignees });
    }
    return result;
  }

  /**
   * What identifies a row across syncs: its mobile number (+ timestamp column),
   * so editing the name, city or any other cell doesn't import it again. A row
   * that can't become a lead is keyed on all its lead cells — fixing it changes the key.
   */
  private rowKey(integrationId: string, row: SheetRow, fields: LeadFields | undefined): string {
    const phone = fields ? toE164(fields.phone) : null;
    // Only a value that looks like a date/time counts: a "Date" column holding a serial
    // number (1, 2, 3…) would re-import every row the day someone renumbers it.
    const timestamp = Object.entries(row.raw).find(
      ([header, value]) => TIMESTAMP_HEADERS.has(header.toLowerCase().replace(/[^a-z]/g, '')) && LOOKS_LIKE_DATE.test(String(value ?? '')),
    )?.[1];
    const identity = phone
      ? JSON.stringify(['phone', phone, timestamp ?? null])
      : JSON.stringify(['row', Object.entries(row.values).map(([f, v]) => [f, cellText(v ?? null)]).sort()]);
    return `${integrationId}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
  }

  /** Remarks plus every filled column that isn't a lead field, by its header. Undefined when there are none. */
  private customFields(row: SheetRow, extraHeaders: string[], base: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const custom: Record<string, unknown> = { ...base };
    for (const header of extraHeaders) {
      const value = row.raw[header];
      if (value === undefined || value === null || value === '') continue;
      custom[header] = typeof value === 'string' ? value.slice(0, MAX_EXTRA_TEXT_LENGTH) : value;
    }
    return Object.keys(custom).length ? custom : undefined;
  }

  private async store(integration: Integration, row: SheetRow, key: string): Promise<string | null> {
    try {
      const event = await this.prisma.webhookEvent.create({
        data: {
          orgId: integration.orgId,
          integrationId: integration.id,
          source: IntegrationType.GOOGLE_SHEET,
          externalId: key,
          payload: { via: 'GOOGLE_SHEET', rowNumber: row.rowNumber, row: row.raw } as Prisma.InputJsonValue,
        },
      });
      return event.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  private async ingestRow(
    integration: Integration,
    row: SheetRow,
    { fields, error }: ReturnType<LeadImportService['toLeadFields']>,
    eventId: string,
    silent: boolean,
  ): Promise<{ outcome: 'created' | 'reEnquiries' | 'failed'; assignedToId: string | null }> {
    if (!fields) {
      await this.ingestion.markEvent(eventId, WebhookEventStatus.FAILED, null, `Row ${row.rowNumber}: ${error ?? 'could not be read'}`);
      return { outcome: 'failed', assignedToId: null };
    }
    try {
      const { outcome, lead } = await this.ingestion.ingest(
        {
          ...fields,
          orgId: integration.orgId,
          integrationId: integration.id,
          source: LeadSource.GOOGLE_SHEET,
          rawPayload: row.raw,
          channel: `${integration.name} (Google Sheet row ${row.rowNumber})`,
        },
        { webhookEventId: eventId, silent },
      );
      return { outcome: outcome === 'CREATED' ? 'created' : 'reEnquiries', assignedToId: lead.assignedToId };
    } catch (err) {
      // ingest() records an invalid number on the event itself; anything else is recorded here.
      const current = await this.prisma.webhookEvent.findUnique({ where: { id: eventId }, select: { status: true } });
      if (current?.status === WebhookEventStatus.RECEIVED) {
        await this.ingestion.markEvent(eventId, WebhookEventStatus.FAILED, null, `Row ${row.rowNumber}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { outcome: 'failed', assignedToId: null };
    }
  }

  /** The sync's outcome goes on config (shown on the Integrations page); a failed read sets status ERROR. */
  private async recordSync(id: string, patch: Partial<GoogleSheetConfig>, ok: boolean, gotRows = false): Promise<void> {
    const current = await this.prisma.integration.findUnique({ where: { id } });
    if (!current) return;
    await this.prisma.integration.update({
      where: { id },
      data: {
        config: { ...((current.config ?? {}) as object), ...patch, lastSyncedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        // Deactivated while syncing: stays off.
        ...(current.status !== IntegrationStatus.INACTIVE ? { status: ok ? IntegrationStatus.ACTIVE : IntegrationStatus.ERROR } : {}),
        ...(gotRows ? { lastEventAt: new Date() } : {}),
      },
    });
  }
}

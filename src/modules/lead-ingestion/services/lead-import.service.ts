import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { extname } from 'path';
import { Readable } from 'stream';
import { Workbook, Worksheet } from 'exceljs';
import { LeadImportAllocationMode, LeadImportStatus, LeadSource, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { uploadedFileName } from '../../../common/utils/upload.util';
import { INDIVIDUAL_CONTRIBUTOR_ROLES } from '../../../common/utils/lead-scope.util';
import { LeadAllocationService, QuotaSplitter, UploadQuota, UploadSplitter } from './lead-allocation.service';
import { LeadImportStorageService, SHEET_MIME_TYPES } from './lead-import-storage.service';
import { CLOSED_LEAD_STATUSES, LeadDedupService, leadLabel, toE164 } from './lead-dedup.service';
import { IngestInput, LeadIngestionService } from './lead-ingestion.service';
import { BulkAllocationRow, LeadNotificationsService } from './lead-notifications.service';
import {
  CellInput,
  cellInput,
  cellText,
  HEADER_SEARCH_ROWS,
  HeaderMapping,
  IMPORT_COLUMNS,
  ImportField,
  mapHeaderRow,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  parseDate,
  parseEmail,
  parsePhones,
  realignMetaOrderRow,
  toRawValue,
} from '../utils/lead-import.util';

/** One row's outcome worth telling the uploader about. */
export interface ImportIssue {
  row: number;
  /** error: not imported · duplicate: already in the CRM, skipped · warning: imported, but a value was left blank */
  level: 'error' | 'duplicate' | 'warning';
  message: string;
}

export interface SheetRow {
  /** The row number as Excel shows it. */
  rowNumber: number;
  values: Partial<Record<ImportField, CellInput>>;
  /** Every filled cell by its header, kept as the lead's rawPayload. */
  raw: Record<string, string | number | boolean | null>;
}

export interface ParsedSheet {
  rows: SheetRow[];
  ignoredColumns: string[];
}

export interface ReadRowsOptions {
  maxRows?: number;
  /** A header row with no leads under it yet is fine (a newly connected Google Sheet). */
  allowEmpty?: boolean;
}

export type LeadFields = Pick<
  IngestInput,
  | 'name'
  | 'phone'
  | 'altPhone'
  | 'email'
  | 'city'
  | 'pincode'
  | 'address'
  | 'buyingFor'
  | 'requirementNotes'
  | 'feedback'
  | 'enquiredAt'
  | 'customFields'
  | 'attribution'
>;

/** The row's numbers in E.164 — what duplicates are matched on. */
function phoneKeys(fields: LeadFields): string[] {
  return [fields.phone, fields.altPhone].map((p) => toE164(p)).filter((p): p is string => !!p);
}

// Per kind (skipped rows / warnings) — keeps the batch row a sensible size; its counts stay exact regardless.
const MAX_STORED_ISSUES = 500;
// How often the progress numbers are written back while importing.
const PROGRESS_FLUSH_MS = 750;
const MAX_TEXT_LENGTH = 2000;

const BATCH_INCLUDE = {
  uploadedBy: { select: { id: true, name: true, role: true } },
  collaborators: { select: { manager: { select: { id: true, name: true } } } },
  _count: { select: { leads: true } },
} satisfies Prisma.LeadImportBatchInclude;

type BatchWithRelations = Prisma.LeadImportBatchGetPayload<{ include: typeof BATCH_INCLUDE }>;

/**
 * The batch as the API returns it: collaborators flattened to the Managers
 * themselves, the stored file's disk key swapped for a `hasFile` flag, and
 * `leadCount` — how many of its leads are still in the CRM (some may have
 * been deleted since).
 */
function toBatchResponse({ collaborators, fileStorageKey, _count, ...batch }: BatchWithRelations) {
  return {
    ...batch,
    hasFile: !!fileStorageKey,
    leadCount: _count.leads,
    collaborators: collaborators.map((c) => c.manager),
  };
}

function uploaderLabel(role: Role, name: string): string {
  return `${role === Role.MANAGER ? 'Manager' : 'Admin'} ${name}`;
}

/** Who the uploader wants the sheet's leads to go to, as the upload form sends it. */
export interface ImportAllocationRequest {
  allocationMode?: LeadImportAllocationMode;
  managerIds?: string[];
  /** CUSTOM only: a JSON array of `{ userId, count }` — how many of the sheet's leads each person gets. */
  customAllocations?: string;
  /** Older clients: the other Managers a Manager shares the sheet with, on top of themselves. */
  collaboratorIds?: string[];
}

const MAX_CUSTOM_RECIPIENTS = 200;
// Phone numbers looked up per query when counting a sheet's duplicates.
const DEDUP_LOOKUP_CHUNK = 1000;

/**
 * "Upload leads from Excel", for Admins and Managers: the file is read and
 * checked up front (a bad file is rejected before anything is saved) and
 * kept on disk for the Admin to download later, then its rows are imported
 * in the background — each one deduplicated by phone number and marked as
 * provided by the uploader — while the uploader's screen polls the batch for
 * progress.
 *
 * The uploader chooses who gets the leads: every Manager's presales team;
 * specific Managers — each of whom gets an equal share, kept to themselves
 * or spread across themselves and their presales team; or a custom split,
 * naming people and how many leads each gets (the sheet is counted first —
 * see previewImport — so they know what there is to give out).
 */
@Injectable()
export class LeadImportService implements OnModuleInit {
  private readonly logger = new Logger(LeadImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allocationService: LeadAllocationService,
    private readonly dedupService: LeadDedupService,
    private readonly leadNotifications: LeadNotificationsService,
    private readonly storage: LeadImportStorageService,
    private readonly ingestion: LeadIngestionService,
  ) {}

  /** Imports run inside this process, so one still "processing" at startup was cut off by a restart. */
  async onModuleInit(): Promise<void> {
    const { count } = await this.prisma.leadImportBatch.updateMany({
      where: { status: LeadImportStatus.PROCESSING },
      data: {
        status: LeadImportStatus.FAILED,
        completedAt: new Date(),
        error:
          'The server restarted before this upload finished. Upload the file again — leads that were already imported will be skipped as duplicates.',
      },
    });
    if (count > 0) {
      this.logger.warn(`Marked ${count} interrupted lead upload(s) as failed`);
    }
  }

  /**
   * Counts what a sheet holds before it's uploaded, so the uploader can
   * decide who gets how many: rows that would become new leads, rows whose
   * number is already in the CRM (or repeats an earlier row), and rows that
   * can't be read. Nothing is saved.
   */
  async previewImport(actor: AuthenticatedUser, file: Express.Multer.File | undefined) {
    const { buffer, fileName, ext } = this.checkFile(file);
    const sheet = await this.parseFile(buffer, ext);

    let invalidCount = 0;
    let duplicateCount = 0;
    const seen = new Set<string>();
    const candidates: string[][] = [];
    for (const row of sheet.rows) {
      const { fields, error } = this.toLeadFields(row);
      if (error || !fields) {
        invalidCount++;
        continue;
      }
      const keys = phoneKeys(fields);
      if (keys.some((key) => seen.has(key))) {
        duplicateCount++;
        continue;
      }
      keys.forEach((key) => seen.add(key));
      candidates.push(keys);
    }

    const inCrm = new Set<string>();
    const allKeys = [...seen];
    for (let i = 0; i < allKeys.length; i += DEDUP_LOOKUP_CHUNK) {
      const chunk = allKeys.slice(i, i + DEDUP_LOOKUP_CHUNK);
      const existing = await this.prisma.lead.findMany({
        where: {
          orgId: actor.orgId,
          phone: { in: chunk },
          deletedAt: null,
          status: { notIn: CLOSED_LEAD_STATUSES },
        },
        select: { phone: true },
      });
      for (const lead of existing) inCrm.add(lead.phone);
    }
    const alreadyInCrm = candidates.filter((keys) => keys.some((key) => inCrm.has(key))).length;

    return {
      fileName,
      totalRows: sheet.rows.length,
      newLeadCount: candidates.length - alreadyInCrm,
      duplicateCount: duplicateCount + alreadyInCrm,
      invalidCount,
      ignoredColumns: sheet.ignoredColumns,
    };
  }

  async startImport(actor: AuthenticatedUser, file: Express.Multer.File | undefined, request: ImportAllocationRequest = {}) {
    const { buffer, size, fileName, ext } = this.checkFile(file);
    const { mode, managers, quotas } = await this.resolveAllocation(actor, request);
    const sheet = await this.parseFile(buffer, ext);
    if (quotas) {
      const givenOut = quotas.reduce((sum, q) => sum + q.count, 0);
      if (givenOut > sheet.rows.length) {
        throw new BadRequestException(
          `You gave out ${givenOut.toLocaleString('en-IN')} leads, but this sheet only has ${sheet.rows.length.toLocaleString('en-IN')}`,
        );
      }
    }
    const uploader = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { name: true },
    });

    const storageKey = await this.storage.save(buffer, ext);
    let batch: BatchWithRelations;
    try {
      batch = await this.prisma.leadImportBatch.create({
        data: {
          orgId: actor.orgId,
          uploadedById: actor.userId,
          fileName,
          totalRows: sheet.rows.length,
          ignoredColumns: sheet.ignoredColumns,
          fileStorageKey: storageKey,
          fileMimeType: SHEET_MIME_TYPES[ext],
          fileSizeBytes: size,
          allocationMode: mode,
          collaborators: { create: managers.map((m) => ({ managerId: m.id })) },
        },
        include: BATCH_INCLUDE,
      });
    } catch (error) {
      await this.storage.delete(storageKey);
      throw error;
    }

    // Deliberately not awaited: the response returns right away and the
    // uploader's screen polls getBatch() for progress. processBatch never
    // rejects — any failure is recorded on the batch.
    void this.processBatch(batch.id, actor, uploader.name, fileName, sheet, {
      mode,
      managerIds: managers.map((m) => m.id),
      managerNames: managers.map((m) => m.name),
      quotas,
    });

    return toBatchResponse(batch);
  }

  /** The upload's name and type, once it's known to be a sheet we can read. */
  private checkFile(file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('Choose an Excel (.xlsx) or CSV file to upload');
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      throw new BadRequestException('This file is larger than 10 MB — split it into smaller files');
    }

    const fileName = uploadedFileName(file);
    const ext = extname(fileName).toLowerCase();
    if (ext === '.xls') {
      throw new BadRequestException('Old-style .xls files can’t be read — open it in Excel, save it as .xlsx, then upload that');
    }
    if (ext !== '.xlsx' && ext !== '.csv') {
      throw new BadRequestException('Upload an Excel (.xlsx) or CSV file');
    }
    return { buffer: file.buffer, size: file.size, fileName, ext };
  }

  /** One upload's progress and outcome — a Manager can only follow their own uploads. */
  async getBatch(actor: AuthenticatedUser, id: string) {
    const batch = await this.prisma.leadImportBatch.findFirst({
      where: {
        id,
        orgId: actor.orgId,
        ...(actor.role === Role.MANAGER ? { uploadedById: actor.userId } : {}),
      },
      include: BATCH_INCLUDE,
    });
    if (!batch) {
      throw new NotFoundException('Upload not found');
    }
    return toBatchResponse(batch);
  }

  /**
   * Every sheet uploaded in the org, newest first — for the Admin's upload
   * history: when, by whom, shared with which collaborators, and how it went.
   * Row-level issues are left out here; getBatch has them.
   */
  async listBatches(actor: AuthenticatedUser, page = 1, pageSize = 25) {
    const where: Prisma.LeadImportBatchWhereInput = { orgId: actor.orgId };
    const [batches, total] = await Promise.all([
      this.prisma.leadImportBatch.findMany({
        where,
        include: BATCH_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.leadImportBatch.count({ where }),
    ]);

    return {
      items: batches.map(({ issues: _issues, ...batch }) => toBatchResponse({ ...batch, issues: null })),
      total,
      page,
      pageSize,
    };
  }

  /** The sheet exactly as it was uploaded, for the Admin to download. */
  async openFile(actor: AuthenticatedUser, id: string) {
    const batch = await this.prisma.leadImportBatch.findFirst({
      where: { id, orgId: actor.orgId },
      select: { fileName: true, fileStorageKey: true, fileMimeType: true },
    });
    if (!batch) {
      throw new NotFoundException('Upload not found');
    }
    if (!batch.fileStorageKey) {
      throw new NotFoundException('The original file wasn’t kept for this upload — it was made before uploaded sheets were stored');
    }

    const file = await this.storage.open(batch.fileStorageKey);
    if (!file) {
      this.logger.warn(`Lead sheet file ${batch.fileStorageKey} for upload ${id} is missing from disk`);
      throw new NotFoundException('The original file for this upload is missing from storage');
    }

    return {
      ...file,
      fileName: batch.fileName,
      mimeType: batch.fileMimeType ?? 'application/octet-stream',
    };
  }

  /**
   * Who the sheet goes to. Anyone uploading may send it to every team or
   * pick Managers — a Manager picks themselves to take a share. A client
   * from before there was a choice sends no mode: an Admin's sheet then goes
   * to every team, a Manager's to themselves and their collaborators.
   */
  private async resolveAllocation(
    actor: AuthenticatedUser,
    { allocationMode, managerIds, customAllocations, collaboratorIds = [] }: ImportAllocationRequest,
  ): Promise<{
    mode: LeadImportAllocationMode;
    managers: { id: string; name: string }[];
    quotas?: UploadQuota[];
  }> {
    if (allocationMode && collaboratorIds.length > 0) {
      throw new BadRequestException('Send the picked managers as managerIds — collaboratorIds can’t be combined with allocationMode');
    }
    if (allocationMode === LeadImportAllocationMode.CUSTOM) {
      if (managerIds?.length) {
        throw new BadRequestException('A custom split names its people in customAllocations, not managerIds');
      }
      return { mode: allocationMode, managers: [], quotas: await this.resolveQuotas(actor, customAllocations) };
    }
    if (customAllocations) {
      throw new BadRequestException('customAllocations only goes with the CUSTOM allocation mode');
    }

    const isManager = actor.role === Role.MANAGER;
    const mode =
      allocationMode ?? (isManager ? LeadImportAllocationMode.MANAGERS_AND_TEAMS : LeadImportAllocationMode.ALL_TEAMS);
    const olderClientIds = !allocationMode && isManager ? [actor.userId, ...collaboratorIds] : collaboratorIds;
    const ids = [...new Set(managerIds ?? olderClientIds)];

    if (mode === LeadImportAllocationMode.ALL_TEAMS) {
      if (ids.length > 0) {
        throw new BadRequestException('Managers are only picked when the sheet is shared with specific managers — this upload goes to every team');
      }
      return { mode, managers: [] };
    }
    if (ids.length === 0) {
      throw new BadRequestException('Pick at least one manager to share this sheet with');
    }

    const managers = await this.prisma.user.findMany({
      where: {
        id: { in: ids },
        orgId: actor.orgId,
        role: Role.MANAGER,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (managers.length !== ids.length) {
      throw new BadRequestException('One or more of the picked managers aren’t active managers in your organization');
    }
    return { mode, managers };
  }

  /**
   * A custom split, as the upload form sends it: who gets how many leads.
   * The same reach as assigning a lead by hand — an Admin can name any
   * Manager or team member; a Manager themselves, their own team, or
   * another Manager. Unlike the equal-share modes, people get their number
   * even if they're absent today: the uploader named them.
   */
  private async resolveQuotas(actor: AuthenticatedUser, raw: string | undefined): Promise<UploadQuota[]> {
    let entries: unknown;
    try {
      entries = JSON.parse(raw ?? '');
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BadRequestException('Give at least one person a number of leads');
    }
    if (entries.length > MAX_CUSTOM_RECIPIENTS) {
      throw new BadRequestException(`A sheet can be split between at most ${MAX_CUSTOM_RECIPIENTS} people`);
    }

    const countByUser = new Map<string, number>();
    for (const entry of entries as { userId?: unknown; count?: unknown }[]) {
      const { userId, count } = entry ?? {};
      if (typeof userId !== 'string' || !userId || typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        throw new BadRequestException('Each person needs a whole number of leads, 1 or more');
      }
      if (countByUser.has(userId)) {
        throw new BadRequestException('Each person can only be listed once');
      }
      countByUser.set(userId, count);
    }

    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...countByUser.keys()] },
        orgId: actor.orgId,
        role: { in: [Role.MANAGER, ...INDIVIDUAL_CONTRIBUTOR_ROLES] },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        role: true,
        managerId: true,
        manager: { select: { name: true } },
      },
    });
    if (users.length !== countByUser.size) {
      throw new BadRequestException('One or more of the people picked aren’t active managers or team members in your organization');
    }
    if (
      actor.role === Role.MANAGER &&
      users.some((u) => u.id !== actor.userId && u.managerId !== actor.userId && u.role !== Role.MANAGER)
    ) {
      throw new ForbiddenException('Managers can only give leads to themselves, their own team, or another Manager');
    }

    const userById = new Map(users.map((u) => [u.id, u]));
    return [...countByUser].map(([userId, count]) => {
      const user = userById.get(userId)!;
      const name = user.name;
      const isManager = user.role === Role.MANAGER;
      return {
        userId,
        name,
        count,
        team: {
          managerId: isManager ? userId : user.managerId,
          managerName: isManager ? name : user.manager ? user.manager.name : null,
          members: [],
        },
      };
    });
  }

  /** Blank upload sheet with the expected columns, plus an instructions sheet. */
  async buildTemplate(): Promise<Buffer> {
    const workbook = new Workbook();

    // Only headers on the upload sheet — an example row left in by mistake
    // would be imported as a real lead. Examples live on the instructions sheet.
    const leads = workbook.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
    leads.columns = IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.field, width: Math.max(14, c.header.length + 4) }));
    leads.getRow(1).font = { bold: true };
    IMPORT_COLUMNS.forEach((c, i) => {
      if (c.required) {
        leads.getRow(1).getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
      }
    });
    // Text, so Excel keeps a leading + or 0 on mobile numbers.
    leads.getColumn('phone').numFmt = '@';

    const help = workbook.addWorksheet('Instructions');
    help.columns = [
      { header: 'Column', key: 'header', width: 24 },
      { header: 'Required', key: 'required', width: 10 },
      { header: 'What to enter', key: 'hint', width: 70 },
      { header: 'Example', key: 'example', width: 26 },
    ];
    help.getRow(1).font = { bold: true };
    for (const c of IMPORT_COLUMNS) {
      help.addRow({ header: c.header, required: c.required ? 'Yes' : '', hint: c.hint, example: c.example });
    }
    help.addRow({});
    for (const note of [
      'Enter one lead per row on the Leads sheet, starting right under the header row.',
      'A lead with more than one mobile number: put them all in the Mobile No. cell separated by commas, e.g. "9876543210, 9123456789". The first is the main number; the others are saved as alternate numbers of the same lead.',
      'Keep the Mobile No. column formatted as Text (Home → Number → Text) — otherwise Excel reads comma-separated numbers as one long number and the digits are lost.',
      'A lead whose mobile number (any of them) is already in the CRM is skipped, not duplicated.',
      'Leads are marked as provided by you. When uploading, you choose who gets them: every manager’s presales team, or specific managers — each picked manager gets an equal share, kept to themselves or spread across themselves and their team; or a custom split, where you say how many leads each person gets.',
      `Up to ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} leads and 10 MB per file. Columns not listed above are ignored.`,
    ]) {
      help.addRow({ header: 'Note', hint: note });
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // --- Reading the file -----------------------------------------------------

  /** Also reads Google Sheets' CSV export (GoogleSheetSyncService), which has no row cap and may be empty. */
  async parseFile(buffer: Buffer, ext: string, options: ReadRowsOptions = {}): Promise<ParsedSheet> {
    const workbook = new Workbook();
    let worksheets: Worksheet[];
    try {
      if (ext === '.csv') {
        // Identity map: keep every cell as typed instead of letting the
        // reader guess numbers and dates (it would strip a phone's leading +).
        worksheets = [await workbook.csv.read(Readable.from(buffer), { map: (value: unknown) => value })];
      } else {
        // exceljs types its input as its own ArrayBuffer-shaped Buffer; a Node Buffer is what it reads at runtime.
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
        worksheets = workbook.worksheets;
      }
    } catch (error) {
      this.logger.warn(`Could not read uploaded lead sheet: ${error}`);
      throw new BadRequestException('This file couldn’t be read as a spreadsheet. Check that it opens in Excel, then upload it again.');
    }

    for (const worksheet of worksheets) {
      const lastCandidate = Math.min(worksheet.rowCount, HEADER_SEARCH_ROWS);
      for (let r = 1; r <= lastCandidate; r++) {
        const mapping = mapHeaderRow(this.rowTexts(worksheet, r));
        if (mapping) return this.readRows(worksheet, r, mapping, options);
      }
    }

    throw new BadRequestException(
      'Couldn’t find the column headers. The sheet needs a header row with at least "Customer Name" and "Mobile No." — download the template to see every column.',
    );
  }

  private rowTexts(worksheet: Worksheet, rowNumber: number): Map<number, string> {
    const cells = new Map<number, string>();
    worksheet.getRow(rowNumber).eachCell((cell, col) => cells.set(col, cellText(cellInput(cell.value))));
    return cells;
  }

  private readRows(worksheet: Worksheet, headerRow: number, mapping: HeaderMapping, { maxRows = MAX_IMPORT_ROWS, allowEmpty = false }: ReadRowsOptions): ParsedSheet {
    const rows: SheetRow[] = [];
    // The last row holding only a date ("16/09/2026"): the enquiry date of the rows under it.
    let dayHeading: CellInput = null;

    for (let r = headerRow + 1; r <= worksheet.rowCount; r++) {
      const values: SheetRow['values'] = {};
      const raw: SheetRow['raw'] = {};

      const cells: CellInput[] = [];
      const byColumn = new Map<number, CellInput>();
      worksheet.getRow(r).eachCell((cell, col) => {
        cells[col] = cellInput(cell.value);
        byColumn.set(col, cells[col]);
      });
      const aligned = realignMetaOrderRow(cells, mapping) ?? byColumn;
      for (const [col, value] of aligned) {
        if (value === null || value === undefined) continue;
        const header = mapping.headers.get(col);
        if (header) raw[header] = toRawValue(value);
        const field = mapping.fields.get(col);
        if (field) values[field] = value;
      }

      const filled = Object.keys(values);
      if (!filled.length) continue; // blank line
      if (filled.length === 1 && values.enquiredAt !== undefined) {
        if (parseDate(values.enquiredAt)) dayHeading = values.enquiredAt;
        continue;
      }
      // No date of its own (or a serial number 1, 2, 3… in a "Date" column): the day heading's.
      if (dayHeading !== null && (values.enquiredAt === undefined || !parseDate(values.enquiredAt))) values.enquiredAt = dayHeading;
      rows.push({ rowNumber: r, values, raw });
      if (rows.length > maxRows) {
        throw new BadRequestException(
          `This file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} leads — split it into smaller files and upload them one at a time.`,
        );
      }
    }

    if (rows.length === 0 && !allowEmpty) {
      throw new BadRequestException('No leads found under the header row.');
    }
    return { rows, ignoredColumns: mapping.ignored };
  }

  // --- Importing the rows ---------------------------------------------------

  private async processBatch(
    batchId: string,
    actor: AuthenticatedUser,
    uploaderName: string,
    fileName: string,
    sheet: ParsedSheet,
    {
      mode,
      managerIds,
      managerNames,
      quotas,
    }: { mode: LeadImportAllocationMode; managerIds: string[]; managerNames: string[]; quotas?: UploadQuota[] },
  ): Promise<void> {
    const { orgId } = actor;
    const providedBy = uploaderLabel(actor.role, uploaderName);
    // With nobody available among those picked — or leads left over once a
    // custom split is used up — a Manager's leads fall back to the Manager
    // themselves: left unassigned, they'd drop out of view (unassigned
    // leads are the Admin's to hand out).
    const fallbackAssignee =
      actor.role === Role.MANAGER
        ? {
            userId: actor.userId,
            name: uploaderName,
            team: { managerId: actor.userId, managerName: uploaderName, members: [] },
          }
        : null;
    const counts = { processedRows: 0, createdCount: 0, duplicateCount: 0, failedCount: 0 };
    // Rows that weren't imported are kept apart from mere warnings, so a
    // sheet full of warnings can't crowd them out of the stored list.
    const skipped: ImportIssue[] = [];
    const warned: ImportIssue[] = [];
    const addIssue = (issue: ImportIssue) => {
      const list = issue.level === 'warning' ? warned : skipped;
      if (list.length < MAX_STORED_ISSUES) list.push(issue);
    };
    const allocation = new Map<string, BulkAllocationRow>();
    let failure: string | null = null;

    try {
      const splitter: UploadSplitter = quotas
        ? new QuotaSplitter(quotas)
        : await this.allocationService.createTeamSplitter(
            orgId,
            mode === LeadImportAllocationMode.ALL_TEAMS
              ? undefined
              : { ids: managerIds, withTeams: mode === LeadImportAllocationMode.MANAGERS_AND_TEAMS },
          );
      const rowByPhone = new Map<string, number>();
      let lastFlush = Date.now();

      for (const row of sheet.rows) {
        try {
          const { fields, warnings, error } = this.toLeadFields(row);
          if (error || !fields) {
            counts.failedCount++;
            addIssue({ row: row.rowNumber, level: 'error', message: error ?? 'Could not be read' });
            continue;
          }

          // Every number on the row — main and alternates — is checked, both
          // against earlier rows of this sheet and against leads already saved.
          const keys = phoneKeys(fields);
          const earlierRow = keys.map((key) => rowByPhone.get(key)).find((r) => r !== undefined);
          if (earlierRow) {
            counts.duplicateCount++;
            addIssue({ row: row.rowNumber, level: 'duplicate', message: `Same mobile number as row ${earlierRow} — skipped` });
            continue;
          }
          keys.forEach((key) => rowByPhone.set(key, row.rowNumber));

          // A number with an open lead becomes a re-enquiry on it (no new
          // lead) — and doesn't use up anyone's turn in the split.
          const existing = keys.length ? await this.dedupService.findOpenByPhone(orgId, keys[0]) : null;
          const assignee = existing ? null : (splitter.next() ?? fallbackAssignee);

          const { outcome } = await this.ingestion.ingest(
            {
              ...fields,
              orgId,
              source: LeadSource.CSV_IMPORT,
              importBatchId: batchId,
              createdById: actor.userId,
              assignToId: assignee?.userId,
              rawPayload: row.raw,
              channel: `Excel upload by ${providedBy} (${fileName}, row ${row.rowNumber})`,
            },
            { silent: true, noAutoAssign: true },
          );
          if (outcome !== 'CREATED') {
            counts.duplicateCount++;
            addIssue({
              row: row.rowNumber,
              level: 'duplicate',
              message: `Already in the CRM${existing ? ` as ${leadLabel(existing)}` : ''} — recorded as a re-enquiry`,
            });
            continue;
          }

          warnings.forEach(addIssue);
          counts.createdCount++;

          if (assignee) {
            const tally = allocation.get(assignee.userId) ?? {
              userId: assignee.userId,
              name: assignee.name,
              managerId: assignee.team.managerId,
              managerName: assignee.team.managerName,
              count: 0,
            };
            tally.count++;
            allocation.set(assignee.userId, tally);
          }
        } catch (error) {
          counts.failedCount++;
          addIssue({ row: row.rowNumber, level: 'error', message: 'Could not be saved — upload this row again' });
          this.logger.error(`Lead import ${batchId}: row ${row.rowNumber} failed: ${error}`);
        } finally {
          counts.processedRows++;
          if (Date.now() - lastFlush >= PROGRESS_FLUSH_MS) {
            await this.prisma.leadImportBatch.update({ where: { id: batchId }, data: counts });
            lastFlush = Date.now();
          }
        }
      }
    } catch (error) {
      this.logger.error(`Lead import ${batchId} stopped part-way: ${error}`);
      failure =
        'Something went wrong part-way through this upload. Upload the file again — leads that were already imported will be skipped as duplicates.';
    }

    const allocationRows = [...allocation.values()].sort(
      (a, b) => (a.managerName ?? '').localeCompare(b.managerName ?? '') || a.name.localeCompare(b.name),
    );

    try {
      await this.prisma.leadImportBatch.update({
        where: { id: batchId },
        data: {
          ...counts,
          status: failure ? LeadImportStatus.FAILED : LeadImportStatus.COMPLETED,
          error: failure,
          completedAt: new Date(),
          issues: [...skipped, ...warned] as unknown as Prisma.InputJsonArray,
          allocation: allocationRows as unknown as Prisma.InputJsonArray,
        },
      });
    } catch (error) {
      this.logger.error(`Lead import ${batchId}: could not record the result: ${error}`);
    }

    await this.leadNotifications.notifyBulkUpload({
      orgId,
      uploader: { id: actor.userId, name: uploaderName, role: actor.role },
      allocationMode: mode,
      managerNames,
      fileName,
      createdCount: counts.createdCount,
      allocation: allocationRows,
    });

    this.logger.log(
      `Lead import ${batchId} (${fileName}) by ${actor.email}: ${counts.createdCount} created, ` +
        `${counts.duplicateCount} duplicate(s), ${counts.failedCount} failed of ${sheet.rows.length}`,
    );
  }

  /**
   * One row's lead fields. A missing/invalid name or mobile number rejects
   * the row; any other value that can't be used is left blank with a warning.
   */
  toLeadFields(row: SheetRow): { fields?: LeadFields; warnings: ImportIssue[]; error?: string } {
    const v = row.values;
    const warnings: ImportIssue[] = [];
    const warn = (message: string) => warnings.push({ row: row.rowNumber, level: 'warning', message });

    const text = (field: ImportField): string | undefined => cellText(v[field] ?? null).slice(0, MAX_TEXT_LENGTH) || undefined;

    function optional<T>(field: ImportField, label: string, parse: (value: CellInput) => T | undefined): T | undefined {
      const raw = v[field];
      if (raw == null || cellText(raw) === '') return undefined;
      const parsed = parse(raw);
      if (parsed === undefined) warn(`${label} "${cellText(raw)}" wasn’t recognised — left blank`);
      return parsed;
    }

    const name = text('name')?.slice(0, 200);
    if (!name) return { warnings, error: 'Customer Name is empty — skipped' };

    const { phones, invalid, mangled } = parsePhones(v.phone ?? null);
    if (mangled) {
      return {
        warnings,
        error:
          'Mobile No. was turned into one long number by Excel — format the column as Text, re-type the numbers separated by commas, then upload again — skipped',
      };
    }
    const [phone, altPhone, ...extraPhones] = phones;
    if (!phone) {
      return {
        warnings,
        error: v.phone != null ? `Mobile No. "${cellText(v.phone)}" isn’t a valid number — skipped` : 'Mobile No. is empty — skipped',
      };
    }
    for (const bad of invalid) warn(`Mobile No. "${bad}" isn’t a valid number — left out`);
    if (extraPhones.length) warn(`Only two mobile numbers are kept per lead — left out: ${extraPhones.join(', ')}`);

    // Meta's ad id is written "ag:120249…" in its exports.
    const adId = text('adId')?.replace(/^ag:/i, '').trim().slice(0, 100);
    return {
      warnings,
      fields: {
        name,
        phone,
        altPhone,
        email: optional('email', 'Email', parseEmail),
        city: text('city'),
        pincode: text('pincode'),
        address: text('address'),
        buyingFor: text('buyingFor')?.slice(0, 200),
        requirementNotes: text('requirementNotes'),
        feedback: text('feedback'),
        enquiredAt: optional('enquiredAt', 'Date', parseDate),
        attribution: adId ? { adId } : undefined,
      },
    };
  }
}

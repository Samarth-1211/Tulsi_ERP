import type { CellValue } from 'exceljs';

/**
 * Column layout of the "upload leads from Excel" sheet, and the lenient
 * parsing of its cells. Every uploaded row goes through
 * LeadIngestionService.ingest() with source CSV_IMPORT.
 */

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

// The header row may sit below a title or a blank line or two.
export const HEADER_SEARCH_ROWS = 10;

// Wall-clock times typed into a sheet are Indian time (see business-date.util).
const IST_OFFSET_MS = 330 * 60 * 1000;

export type ImportField =
  | 'name'
  | 'phone'
  | 'email'
  | 'city'
  | 'pincode'
  | 'address'
  | 'buyingFor'
  | 'requirementNotes'
  | 'feedback'
  | 'enquiredAt'
  | 'adId';

export interface ImportColumn {
  field: ImportField;
  /** The header in the downloadable template. */
  header: string;
  /** Other headers accepted for this column (matched ignoring case, spaces and punctuation). */
  aliases?: string[];
  required?: boolean;
  /** What goes in the column, for the template's instructions sheet. */
  hint: string;
  example: string | number;
}

/** The Meta lead form question saved as Lead.buyingFor ("Buying For") — its key in Meta and in Meta's sheet exports. */
export const BUYING_FOR_QUESTION_KEY = 'आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_';
/** The Meta lead form question saved in Lead.requirementNotes ("Requirement"). */
export const REQUIREMENT_QTY_QUESTION_KEY = '_आपकी_approx._requirement_कितनी_है?';

export const IMPORT_COLUMNS: ImportColumn[] = [
  {
    field: 'name',
    header: 'Customer Name',
    aliases: ['Name', 'Full Name', 'Customer', 'Lead Name', 'Client Name', 'Firm Name', 'Shop Name'],
    required: true,
    hint: 'Required.',
    example: 'Sharma Hardware',
  },
  {
    field: 'phone',
    header: 'Mobile No.',
    aliases: ['Mobile', 'Mobile Number', 'Phone', 'Phone Number', 'Phone No', 'Contact', 'Contact Number', 'Contact No', 'WhatsApp Number'],
    required: true,
    hint:
      'Required. With or without +91. For more than one number, separate them with commas — the first is the main number, the second is saved as the alternate number. Keep this column formatted as Text.',
    example: '+919812345678, 9123456789',
  },
  { field: 'email', header: 'Email', aliases: ['Email ID', 'Email Address', 'E-mail', 'Mail'], hint: 'Optional.', example: 'sharma@example.com' },
  { field: 'city', header: 'City', aliases: ['Location', 'Town', 'District'], hint: 'Optional.', example: 'Indore' },
  { field: 'pincode', header: 'Pincode', aliases: ['Pin Code', 'PIN', 'Zip', 'Postal Code'], hint: 'Optional.', example: '452001' },
  { field: 'address', header: 'Address', aliases: ['Full Address', 'Shop Address'], hint: 'Optional.', example: 'Siyaganj, Indore' },
  {
    field: 'buyingFor',
    header: 'Buying For',
    aliases: [BUYING_FOR_QUESTION_KEY, 'Customer Type', 'Type', 'Category', 'Customer Category', 'Buying for whom', 'Purchase for', 'Purchase purpose'],
    hint: 'Optional. Who the plywood is for — own home, dealer / retailer, contractor / carpenter, architect / interior designer… Kept as written.',
    example: 'Dealer / retailer',
  },
  {
    field: 'requirementNotes',
    header: 'Requirement',
    aliases: [
      'Requirements', 'Requirement Notes', 'Product', 'Products', 'Interest', 'Enquiry',
      REQUIREMENT_QTY_QUESTION_KEY, 'Approx. Requirement', 'Approx Requirement', 'Requirement Quantity', 'Quantity', 'Qty',
    ],
    hint: 'Optional, e.g. product, thickness, size and quantity ("18mm BWP 8x4, 50 sheets" or "10–30 sheets").',
    example: '18mm BWP 8x4, 50 sheets',
  },
  {
    field: 'feedback',
    header: 'Feedback',
    aliases: ['Remarks', 'Notes', 'Note', 'Comments', 'Comment', 'Message', 'Caller Feedback', 'Customer Feedback'],
    hint: 'Optional.',
    example: 'Call after 5 pm',
  },
  {
    field: 'enquiredAt',
    header: 'Date',
    aliases: ['Lead Date', 'Enquiry Date', 'created_time', 'Created Time', 'Timestamp', 'Submitted At'],
    hint: 'Optional: when the lead came in, e.g. 16/09/2026 or 16/09/2026 10:30 — empty means the upload date. A row holding only a date is read as the date of the rows under it.',
    example: '16/09/2026',
  },
  {
    field: 'adId',
    header: 'Ad ID',
    aliases: ['ad_id', 'Meta Ad ID'],
    hint: 'Optional. The Meta ad the lead came from (seen by Admins only).',
    example: '120249746455520716',
  },
];

/**
 * "Mobile No." / "mobile_no" / "MOBILE NO" -> "mobileno" — how headers and enum values are compared.
 * Letters of any script are kept, so a Hindi header isn't reduced to its English words.
 */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

// Money columns of a sheet / upload — read past, not saved (the CRM keeps no money).
const MONEY_HEADERS = new Set(
  ['Estimated Value', 'Estimated Value (₹)', 'Value', 'Order Value', 'Deal Value', 'Amount', 'Price', 'Rate', 'MRP', 'Cost', 'Budget'].map(squash),
);

const FIELD_BY_HEADER = new Map<string, ImportField>();
for (const column of IMPORT_COLUMNS) {
  for (const name of [column.header, ...(column.aliases ?? [])]) {
    FIELD_BY_HEADER.set(squash(name), column.field);
  }
}

export interface HeaderMapping {
  /** Sheet column number -> the lead field it fills. */
  fields: Map<number, ImportField>;
  /** Sheet column number -> header text, for every non-empty header cell. */
  headers: Map<number, string>;
  /** Headers that don't fill a field (unknown, or a repeat of an earlier column). */
  ignored: string[];
}

/**
 * Maps one row of cell texts (by column number) onto lead fields. Returns
 * null unless it has both required columns — i.e. it isn't the header row.
 */
export function mapHeaderRow(cells: Map<number, string>): HeaderMapping | null {
  const fields = new Map<number, ImportField>();
  const headers = new Map<number, string>();
  const ignored: string[] = [];
  const taken = new Set<ImportField>();

  for (const [col, text] of cells) {
    if (!text) continue;
    if (MONEY_HEADERS.has(squash(text))) continue; // no money is kept — not even as an extra detail
    headers.set(col, text);
    const field = FIELD_BY_HEADER.get(squash(text));
    if (field && !taken.has(field)) {
      fields.set(col, field);
      taken.add(field);
    } else {
      ignored.push(text);
    }
  }

  const required = IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.field);
  return required.every((f) => taken.has(f)) ? { fields, headers, ignored } : null;
}

// --- Cell values -----------------------------------------------------------

/** A cell reduced to what a person typed or sees: text, number, boolean, date or nothing. */
export type CellInput = string | number | boolean | Date | null;

export function cellInput(value: CellValue): CellInput {
  if (value == null) return null;
  if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim() || null;
  if ('richText' in value) return value.richText.map((r) => r.text).join('').trim() || null;
  if ('hyperlink' in value) return cellInput(value.text as CellValue);
  if ('formula' in value || 'sharedFormula' in value) return cellInput((value.result ?? null) as CellValue);
  return null; // error values such as #N/A
}

export function cellText(value: CellInput): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/** JSON-safe copy of a row for Lead.rawPayload. */
export function toRawValue(value: CellInput): string | number | boolean | null {
  return value instanceof Date ? value.toISOString() : value;
}

// --- Field parsers -----------------------------------------------------------
// Each returns undefined for a value it can't use; the caller records that
// as a warning and imports the lead without it.

const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parsePhone(value: CellInput): string | undefined {
  // Excel stores long numbers as floats, e.g. 919876543210.
  // Meta's lead exports (and its Google Sheets sync) write numbers as "p:+919812345678".
  const text = typeof value === 'number' ? String(Math.round(value)) : cellText(value).replace(/^\s*p:/i, '');
  const compact = text.replace(/[\s\-().]/g, '');
  return PHONE_PATTERN.test(compact) ? compact : undefined;
}

// Commas are the documented separator; ; / | and line breaks are accepted too.
const PHONE_LIST_SEPARATOR = /[,;/|\n]+/;
// A number cell longer than this can't be one phone number: it's usually
// "98765 43210,91234 56789" that Excel read as a single number (commas as
// thousands separators), with digits already lost to rounding.
const MAX_PHONE_NUMBER_CELL = 999_999_999_999_999;

export interface ParsedPhones {
  /** Valid numbers in the order written, repeats dropped — the first is the main number. */
  phones: string[];
  /** Parts that aren't a valid number, as written. */
  invalid: string[];
  /** The cell is a number too long to be a phone number (see MAX_PHONE_NUMBER_CELL). */
  mangled: boolean;
}

/** A "Mobile No." cell holding one number or several, comma-separated. */
export function parsePhones(value: CellInput): ParsedPhones {
  if (typeof value === 'number' && Math.abs(value) > MAX_PHONE_NUMBER_CELL) {
    return { phones: [], invalid: [], mangled: true };
  }
  const parts = typeof value === 'number' ? [value] : cellText(value).split(PHONE_LIST_SEPARATOR);
  const phones: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const text = cellText(part);
    if (!text) continue;
    const phone = parsePhone(part);
    if (!phone) invalid.push(text);
    else if (!phones.includes(phone)) phones.push(phone);
  }
  return { phones, invalid, mangled: false };
}

export function parseEmail(value: CellInput): string | undefined {
  const text = cellText(value).toLowerCase();
  return EMAIL_PATTERN.test(text) ? text : undefined;
}

/** Wall-clock Indian time -> the real instant. */
function istInstant(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date | undefined {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS);
  // Rejects 31/02 and friends, which Date.UTC would silently roll over.
  const check = new Date(date.getTime() + IST_OFFSET_MS);
  return check.getUTCDate() === day && check.getUTCMonth() === month - 1 ? date : undefined;
}

const DAY_FIRST_DATE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[ T,]+(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i;
const ISO_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Dates as they show up in sheets: real date cells, Excel serial numbers,
 * day-first text (27/09/2026, 27-09-26 4:30 pm), or ISO text. Anything
 * without a timezone is read as Indian time.
 */
export function parseDate(value: CellInput): Date | undefined {
  if (value instanceof Date) {
    // exceljs reads a date cell's wall-clock value as if it were UTC.
    return Number.isNaN(value.getTime()) ? undefined : new Date(value.getTime() - IST_OFFSET_MS);
  }
  if (typeof value === 'number') {
    // Excel serial day numbers (1 = 1900-01-01); 20000–80000 covers 1954–2119.
    if (value < 20000 || value > 80000) return undefined;
    return new Date(Math.round((value - 25569) * 86400000) - IST_OFFSET_MS);
  }

  const text = cellText(value);
  if (!text) return undefined;

  const dayFirst = DAY_FIRST_DATE.exec(text);
  if (dayFirst) {
    const [, d, m, y, h, min, s, ampm] = dayFirst;
    let hour = h ? Number(h) : 0;
    if (ampm) {
      if (hour < 1 || hour > 12) return undefined;
      hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
    }
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return istInstant(year, Number(m), Number(d), hour, min ? Number(min) : 0, s ? Number(s) : 0);
  }

  const isoLocal = ISO_LOCAL_DATE.exec(text);
  if (isoLocal) {
    const [, y, m, d, h, min, s] = isoLocal;
    return istInstant(Number(y), Number(m), Number(d), h ? Number(h) : 0, min ? Number(min) : 0, s ? Number(s) : 0);
  }

  // ISO with an explicit offset, e.g. a Lead Sheet export's 2026-09-27T09:15:00.000Z.
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

const AMOUNT_UNITS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
};
const AMOUNT_PATTERN = /^(\d+(?:\.\d+)?)([a-z]*)$/;

function parseAmountPart(text: string): { amount: number; hasUnit: boolean } | undefined {
  const match = AMOUNT_PATTERN.exec(text);
  if (!match) return undefined;
  const [, number, unit] = match;
  if (unit && !(unit in AMOUNT_UNITS)) return undefined;
  return { amount: Number(number) * (unit ? AMOUNT_UNITS[unit] : 1), hasUnit: !!unit };
}

function normalizeAmountText(value: CellInput): string {
  return cellText(value)
    .toLowerCase()
    .replace(/₹|\brs\.?|\binr\b|,|\s/g, '');
}

/** Rupee amounts: 5000000, "50,00,000", "₹ 50 L", "1.2 Cr". */
export function parseAmount(value: CellInput): number | undefined {
  if (typeof value === 'number') return value >= 0 ? value : undefined;
  const part = parseAmountPart(normalizeAmountText(value));
  return part ? Math.round(part.amount) : undefined;
}


// --- Rows pasted in Meta's own export order --------------------------------

// Meta's lead export: id, created_time, ad_id, ad_name, adset_id, adset_name,
// campaign_id, campaign_name, form_id, form_name, is_organic, platform, then
// the form's questions, then its contact fields (full_name, phone_number, email, city…).
const META_LEAD_ID = /^l:\d+$/;
const META_FIXED_COLUMNS = 12;
const META_PHONE = /^p:/i;

/**
 * A row pasted in Meta's export order under a sheet header in another order —
 * e.g. "l:1770…, 2026-10-17T18:12:34+05:30, ag:…, …, Vipin Patidar, p:+9191…"
 * under "Date, <questions>, full_name, phone_number, …". Returns the row's
 * cells moved under the right headers: name, phone, email, city, the form's
 * answers, created_time (under the Date column) and the ad id (under Ad ID,
 * when the header has one). The other ad, campaign and form details are left
 * out. Null when the row isn't one (cells are by column number, as the sheet shows them).
 */
export function realignMetaOrderRow(cells: CellInput[], mapping: HeaderMapping): Map<number, CellInput> | null {
  const text = (col: number) => cellText(cells[col] ?? null);
  if (!META_LEAD_ID.test(text(1))) return null;

  const colOf = (field: ImportField) => [...mapping.fields].find(([, f]) => f === field)?.[0];
  const phoneCol = colOf('phone');
  // Already lined up with the header (a real Meta export header) — read as usual.
  if (phoneCol !== undefined && META_PHONE.test(text(phoneCol))) return null;

  let phoneAt = -1;
  for (let col = META_FIXED_COLUMNS + 1; col < cells.length; col++) {
    if (META_PHONE.test(text(col))) {
      phoneAt = col;
      break;
    }
  }
  const nameCol = colOf('name');
  if (phoneAt < 0 || phoneCol === undefined || nameCol === undefined) return null;

  const aligned = new Map<number, CellInput>();
  const put = (field: ImportField, value: CellInput | undefined) => {
    const col = colOf(field);
    if (col !== undefined && value !== undefined && value !== null && cellText(value) !== '') aligned.set(col, value);
  };
  put('name', cells[phoneAt - 1]);
  put('phone', cells[phoneAt]);
  put('enquiredAt', cells[2]);
  put('adId', cells[3]); // Meta's ad id ("ag:…") — the only ad detail kept

  let next = phoneAt + 1;
  if (text(next).includes('@')) put('email', cells[next++]);
  const city = text(next);
  if (city && /\p{L}/u.test(city) && !city.includes('://') && city.length <= 60) put('city', cells[next]);

  // The form's answers sit between platform and full_name, in the order the
  // header lists its question columns (the header columns before the name
  // column, other than the date). Matched only when the counts agree.
  const answers = cells.slice(META_FIXED_COLUMNS + 1, phoneAt - 1);
  const questionCols = [...mapping.headers.keys()]
    .filter((col) => col < nameCol && mapping.fields.get(col) !== 'enquiredAt')
    .sort((a, b) => a - b);
  if (answers.length === questionCols.length) {
    questionCols.forEach((col, i) => {
      const value = answers[i];
      if (value !== undefined && value !== null && cellText(value) !== '') aligned.set(col, value);
    });
  }
  return aligned;
}

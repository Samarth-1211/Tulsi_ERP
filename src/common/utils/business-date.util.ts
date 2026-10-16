/**
 * The business's operating timezone (India). Attendance/leave/activity
 * "calendar day" boundaries must follow this, not the server's OS timezone.
 * Fixed offset — India does not observe DST — safe to hardcode.
 */
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
const BUSINESS_TZ_OFFSET_MINUTES = 330; // UTC+5:30

function datePartsInBusinessTz(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Returns a Date anchored at UTC midnight of the calendar day `input` falls
 * on in BUSINESS_TIMEZONE — the only safe value to write to/query against a
 * `@db.Date` column (Attendance.date, LeaveRequest.startDate/endDate).
 *
 * Postgres DATE columns carry no timezone, and Prisma's convention is to
 * always represent them as UTC-midnight-of-that-calendar-day. Naively doing
 * `new Date(); d.setHours(0, 0, 0, 0)` resets to *local* midnight instead,
 * which for any timezone ahead of UTC (IST is +5:30) is itself UTC-midnight
 * of the day *before* — silently storing/querying "yesterday" for
 * everything. This bit attendance check-in/checkout, the nightly absentee
 * cron, and leave date ranges. Use this instead of `setHours` for any
 * `@db.Date` column.
 */
export function businessDateOnly(input: Date | string = new Date()): Date {
  const date = typeof input === 'string' ? new Date(input) : input;
  const { year, month, day } = datePartsInBusinessTz(date);
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

/** First day of the month `input` falls in, in BUSINESS_TIMEZONE (as a `@db.Date`-safe value). */
export function businessStartOfMonth(input: Date = new Date()): Date {
  const { year, month } = datePartsInBusinessTz(input);
  return new Date(`${year}-${month}-01T00:00:00.000Z`);
}

/** Inclusive list of calendar-day Dates from `start` to `end` (both already `@db.Date`-safe values from businessDateOnly). */
export function businessDaysBetween(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * The real instant of local midnight (00:00:00 IST) at the start of the
 * calendar day `input` falls on in BUSINESS_TIMEZONE — for filtering a real
 * `DateTime` timestamp column (e.g. EmployeeActivity.occurredAt) by "which
 * business day did this happen on". Distinct from `businessDateOnly`, which
 * produces a `@db.Date`-shaped value, not a real instant.
 */
export function businessDayStartInstant(input: Date | string = new Date()): Date {
  return new Date(businessDateOnly(input).getTime() - BUSINESS_TZ_OFFSET_MINUTES * 60_000);
}

/** The last instant (23:59:59.999 IST) of the calendar day `input` falls on in BUSINESS_TIMEZONE. */
export function businessDayEndInstant(input: Date | string = new Date()): Date {
  return new Date(businessDayStartInstant(input).getTime() + 24 * 60 * 60 * 1000 - 1);
}

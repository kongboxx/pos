/**
 * Business date.
 *
 * PROJECT RULE #4: `businessDate` is NOT `createdAt`.
 *
 * The shop closes after midnight. A bill rung up at 00:20 belongs to the
 * previous day's takings, otherwise every closing report is wrong and the
 * staff will "fix" it by hand forever. Each branch sets its own cutoff hour
 * (dayCutoffHour, default 4 = 04:00 local time).
 *
 * The value is a calendar day string `YYYY-MM-DD` in the branch timezone.
 * It is never derived from the server's local clock.
 */

export const DEFAULT_TIMEZONE = 'Asia/Bangkok';
export const DEFAULT_DAY_CUTOFF_HOUR = 4;

export interface BusinessDateConfig {
  /** IANA timezone of the branch, e.g. "Asia/Bangkok". */
  timezone?: string;
  /** Local hour (0-23) at which a new business day starts. */
  dayCutoffHour?: number;
}

/** A calendar day in the branch timezone, formatted `YYYY-MM-DD`. */
export type BusinessDate = string;

/**
 * Converts an instant into the business date it belongs to.
 *
 * Example (cutoff 4, Asia/Bangkok):
 *   2026-07-29T17:20:00Z -> local 2026-07-30 00:20 -> businessDate 2026-07-29
 *   2026-07-29T22:00:00Z -> local 2026-07-30 05:00 -> businessDate 2026-07-30
 */
export function toBusinessDate(instant: Date, config: BusinessDateConfig = {}): BusinessDate {
  const timezone = config.timezone ?? DEFAULT_TIMEZONE;
  const cutoffHour = config.dayCutoffHour ?? DEFAULT_DAY_CUTOFF_HOUR;
  assertCutoffHour(cutoffHour);

  const local = getLocalParts(instant, timezone);
  // Before the cutoff we still belong to yesterday's trading day.
  const shifted = local.hour < cutoffHour ? addDays(local, -1) : local;
  return formatParts(shifted);
}

/**
 * Inclusive UTC range of instants that map to a given business date.
 * Use this to build `WHERE createdAt BETWEEN ...` queries; the stored
 * `businessDate` column stays the source of truth for reporting.
 */
export function businessDateRange(
  businessDate: BusinessDate,
  config: BusinessDateConfig = {},
): { startUtc: Date; endUtc: Date } {
  const timezone = config.timezone ?? DEFAULT_TIMEZONE;
  const cutoffHour = config.dayCutoffHour ?? DEFAULT_DAY_CUTOFF_HOUR;
  assertCutoffHour(cutoffHour);
  assertBusinessDate(businessDate);

  const startUtc = zonedTimeToUtc(businessDate, cutoffHour, timezone);
  const nextDay = formatParts(addDays(parseBusinessDate(businessDate), 1));
  const endUtc = zonedTimeToUtc(nextDay, cutoffHour, timezone);
  return { startUtc, endUtc };
}

/** `YYYY-MM` bucket used by Payroll / MonthlyClose. */
export function toYearMonth(businessDate: BusinessDate): string {
  assertBusinessDate(businessDate);
  return businessDate.slice(0, 7);
}

export function assertBusinessDate(value: string): asserts value is BusinessDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`businessDate must be YYYY-MM-DD, got "${value}"`);
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
}

/** Reads the wall-clock time in `timezone` for an instant, without any library. */
function getLocalParts(instant: Date, timezone: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Intl did not return "${type}" for timezone ${timezone}`);
    return Number(found.value);
  };
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') };
}

function addDays(parts: DateParts, days: number): DateParts {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: parts.hour,
  };
}

function formatParts(parts: DateParts): BusinessDate {
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  return `${parts.year}-${mm}-${dd}`;
}

function parseBusinessDate(value: BusinessDate): DateParts {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return { year, month, day, hour: 0 };
}

/**
 * Finds the UTC instant for a wall-clock time in a timezone.
 *
 * We guess with a UTC timestamp, measure how far the guess lands from the
 * target in that zone, then correct. Two passes settle DST boundaries; Bangkok
 * has no DST, but branches abroad or a timezone change should not break this.
 */
function zonedTimeToUtc(date: BusinessDate, hour: number, timezone: string): Date {
  const { year, month, day } = parseBusinessDate(date);
  let guess = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const local = getLocalParts(new Date(guess), timezone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, 0, 0, 0);
    const target = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
    const drift = target - localAsUtc;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

function assertCutoffHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`dayCutoffHour must be an integer 0..23, got ${hour}`);
  }
}

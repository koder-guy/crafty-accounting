// UK tax years run from 6 April to 5 April the following year. Labels use the
// MTD API format "YYYY-YY" (e.g. "2025-26"); the UI shows them as "2025/26".

export interface TaxYearDates {
  label: string;
  startDate: string;
  endDate: string;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad2 = (n: number) => String(n).padStart(2, '0');

export function taxYearLabel(startYear: number): string {
  return `${startYear}-${pad2((startYear + 1) % 100)}`;
}

export function displayTaxYear(label: string): string {
  return label.replace('-', '/');
}

export function taxYearFromStartYear(startYear: number): TaxYearDates {
  return {
    label: taxYearLabel(startYear),
    startDate: `${startYear}-04-06`,
    endDate: `${startYear + 1}-04-05`,
  };
}

export function startYearFromLabel(label: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return null;
  const startYear = Number(match[1]);
  return taxYearLabel(startYear) === label ? startYear : null;
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The start year of the tax year containing an ISO date. */
export function taxYearStartYearForDate(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return m > 4 || (m === 4 && d >= 6) ? y : y - 1;
}

export function isDateInTaxYear(isoDate: string, year: Pick<TaxYearDates, 'startDate' | 'endDate'>): boolean {
  return isValidIsoDate(isoDate) && isoDate >= year.startDate && isoDate <= year.endDate;
}

/**
 * Index (0-11) of the tax month containing the date, where tax month 0 runs
 * 6 April – 5 May. Returns -1 if the date is outside the given tax year.
 */
export function taxMonthIndex(isoDate: string, startYear: number): number {
  if (taxYearStartYearForDate(isoDate) !== startYear) return -1;
  const [, m, d] = isoDate.split('-').map(Number);
  const month = d >= 6 ? m : m - 1 || 12;
  return (month - 4 + 12) % 12;
}

export interface TaxMonth {
  index: number;
  label: string;
  /** The month it starts in, in full: "April" runs 6 April to 5 May. */
  name: string;
  range: string;
  /** The 6th of the month. */
  startDate: string;
  /** The 5th of the next month. */
  endDate: string;
}

export function taxMonths(startYear: number): TaxMonth[] {
  return Array.from({ length: 12 }, (_, index) => {
    const monthIdx = (3 + index) % 12;
    const year = index < 9 ? startYear : startYear + 1;
    const nextIdx = (monthIdx + 1) % 12;
    const nextYear = nextIdx === 0 ? year + 1 : year;
    return {
      index,
      label: `${MONTHS[monthIdx]} ${pad2(year % 100)}`,
      name: MONTH_NAMES[monthIdx],
      range: `6 ${MONTHS[monthIdx]} ${year} – 5 ${MONTHS[nextIdx]} ${nextYear}`,
      startDate: `${year}-${pad2(monthIdx + 1)}-06`,
      endDate: `${nextYear}-${pad2(nextIdx + 1)}-05`,
    };
  });
}

/** Online Self Assessment filing and payment deadline for a tax year. */
export function selfAssessmentDeadline(startYear: number): string {
  return `${startYear + 2}-01-31`;
}

/**
 * The last day to amend a tax year after its final declaration through MTD:
 * 12 months after the filing deadline. (HMRC allows longer when the notice to
 * file came late; it says so if a change is refused.)
 */
export function mtdAmendmentDeadline(startYear: number): string {
  return `${startYear + 3}-01-31`;
}

/** The last day to amend a filed Self Assessment return online: the same 12 months after the filing deadline. */
export const selfAssessmentAmendmentDeadline = mtdAmendmentDeadline;

/** Today's date as an ISO string in local time. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86_400_000);
}

export function formatDisplayDate(isoDate: string): string {
  if (!isValidIsoDate(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** An ISO date as date fields show it: dd/mm/yyyy, or '' when there's no valid date. */
export function formatDateInput(isoDate: string): string {
  if (!isValidIsoDate(isoDate)) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/** Reads a typed date, always day first: 8/10/2026, 08-10-26, 08102026 or 2026-10-08. Null if it isn't a real date. */
export function parseDateInput(text: string): string | null {
  const typed = text.trim();
  if (isValidIsoDate(typed)) return typed;
  const parts = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4}|\d{2})$/.exec(typed) ?? /^(\d{2})(\d{2})(\d{4}|\d{2})$/.exec(typed);
  if (!parts) return null;
  const year = parts[3].length === 2 ? `20${parts[3]}` : parts[3];
  const iso = `${year}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The same day in another month, or that month's last day if it's shorter. */
export function addMonthsIso(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

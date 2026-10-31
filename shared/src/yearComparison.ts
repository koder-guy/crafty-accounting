// Comparing two tax years: the Reports → Compare years tab. A year still in
// progress is compared with the same stretch of the other year, because seven
// months against a whole year always looks like a collapse.

import { isValidIsoDate, taxYearStartYearForDate } from './taxYear';
import type { BreakdownGroup, BreakdownSection } from './types';

/** The same day and month in another tax year. 29 February becomes the 28th when that year has none. */
export function sameDateInTaxYear(isoDate: string, targetStartYear: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const year = y + targetStartYear - taxYearStartYearForDate(isoDate);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${year}-${pad(m)}-${pad(d)}`;
  return isValidIsoDate(date) ? date : `${year}-${pad(m)}-${pad(d - 1)}`;
}

/**
 * Where a "same period" comparison stops: the last date recorded in the later
 * year, not today, so books a few weeks behind don't look like a drop in sales.
 * Never after today, and always inside the year.
 */
export function comparisonCutoff(year: { startDate: string; endDate: string }, recordedTo: string | null, today: string): string {
  const last = recordedTo && recordedTo < today ? recordedTo : today;
  return last < year.startDate ? year.startDate : last > year.endDate ? year.endDate : last;
}

/** The change as a fraction of the earlier figure, or null when that isn't meaningful (nothing or a loss to compare with). */
export function percentChange(currentPence: number, previousPence: number): number | null {
  return previousPence > 0 ? (currentPence - previousPence) / previousPence : null;
}

/** Profit as a fraction of income, or null with no income. */
export function profitMargin(incomePence: number, profitPence: number): number | null {
  return incomePence > 0 ? profitPence / incomePence : null;
}

export interface ComparisonLine {
  key: string;
  name: string;
  note?: string;
  /** The Breakdown selection for this row, for its `show` parameter. */
  show: string;
  /** Amounts for the chosen year, then the year it's compared with. */
  totalsPence: [number, number];
  disallowablePence: [number, number];
}

export interface ComparisonRow extends ComparisonLine {
  /** Custom categories and flat-rate claims within this category, in either year. */
  children: ComparisonLine[];
}

/**
 * Lines up two years' breakdowns by HMRC category, including categories used in
 * only one of them, largest in the chosen year first.
 */
export function compareSections(a: BreakdownSection, b: BreakdownSection): ComparisonRow[] {
  const codes = [...new Set([...a.groups, ...b.groups].map((g) => g.hmrcCode))];
  const rows = codes.map((code): ComparisonRow => {
    const pair = [a, b].map((s) => s.groups.find((g) => g.hmrcCode === code));
    const groups = pair.filter((g): g is BreakdownGroup => g !== undefined);
    const standard = groups[0].standard;

    const line = (key: string, name: string, show: string, pick: (g: BreakdownGroup) => { total: number; disallowable: number } | undefined, note?: string): ComparisonLine => {
      const [first, second] = pair.map((g) => (g ? pick(g) : undefined));
      return {
        key,
        name,
        note,
        show,
        totalsPence: [first?.total ?? 0, second?.total ?? 0],
        disallowablePence: [first?.disallowable ?? 0, second?.disallowable ?? 0],
      };
    };

    const customs = new Map(groups.flatMap((g) => g.custom).map((c) => [c.categoryId, c.name]));
    const flatRates = new Map(groups.flatMap((g) => g.flatRates).map((f) => [f.kind, f.name]));
    const children: ComparisonLine[] = [
      ...[...customs].map(([id, name]) =>
        line(`cat${id}`, name, `cat:${id}`, (g) => {
          const c = g.custom.find((x) => x.categoryId === id);
          return c && { total: c.totalPence, disallowable: c.disallowablePence };
        }),
      ),
      ...[...flatRates].map(([kind, name]) =>
        line(kind, name, `flat:${kind}`, (g) => {
          const f = g.flatRates.find((x) => x.kind === kind);
          return f && { total: f.totalPence, disallowable: 0 };
        }),
      ),
    ];
    if (children.length > 0 && groups.some((g) => g.standard.count > 0)) {
      children.push(
        line(
          `cat${standard.categoryId}`,
          standard.name,
          `cat:${standard.categoryId}`,
          (g) => ({ total: g.standard.totalPence, disallowable: g.standard.disallowablePence }),
          customs.size > 0 ? 'not in a custom category' : 'recorded in Outgoing',
        ),
      );
    }

    return {
      ...line(`group${standard.categoryId}`, standard.name, `group:${standard.categoryId}`, (g) => ({
        total: g.totalPence,
        disallowable: g.disallowablePence,
      })),
      children,
    };
  });
  return rows.sort((x, y) => y.totalsPence[0] - x.totalsPence[0] || y.totalsPence[1] - x.totalsPence[1]);
}

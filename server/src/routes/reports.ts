import { Router } from 'express';
import { z } from 'zod';
import {
  breakdownItemsSchema,
  buildMtdPeriodSummary,
  buildSelfAssessmentSummary,
  comparisonCutoff,
  reportRangeSchema,
  estimateTax,
  sameDateInTaxYear,
  selfAssessmentDeadline,
  startYearFromLabel,
  taxMonthIndex,
  taxMonths,
  taxPaymentDates,
  todayIso,
  yearComparisonSchema,
  type ComparisonPeriod,
  type TaxEstimateResponse,
  type TaxYear,
  type BreakdownCategory,
  type BreakdownFlatRate,
  type BreakdownGroup,
  type BreakdownItem,
  type BreakdownResponse,
  type BreakdownSection,
  type Category,
  type CategoryType,
  type FlatRateKind,
  type YearComparisonResponse,
  type YearComparisonYear,
  type YearEndSummaryResponse,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import {
  getCategory,
  getTaxYear,
  listCategories,
  mileageCategoryId,
  mileageCheck,
  mileageClaimLines,
  useOfHomeCategoryId,
  useOfHomeClaimLines,
  yearEntries,
  type Db,
} from '../repo';

interface Entry {
  categoryId: number;
  amountPence: number;
  disallowable: boolean;
  /** Set for mileage and use of home claims, which get their own row in their group. */
  flatRate?: FlatRateKind;
}

const FLAT_RATE_NAMES: Record<FlatRateKind, string> = {
  mileage: 'Mileage at HMRC rates',
  home: 'Use of home at HMRC flat rate',
};

/**
 * Totals by category for one side (income or expenses). Custom categories are
 * grouped under the standard MTD category they map to; empty ones are left out.
 */
function buildSection(categories: Category[], type: CategoryType, entries: Entry[]): BreakdownSection {
  const totals = new Map<number, BreakdownCategory>();
  for (const c of categories.filter((c) => c.type === type)) {
    totals.set(c.id, { categoryId: c.id, name: c.name, isCustom: c.isCustom, totalPence: 0, disallowablePence: 0, count: 0 });
  }
  const flatRates = new Map<string, BreakdownFlatRate>();
  for (const e of entries) {
    if (e.flatRate) {
      const key = `${e.categoryId}:${e.flatRate}`;
      const f = flatRates.get(key) ?? { kind: e.flatRate, name: FLAT_RATE_NAMES[e.flatRate], totalPence: 0, count: 0 };
      f.totalPence += e.amountPence;
      f.count += 1;
      flatRates.set(key, f);
      continue;
    }
    const t = totals.get(e.categoryId);
    if (!t) continue;
    t.totalPence += e.amountPence;
    if (e.disallowable) t.disallowablePence += e.amountPence;
    t.count += 1;
  }

  const groups: BreakdownGroup[] = categories
    .filter((c) => c.type === type && !c.isCustom)
    .map((std) => {
      const custom = categories
        .filter((c) => c.type === type && c.isCustom && c.hmrcCode === std.hmrcCode)
        .map((c) => totals.get(c.id)!)
        .filter((c) => c.count > 0);
      const standard = totals.get(std.id)!;
      const flat = (['mileage', 'home'] as const).flatMap((kind) => flatRates.get(`${std.id}:${kind}`) ?? []);
      const all = [standard, ...custom, ...flat];
      return {
        hmrcCode: std.hmrcCode,
        standard,
        custom,
        flatRates: flat,
        totalPence: all.reduce((acc, c) => acc + c.totalPence, 0),
        disallowablePence: [standard, ...custom].reduce((acc, c) => acc + c.disallowablePence, 0),
        count: all.reduce((acc, c) => acc + c.count, 0),
      };
    })
    .filter((g) => g.count > 0)
    .sort((a, b) => b.totalPence - a.totalPence);

  return {
    totalPence: groups.reduce((acc, g) => acc + g.totalPence, 0),
    disallowablePence: groups.reduce((acc, g) => acc + g.disallowablePence, 0),
    groups,
  };
}

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

/**
 * Income Tax and Class 4 estimate for a tax year, from the same profit as the
 * Year-end summary (using the trading allowance instead if that's lower).
 */
export function buildTaxEstimate(db: Db, taxYear: TaxYear): TaxEstimateResponse {
  const { incomes, lines } = yearEntries(db, taxYear.id);
  const summary = buildSelfAssessmentSummary(buildMtdPeriodSummary(incomes, lines));
  const usesTradingAllowance = summary.tradingAllowance.better === 'allowance';
  const profitPence = usesTradingAllowance ? summary.tradingAllowance.profitWithAllowancePence : summary.netProfitPence;
  return {
    taxYear,
    estimate: estimateTax({ label: taxYear.label, profitPence, otherIncomePence: taxYear.otherIncomePence }),
    usesTradingAllowance,
    profitWithExpensesPence: summary.netProfitPence,
    netLossPence: summary.netLossPence,
    dueDates: taxPaymentDates(startYearFromLabel(taxYear.label)!),
    recordedTo: lastRecordedDate(db, taxYear.id),
  };
}

/** The last date in a tax year with any transaction or trip. */
function lastRecordedDate(db: Db, taxYearId: number): string | null {
  const row = db
    .prepare(
      `SELECT MAX(date) AS last FROM (
         SELECT date FROM incomes WHERE tax_year_id = @id UNION ALL
         SELECT date FROM expenses WHERE tax_year_id = @id UNION ALL
         SELECT date FROM mileage_trips WHERE tax_year_id = @id)`,
    )
    .get({ id: taxYearId }) as { last: string | null };
  return row.last;
}

/** Income and expenses by category for a date range, with mileage and use of home claims. */
function breakdownSections(db: Db, from: string, to: string): Pick<BreakdownResponse, 'income' | 'expenses'> {
  const incomes = db
    .prepare('SELECT category_id AS categoryId, amount_pence AS amountPence FROM incomes WHERE date BETWEEN ? AND ?')
    .all(from, to) as { categoryId: number; amountPence: number }[];
  const lines = db
    .prepare(
      `SELECT li.category_id AS categoryId, li.amount_pence AS amountPence, li.disallowable
       FROM expense_line_items li JOIN expenses e ON e.id = li.expense_id WHERE e.date BETWEEN ? AND ?`,
    )
    .all(from, to) as { categoryId: number; amountPence: number; disallowable: number }[];
  const inRange = (c: { date: string }) => c.date >= from && c.date <= to;
  const claims: Entry[] = [
    ...mileageClaimLines(db)
      .filter(inRange)
      .map((c) => ({ ...c, flatRate: 'mileage' as const })),
    ...useOfHomeClaimLines(db)
      .filter(inRange)
      .map((c) => ({ ...c, flatRate: 'home' as const })),
  ];
  const categories = listCategories(db);
  return {
    income: buildSection(categories, 'INCOME', incomes.map((i) => ({ ...i, disallowable: false }))),
    expenses: buildSection(categories, 'EXPENSE', [...lines.map((l) => ({ ...l, disallowable: l.disallowable === 1 })), ...claims]),
  };
}

/** One year's side of a comparison, from its first day up to `to`. */
function comparisonYear(db: Db, taxYear: TaxYear, to: string, period: ComparisonPeriod): YearComparisonYear {
  const startYear = startYearFromLabel(taxYear.label)!;
  const entries = yearEntries(db, taxYear.id);
  const incomes = entries.incomes.filter((i) => i.date <= to);
  const lines = entries.lines.filter((l) => l.date <= to);
  const { totals } = buildMtdPeriodSummary(incomes, lines);

  const monthly = taxMonths(startYear)
    .slice(0, taxMonthIndex(to, startYear) + 1)
    .map((m) => ({ ...m, incomePence: 0, expensesPence: 0, profitPence: 0 }));
  for (const income of incomes) monthly[taxMonthIndex(income.date, startYear)].incomePence += income.amountPence;
  for (const line of lines) {
    if (!line.disallowable) monthly[taxMonthIndex(line.date, startYear)].expensesPence += line.amountPence;
  }
  for (const month of monthly) month.profitPence = month.incomePence - month.expensesPence;

  return {
    taxYear,
    from: taxYear.startDate,
    to,
    totals: {
      incomePence: totals.incomePence,
      allowableExpensesPence: totals.allowableExpensesPence,
      disallowablePence: totals.disallowablePence,
      profitPence: totals.netProfitPence,
    },
    monthly,
    ...breakdownSections(db, taxYear.startDate, to),
    tax: period === 'full' ? buildTaxEstimate(db, taxYear) : null,
  };
}

export function reportsRouter(ctx: AppContext): Router {
  const router = Router();

  /** Figures for the Self Assessment self-employment (short) pages. */
  router.get('/tax-estimate', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const taxYear = getTaxYear(ctx.db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    res.json(buildTaxEstimate(ctx.db, taxYear));
  });

  router.get('/year-end', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const db = ctx.db;
    const taxYear = getTaxYear(db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');

    const { incomes, lines } = yearEntries(db, taxYearId);

    const response: YearEndSummaryResponse = {
      taxYear,
      mileageCheck: mileageCheck(db, taxYearId),
      filingDeadline: selfAssessmentDeadline(startYearFromLabel(taxYear.label)!),
      summary: buildSelfAssessmentSummary(buildMtdPeriodSummary(incomes, lines)),
    };
    res.json(response);
  });

  /** Income and expenses by category (and outgoing by payee) for any date range. */
  router.get('/breakdown', (req, res) => {
    const { from, to } = parseWith(reportRangeSchema, req.query);
    const db = ctx.db;
    const payees = db
      .prepare(
        `SELECT MIN(payee) AS payee, SUM(total_pence) AS totalPence, COUNT(*) AS count
         FROM expenses WHERE date BETWEEN ? AND ? GROUP BY payee COLLATE NOCASE ORDER BY totalPence DESC`,
      )
      .all(from, to) as BreakdownResponse['payees'];

    const response: BreakdownResponse = { from, to, ...breakdownSections(db, from, to), payees };
    res.json(response);
  });

  /** Two tax years side by side: the same stretch of each, or both in full. */
  router.get('/year-comparison', (req, res) => {
    const { taxYearId, compareToId, period } = parseWith(yearComparisonSchema, req.query);
    const db = ctx.db;
    const taxYear = getTaxYear(db, taxYearId);
    const compareTo = getTaxYear(db, compareToId);
    if (!taxYear || !compareTo) throw new HttpError(404, 'Tax year not found');

    const later = taxYear.startDate > compareTo.startDate ? taxYear : compareTo;
    const cutoff = comparisonCutoff(later, lastRecordedDate(db, later.id), todayIso());
    const toFor = (year: TaxYear) => (period === 'full' ? year.endDate : sameDateInTaxYear(cutoff, startYearFromLabel(year.label)!));
    const response: YearComparisonResponse = {
      period,
      years: [comparisonYear(db, taxYear, toFor(taxYear), period), comparisonYear(db, compareTo, toFor(compareTo), period)],
    };
    res.json(response);
  });

  /** The transactions or line items behind one row of the breakdown. */
  router.get('/breakdown/items', (req, res) => {
    const q = parseWith(breakdownItemsSchema, req.query);
    const db = ctx.db;
    const items: BreakdownItem[] = [];

    if (q.flatRate) {
      items.push(...flatRateItems(db, q.flatRate, q.from, q.to));
    } else if (q.payee) {
      const rows = db
        .prepare(
          `SELECT e.id, e.date, e.payee, li.description, li.amount_pence, li.disallowable, c.name AS category_name
           FROM expense_line_items li
           JOIN expenses e ON e.id = li.expense_id
           JOIN categories c ON c.id = li.category_id
           WHERE e.date BETWEEN ? AND ? AND e.payee = ? COLLATE NOCASE
           ORDER BY e.date, e.id, li.sort_order, li.id`,
        )
        .all(q.from, q.to, q.payee) as Record<string, any>[];
      for (const r of rows) items.push(lineItem(r));
    } else {
      const category = getCategory(db, q.categoryId!);
      if (!category) throw new HttpError(404, 'Category not found');
      // A group covers the standard category plus every custom one mapped to it.
      const ids =
        q.group === '1'
          ? listCategories(db)
              .filter((c) => c.type === category.type && c.hmrcCode === category.hmrcCode)
              .map((c) => c.id)
          : [category.id];
      const idList = JSON.stringify(ids);
      if (category.type === 'INCOME') {
        const rows = db
          .prepare(
            `SELECT i.id, i.date, i.description, i.amount_pence, c.name AS category_name
             FROM incomes i JOIN categories c ON c.id = i.category_id
             WHERE i.date BETWEEN ? AND ? AND i.category_id IN (SELECT value FROM json_each(?))
             ORDER BY i.date, i.id`,
          )
          .all(q.from, q.to, idList) as Record<string, any>[];
        for (const r of rows) {
          items.push({
            kind: 'income',
            transactionId: r.id,
            date: r.date,
            payee: null,
            description: r.description,
            categoryName: r.category_name,
            amountPence: r.amount_pence,
            disallowable: false,
          });
        }
      } else {
        const rows = db
          .prepare(
            `SELECT e.id, e.date, e.payee, li.description, li.amount_pence, li.disallowable, c.name AS category_name
             FROM expense_line_items li
             JOIN expenses e ON e.id = li.expense_id
             JOIN categories c ON c.id = li.category_id
             WHERE e.date BETWEEN ? AND ? AND li.category_id IN (SELECT value FROM json_each(?))
             ORDER BY e.date, e.id, li.sort_order, li.id`,
          )
          .all(q.from, q.to, idList) as Record<string, any>[];
        for (const r of rows) items.push(lineItem(r));
        // The whole group includes the flat-rate claims that count towards it.
        if (q.group === '1') {
          if (ids.includes(mileageCategoryId(db))) items.push(...flatRateItems(db, 'mileage', q.from, q.to));
          if (ids.includes(useOfHomeCategoryId(db))) items.push(...flatRateItems(db, 'home', q.from, q.to));
        }
        items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
    }
    res.json(items);
  });

  return router;
}

/** Mileage trips or use of home months in a date range, as drill-down rows. */
function flatRateItems(db: Db, kind: FlatRateKind, from: string, to: string): BreakdownItem[] {
  const claims =
    kind === 'mileage'
      ? mileageClaimLines(db).map((m) => ({ id: m.tripId, date: m.date, description: m.description, amountPence: m.amountPence }))
      : useOfHomeClaimLines(db).map((h) => ({ id: h.taxYearId, date: h.date, description: h.description, amountPence: h.amountPence }));
  return claims
    .filter((c) => c.date >= from && c.date <= to)
    .map((c) => ({
      kind,
      transactionId: c.id,
      date: c.date,
      payee: null,
      description: c.description,
      categoryName: FLAT_RATE_NAMES[kind],
      amountPence: c.amountPence,
      disallowable: false,
    }));
}

const lineItem = (r: Record<string, any>): BreakdownItem => ({
  kind: 'expense',
  transactionId: r.id,
  date: r.date,
  payee: r.payee,
  description: r.description,
  categoryName: r.category_name,
  amountPence: r.amount_pence,
  disallowable: r.disallowable === 1,
});

import { Router } from 'express';
import { z } from 'zod';
import {
  breakdownItemsSchema,
  buildMtdPeriodSummary,
  buildSelfAssessmentSummary,
  reportRangeSchema,
  estimateTax,
  selfAssessmentDeadline,
  startYearFromLabel,
  taxPaymentDates,
  type TaxEstimateResponse,
  type TaxYear,
  type BreakdownCategory,
  type BreakdownGroup,
  type BreakdownItem,
  type BreakdownResponse,
  type BreakdownSection,
  type Category,
  type CategoryType,
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
}

/**
 * Totals by category for one side (income or expenses). Custom categories are
 * grouped under the standard MTD category they map to; empty ones are left out.
 */
function buildSection(categories: Category[], type: CategoryType, entries: Entry[]): BreakdownSection {
  const totals = new Map<number, BreakdownCategory>();
  for (const c of categories.filter((c) => c.type === type)) {
    totals.set(c.id, { categoryId: c.id, name: c.name, isCustom: c.isCustom, totalPence: 0, disallowablePence: 0, count: 0 });
  }
  for (const e of entries) {
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
      const all = [standard, ...custom];
      return {
        hmrcCode: std.hmrcCode,
        standard,
        custom,
        totalPence: all.reduce((acc, c) => acc + c.totalPence, 0),
        disallowablePence: all.reduce((acc, c) => acc + c.disallowablePence, 0),
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
  const recordedTo = db
    .prepare(
      `SELECT MAX(date) AS last FROM (
         SELECT date FROM incomes WHERE tax_year_id = @id UNION ALL
         SELECT date FROM expenses WHERE tax_year_id = @id UNION ALL
         SELECT date FROM mileage_trips WHERE tax_year_id = @id)`,
    )
    .get({ id: taxYear.id }) as { last: string | null };
  return {
    taxYear,
    estimate: estimateTax({ label: taxYear.label, profitPence, otherIncomePence: taxYear.otherIncomePence }),
    usesTradingAllowance,
    profitWithExpensesPence: summary.netProfitPence,
    netLossPence: summary.netLossPence,
    dueDates: taxPaymentDates(startYearFromLabel(taxYear.label)!),
    recordedTo: recordedTo.last,
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
    const claims = [...mileageClaimLines(db).filter(inRange), ...useOfHomeClaimLines(db).filter(inRange)];
    const payees = db
      .prepare(
        `SELECT MIN(payee) AS payee, SUM(total_pence) AS totalPence, COUNT(*) AS count
         FROM expenses WHERE date BETWEEN ? AND ? GROUP BY payee COLLATE NOCASE ORDER BY totalPence DESC`,
      )
      .all(from, to) as BreakdownResponse['payees'];

    const categories = listCategories(db);
    const response: BreakdownResponse = {
      from,
      to,
      income: buildSection(categories, 'INCOME', incomes.map((i) => ({ ...i, disallowable: false }))),
      expenses: buildSection(categories, 'EXPENSE', [...lines.map((l) => ({ ...l, disallowable: l.disallowable === 1 })), ...claims]),
      payees,
    };
    res.json(response);
  });

  /** The transactions or line items behind one row of the breakdown. */
  router.get('/breakdown/items', (req, res) => {
    const q = parseWith(breakdownItemsSchema, req.query);
    const db = ctx.db;
    const items: BreakdownItem[] = [];

    if (q.payee) {
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
        // Mileage claims count under the standard car, van and travel category.
        const mileageCategory = mileageCategoryId(db);
        if (ids.includes(mileageCategory)) {
          for (const m of mileageClaimLines(db).filter((m) => m.date >= q.from && m.date <= q.to)) {
            items.push({
              kind: 'mileage',
              transactionId: m.tripId,
              date: m.date,
              payee: null,
              description: m.description,
              categoryName: 'Mileage at HMRC rates',
              amountPence: m.amountPence,
              disallowable: false,
            });
          }
        }
        // Use of home claims count under the standard rent, rates, power and insurance category.
        if (ids.includes(useOfHomeCategoryId(db))) {
          for (const h of useOfHomeClaimLines(db).filter((h) => h.date >= q.from && h.date <= q.to)) {
            items.push({
              kind: 'home',
              transactionId: h.taxYearId,
              date: h.date,
              payee: null,
              description: h.description,
              categoryName: 'Use of home at HMRC flat rate',
              amountPence: h.amountPence,
              disallowable: false,
            });
          }
        }
        items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
    }
    res.json(items);
  });

  return router;
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

import { Router } from 'express';
import { z } from 'zod';
import {
  breakdownItemsSchema,
  buildMtdPeriodSummary,
  buildSelfAssessmentSummary,
  reportRangeSchema,
  selfAssessmentDeadline,
  startYearFromLabel,
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
import { getCategory, getTaxYear, listCategories } from '../repo';

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

export function reportsRouter(ctx: AppContext): Router {
  const router = Router();

  /** Figures for the Self Assessment self-employment (short) pages. */
  router.get('/year-end', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const db = ctx.db;
    const taxYear = getTaxYear(db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');

    const incomes = db
      .prepare(
        `SELECT i.amount_pence AS amountPence, c.hmrc_code AS hmrcCode
         FROM incomes i JOIN categories c ON c.id = i.category_id WHERE i.tax_year_id = ?`,
      )
      .all(taxYearId) as { amountPence: number; hmrcCode: string }[];
    const lines = (
      db
        .prepare(
          `SELECT li.amount_pence AS amountPence, li.disallowable, c.hmrc_code AS hmrcCode
           FROM expense_line_items li
           JOIN expenses e ON e.id = li.expense_id
           JOIN categories c ON c.id = li.category_id
           WHERE e.tax_year_id = ?`,
        )
        .all(taxYearId) as { amountPence: number; disallowable: number; hmrcCode: string }[]
    ).map((line) => ({ ...line, disallowable: line.disallowable === 1 }));

    const response: YearEndSummaryResponse = {
      taxYear,
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
      expenses: buildSection(categories, 'EXPENSE', lines.map((l) => ({ ...l, disallowable: l.disallowable === 1 }))),
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

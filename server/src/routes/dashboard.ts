import { Router } from 'express';
import { z } from 'zod';
import {
  buildMtdPeriodSummary,
  startYearFromLabel,
  taxMonthIndex,
  taxMonths,
  type CategoryTotal,
  type DashboardData,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { getTaxYear, listCategories, listExpenses, listIncomes } from '../repo';

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

export function dashboardRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const db = ctx.db;
    const taxYear = getTaxYear(db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    const startYear = startYearFromLabel(taxYear.label)!;

    const incomes = db
      .prepare(
        `SELECT i.date, i.amount_pence AS amountPence, i.payment_method AS paymentMethod, i.category_id AS categoryId,
                c.hmrc_code AS hmrcCode
         FROM incomes i JOIN categories c ON c.id = i.category_id WHERE i.tax_year_id = ?`,
      )
      .all(taxYearId) as { date: string; amountPence: number; paymentMethod: string; categoryId: number; hmrcCode: string }[];

    const lines = (
      db
        .prepare(
          `SELECT e.date, li.amount_pence AS amountPence, li.disallowable, li.category_id AS categoryId,
                  c.hmrc_code AS hmrcCode
           FROM expense_line_items li
           JOIN expenses e ON e.id = li.expense_id
           JOIN categories c ON c.id = li.category_id
           WHERE e.tax_year_id = ?`,
        )
        .all(taxYearId) as { date: string; amountPence: number; disallowable: number; categoryId: number; hmrcCode: string }[]
    ).map((line) => ({ ...line, disallowable: line.disallowable === 1 }));

    const mtd = buildMtdPeriodSummary(incomes, lines);

    const monthly = taxMonths(startYear).map((m) => ({ ...m, incomePence: 0, expensesPence: 0 }));
    for (const income of incomes) {
      const index = taxMonthIndex(income.date, startYear);
      if (index >= 0) monthly[index].incomePence += income.amountPence;
    }
    // Allowable spending only, to match the Total outgoing box.
    for (const line of lines) {
      if (line.disallowable) continue;
      const index = taxMonthIndex(line.date, startYear);
      if (index >= 0) monthly[index].expensesPence += line.amountPence;
    }

    const sumBy = (method: string) =>
      incomes.filter((i) => i.paymentMethod === method).reduce((acc, i) => acc + i.amountPence, 0);

    const categories = listCategories(db);
    const breakdown = (entries: { categoryId: number; amountPence: number; disallowable?: boolean }[], type: 'INCOME' | 'EXPENSE') =>
      categories
        .filter((c) => c.type === type)
        .map((c): CategoryTotal => {
          const matching = entries.filter((e) => e.categoryId === c.id);
          return {
            categoryId: c.id,
            name: c.name,
            hmrcCode: c.hmrcCode,
            totalPence: matching.reduce((acc, e) => acc + e.amountPence, 0),
            disallowablePence: matching.filter((e) => e.disallowable).reduce((acc, e) => acc + e.amountPence, 0),
          };
        })
        .filter((c) => c.totalPence > 0)
        .sort((a, b) => b.totalPence - a.totalPence);

    const data: DashboardData = {
      taxYear,
      totals: {
        incomePence: mtd.totals.incomePence,
        cardIncomePence: sumBy('card'),
        cashIncomePence: sumBy('cash'),
        bankIncomePence: sumBy('bank_transfer'),
        expensesPence: mtd.totals.expensesPence,
        disallowablePence: mtd.totals.disallowablePence,
        allowableExpensesPence: mtd.totals.allowableExpensesPence,
        netProfitPence: mtd.totals.netProfitPence,
      },
      monthly,
      incomeByCategory: breakdown(incomes, 'INCOME'),
      expensesByCategory: breakdown(lines, 'EXPENSE'),
      recentIncomes: listIncomes(db, { taxYearId }, 5),
      recentExpenses: listExpenses(db, { taxYearId }, 5),
      mtd,
    };
    res.json(data);
  });

  return router;
}

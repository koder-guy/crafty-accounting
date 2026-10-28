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
import { getTaxYear, listCategories, listExpenses, listIncomes, mileageClaimLines, useOfHomeClaimLines, yearEntries } from '../repo';
import { buildTaxEstimate } from './reports';

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

export function dashboardRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const db = ctx.db;
    const taxYear = getTaxYear(db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    const startYear = startYearFromLabel(taxYear.label)!;

    const { incomes, lines } = yearEntries(db, taxYearId);

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
      recentIncomes: listIncomes(db, { taxYearId }, 4),
      recentExpenses: listExpenses(db, { taxYearId }, 4),
      mtd,
      mileagePence: mileageClaimLines(db, [taxYearId]).reduce((acc, c) => acc + c.amountPence, 0),
      useOfHomePence: useOfHomeClaimLines(db, [taxYearId]).reduce((acc, c) => acc + c.amountPence, 0),
      taxEstimate: buildTaxEstimate(db, taxYear).estimate,
    };
    res.json(data);
  });

  return router;
}

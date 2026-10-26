import { Router } from 'express';
import { z } from 'zod';
import {
  buildMtdPeriodSummary,
  buildSelfAssessmentSummary,
  selfAssessmentDeadline,
  startYearFromLabel,
  type YearEndSummaryResponse,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { getTaxYear } from '../repo';

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

  return router;
}

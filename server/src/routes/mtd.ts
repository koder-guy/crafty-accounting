// MTD quarterly summaries for a tax year, plus a record of which quarters
// have been submitted to HMRC (entered by hand until direct submission exists).
import { Router } from 'express';
import { z } from 'zod';
import {
  buildMtdPeriodSummary,
  mtdQuarters,
  mtdSubmissionSchema,
  startYearFromLabel,
  type MtdQuarterSubmission,
  type MtdQuartersResponse,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseId, parseWith } from '../http';
import { getTaxYear } from '../repo';

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

function parseQuarter(value: string | string[] | undefined): number {
  const quarter = Number(value);
  if (![1, 2, 3, 4].includes(quarter)) throw new HttpError(404, 'Quarter not found');
  return quarter;
}

export function mtdRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/quarters', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const db = ctx.db;
    const taxYear = getTaxYear(db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');

    const incomes = db
      .prepare(
        `SELECT i.date, i.amount_pence AS amountPence, c.hmrc_code AS hmrcCode
         FROM incomes i JOIN categories c ON c.id = i.category_id WHERE i.tax_year_id = ?`,
      )
      .all(taxYearId) as { date: string; amountPence: number; hmrcCode: string }[];
    const lines = (
      db
        .prepare(
          `SELECT e.date, li.amount_pence AS amountPence, li.disallowable, c.hmrc_code AS hmrcCode
           FROM expense_line_items li
           JOIN expenses e ON e.id = li.expense_id
           JOIN categories c ON c.id = li.category_id
           WHERE e.tax_year_id = ?`,
        )
        .all(taxYearId) as { date: string; amountPence: number; disallowable: number; hmrcCode: string }[]
    ).map((line) => ({ ...line, disallowable: line.disallowable === 1 }));

    const submissions = new Map(
      (
        db.prepare('SELECT quarter, submitted_on, reference FROM mtd_submissions WHERE tax_year_id = ?').all(taxYearId) as {
          quarter: number;
          submitted_on: string;
          reference: string | null;
        }[]
      ).map((row): [number, MtdQuarterSubmission] => [row.quarter, { submittedOn: row.submitted_on, reference: row.reference }]),
    );

    const inRange = (from: string, to: string) => (entry: { date: string }) => entry.date >= from && entry.date <= to;
    const response: MtdQuartersResponse = {
      taxYear,
      quarters: mtdQuarters(startYearFromLabel(taxYear.label)!).map((q) => ({
        ...q,
        period: buildMtdPeriodSummary(incomes.filter(inRange(q.startDate, q.endDate)), lines.filter(inRange(q.startDate, q.endDate))),
        cumulative: buildMtdPeriodSummary(
          incomes.filter(inRange(taxYear.startDate, q.endDate)),
          lines.filter(inRange(taxYear.startDate, q.endDate)),
        ),
        submission: submissions.get(q.quarter) ?? null,
      })),
    };
    res.json(response);
  });

  router.put('/quarters/:taxYearId/:quarter/submission', (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    if (!getTaxYear(ctx.db, taxYearId)) throw new HttpError(404, 'Tax year not found');
    const input = parseWith(mtdSubmissionSchema, req.body);
    ctx.db
      .prepare(
        `INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on, reference) VALUES (?, ?, ?, ?)
         ON CONFLICT (tax_year_id, quarter) DO UPDATE SET submitted_on = excluded.submitted_on, reference = excluded.reference`,
      )
      .run(taxYearId, quarter, input.submittedOn, input.reference);
    res.json({ submittedOn: input.submittedOn, reference: input.reference });
  });

  router.delete('/quarters/:taxYearId/:quarter/submission', (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    ctx.db.prepare('DELETE FROM mtd_submissions WHERE tax_year_id = ? AND quarter = ?').run(taxYearId, quarter);
    res.status(204).end();
  });

  return router;
}

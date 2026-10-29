// MTD quarterly summaries for a tax year, plus a record of which quarters
// have been submitted to HMRC: entered by hand, or sent by the app (see
// routes/hmrc.ts), in which case the record can't be changed by hand.
import { Router } from 'express';
import { z } from 'zod';
import {
  buildMtdPeriodSummary,
  mtdQuarters,
  mtdSubmissionSchema,
  startYearFromLabel,
  type HmrcEnvironment,
  type MtdQuarterSubmission,
  type MtdQuartersResponse,
  type MtdQuarterSummary,
  type TaxYear,
} from '@crafty/shared';
import type { AppContext } from '../context';
import type { Db } from '../db';
import { HttpError, parseId, parseWith } from '../http';
import { getTaxYear, yearEntries } from '../repo';

interface SubmissionRow {
  quarter: number;
  submitted_on: string;
  reference: string | null;
  sent_by: string | null;
  sent_at: string | null;
  sent_environment: HmrcEnvironment | null;
  correlation_id: string | null;
  sent_payload: string | null;
}

export function getSubmissions(db: Db, taxYearId: number): Map<number, MtdQuarterSubmission> {
  const rows = db.prepare('SELECT * FROM mtd_submissions WHERE tax_year_id = ?').all(taxYearId) as SubmissionRow[];
  return new Map(
    rows.map((row): [number, MtdQuarterSubmission] => [
      row.quarter,
      {
        submittedOn: row.submitted_on,
        reference: row.reference,
        sent:
          row.sent_at && row.sent_by && row.sent_environment && row.sent_payload
            ? {
                by: row.sent_by,
                at: row.sent_at,
                environment: row.sent_environment,
                correlationId: row.correlation_id,
                payload: JSON.parse(row.sent_payload),
              }
            : null,
      },
    ]),
  );
}

/** Each quarter's figures, on its own and for the tax year to date, with any submission. */
export function quarterSummaries(db: Db, taxYear: TaxYear): MtdQuarterSummary[] {
  const { incomes, lines } = yearEntries(db, taxYear.id);
  const submissions = getSubmissions(db, taxYear.id);
  const inRange = (from: string, to: string) => (entry: { date: string }) => entry.date >= from && entry.date <= to;
  return mtdQuarters(startYearFromLabel(taxYear.label)!).map((q) => ({
    ...q,
    period: buildMtdPeriodSummary(incomes.filter(inRange(q.startDate, q.endDate)), lines.filter(inRange(q.startDate, q.endDate))),
    cumulative: buildMtdPeriodSummary(incomes.filter(inRange(taxYear.startDate, q.endDate)), lines.filter(inRange(taxYear.startDate, q.endDate))),
    submission: submissions.get(q.quarter) ?? null,
  }));
}

/** A record of an update the app sent to HMRC is a fact, so it can't be changed or removed by hand. */
function refuseIfSent(db: Db, taxYearId: number, quarter: number) {
  const row = db.prepare('SELECT sent_at FROM mtd_submissions WHERE tax_year_id = ? AND quarter = ?').get(taxYearId, quarter) as
    | { sent_at: string | null }
    | undefined;
  if (row?.sent_at) throw new HttpError(409, 'This quarter was sent to HMRC by the app, so its record can’t be changed by hand.');
}

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

export function parseQuarter(value: string | string[] | undefined): number {
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

    const response: MtdQuartersResponse = { taxYear, quarters: quarterSummaries(db, taxYear) };
    res.json(response);
  });

  router.put('/quarters/:taxYearId/:quarter/submission', (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    if (!getTaxYear(ctx.db, taxYearId)) throw new HttpError(404, 'Tax year not found');
    refuseIfSent(ctx.db, taxYearId, quarter);
    const input = parseWith(mtdSubmissionSchema, req.body);
    ctx.db
      .prepare(
        `INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on, reference) VALUES (?, ?, ?, ?)
         ON CONFLICT (tax_year_id, quarter) DO UPDATE SET submitted_on = excluded.submitted_on, reference = excluded.reference`,
      )
      .run(taxYearId, quarter, input.submittedOn, input.reference);
    res.json(getSubmissions(ctx.db, taxYearId).get(quarter));
  });

  router.delete('/quarters/:taxYearId/:quarter/submission', (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    refuseIfSent(ctx.db, taxYearId, quarter);
    ctx.db.prepare('DELETE FROM mtd_submissions WHERE tax_year_id = ? AND quarter = ?').run(taxYearId, quarter);
    res.status(204).end();
  });

  return router;
}

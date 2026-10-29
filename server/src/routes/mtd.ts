// MTD quarterly summaries for a tax year, plus a record of which quarters
// have been submitted to HMRC: entered by hand, or sent by the app (see
// routes/hmrc.ts), in which case the record can't be changed by hand.
import { Router } from 'express';
import { z } from 'zod';
import {
  buildMtdPeriodSummary,
  displayTaxYear,
  formatDisplayDate,
  mtdEarliestSendDate,
  mtdQuarters,
  mtdSubmissionSchema,
  startYearFromLabel,
  type HmrcEnvironment,
  type MtdFinalDeclaration,
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

type QuarterSubmission = Pick<MtdQuarterSummary, 'submission' | 'otherServiceSend'>;

/**
 * Each quarter's submission. An update the app sent to the other HMRC service
 * (the sandbox, once the app uses the live one) doesn't count as submitted:
 * it's reported separately, as a note.
 */
export function getSubmissions(
  db: Db,
  taxYearId: number,
  environment: HmrcEnvironment,
): Map<number, QuarterSubmission> {
  const rows = db.prepare('SELECT * FROM mtd_submissions WHERE tax_year_id = ?').all(taxYearId) as SubmissionRow[];
  return new Map(
    rows.map((row): [number, QuarterSubmission] => {
      const sent =
        row.sent_at && row.sent_by && row.sent_environment && row.sent_payload
          ? {
              by: row.sent_by,
              at: row.sent_at,
              environment: row.sent_environment,
              correlationId: row.correlation_id,
              payload: JSON.parse(row.sent_payload),
            }
          : null;
      if (sent && sent.environment !== environment) {
        return [row.quarter, { submission: null, otherServiceSend: { environment: sent.environment, at: sent.at, by: sent.by } }];
      }
      return [row.quarter, { submission: { submittedOn: row.submitted_on, reference: row.reference, sent }, otherServiceSend: null }];
    }),
  );
}

/** A year's quarterly updates that count with this HMRC service: recorded by hand, and sent by the app. */
export function mtdUpdateCounts(db: Db, taxYearId: number, environment: HmrcEnvironment): { recorded: number; sent: number } {
  const submissions = [...getSubmissions(db, taxYearId, environment).values()].map((s) => s.submission).filter((s) => s !== null);
  return { recorded: submissions.filter((s) => !s.sent).length, sent: submissions.filter((s) => s.sent).length };
}

interface FinalDeclarationRow {
  calculation_id: string;
  total_due_pence: number;
  declared_by: string;
  declared_at: string;
  environment: HmrcEnvironment;
  correlation_id: string | null;
}

const toDeclaration = (row: FinalDeclarationRow): MtdFinalDeclaration => ({
  calculationId: row.calculation_id,
  totalDuePence: row.total_due_pence,
  by: row.declared_by,
  at: row.declared_at,
  environment: row.environment,
  correlationId: row.correlation_id,
});

/** The year's final declaration to this HMRC service, if the app has made it. */
export function getFinalDeclaration(db: Db, taxYearId: number, environment: HmrcEnvironment): MtdFinalDeclaration | null {
  const row = db
    .prepare('SELECT * FROM mtd_final_declarations WHERE tax_year_id = ? AND environment = ?')
    .get(taxYearId, environment) as FinalDeclarationRow | undefined;
  return row ? toDeclaration(row) : null;
}

/** Amendments the app confirmed to this HMRC service after the final declaration, oldest first. */
export function getAmendments(db: Db, taxYearId: number, environment: HmrcEnvironment): MtdFinalDeclaration[] {
  const rows = db
    .prepare(
      `SELECT calculation_id, total_due_pence, amended_by AS declared_by, amended_at AS declared_at, environment, correlation_id
       FROM mtd_amendments WHERE tax_year_id = ? AND environment = ? ORDER BY id`,
    )
    .all(taxYearId, environment) as FinalDeclarationRow[];
  return rows.map(toDeclaration);
}

/** Quarterly updates belong to MTD years; a Self Assessment year has to be switched first. */
export function refuseUnlessMtd(taxYear: TaxYear): void {
  if (taxYear.submissionMethod !== 'mtd') {
    throw new HttpError(
      409,
      `${displayTaxYear(taxYear.label)} is set to a Self Assessment return. Switch it to Making Tax Digital in Settings → Tax years first.`,
    );
  }
}

/** Each quarter's figures, on its own and for the tax year to date, with any submission. */
export function quarterSummaries(db: Db, taxYear: TaxYear, environment: HmrcEnvironment): MtdQuarterSummary[] {
  const { incomes, lines } = yearEntries(db, taxYear.id);
  const submissions = getSubmissions(db, taxYear.id, environment);
  const inRange = (from: string, to: string) => (entry: { date: string }) => entry.date >= from && entry.date <= to;
  return mtdQuarters(startYearFromLabel(taxYear.label)!).map((q) => ({
    ...q,
    period: buildMtdPeriodSummary(incomes.filter(inRange(q.startDate, q.endDate)), lines.filter(inRange(q.startDate, q.endDate))),
    cumulative: buildMtdPeriodSummary(incomes.filter(inRange(taxYear.startDate, q.endDate)), lines.filter(inRange(taxYear.startDate, q.endDate))),
    submission: submissions.get(q.quarter)?.submission ?? null,
    otherServiceSend: submissions.get(q.quarter)?.otherServiceSend ?? null,
  }));
}

/** A record of an update the app sent to HMRC is a fact, so it can't be changed or removed by hand. */
function refuseIfSent(db: Db, taxYearId: number, quarter: number, environment: HmrcEnvironment) {
  const row = db.prepare('SELECT sent_environment FROM mtd_submissions WHERE tax_year_id = ? AND quarter = ?').get(taxYearId, quarter) as
    | { sent_environment: string | null }
    | undefined;
  if (row?.sent_environment === environment) {
    throw new HttpError(409, 'This quarter was sent to HMRC by the app, so its record can’t be changed by hand.');
  }
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

    const environment = ctx.config.hmrc.environment;
    const response: MtdQuartersResponse = {
      taxYear,
      quarters: quarterSummaries(db, taxYear, environment),
      finalDeclaration: getFinalDeclaration(db, taxYearId, environment),
      amendments: getAmendments(db, taxYearId, environment),
    };
    res.json(response);
  });

  router.put('/quarters/:taxYearId/:quarter/submission', (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    const taxYear = getTaxYear(ctx.db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    refuseIfSent(ctx.db, taxYearId, quarter, ctx.config.hmrc.environment);
    refuseUnlessMtd(taxYear);
    const input = parseWith(mtdSubmissionSchema, req.body);
    const earliest = mtdEarliestSendDate(mtdQuarters(startYearFromLabel(taxYear.label)!)[quarter - 1]);
    if (input.submittedOn < earliest) {
      throw new HttpError(400, `HMRC doesn’t take this update until ${formatDisplayDate(earliest)}, 10 days before the quarter ends.`);
    }
    ctx.db
      .prepare(
        `INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on, reference) VALUES (?, ?, ?, ?)
         ON CONFLICT (tax_year_id, quarter) DO UPDATE SET submitted_on = excluded.submitted_on, reference = excluded.reference,
           sent_by = NULL, sent_at = NULL, sent_environment = NULL, correlation_id = NULL, sent_payload = NULL`,
      )
      .run(taxYearId, quarter, input.submittedOn, input.reference);
    res.json(getSubmissions(ctx.db, taxYearId, ctx.config.hmrc.environment).get(quarter)!.submission);
  });

  router.delete('/quarters/:taxYearId/:quarter/submission', (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    refuseIfSent(ctx.db, taxYearId, quarter, ctx.config.hmrc.environment);
    ctx.db.prepare('DELETE FROM mtd_submissions WHERE tax_year_id = ? AND quarter = ?').run(taxYearId, quarter);
    res.status(204).end();
  });

  return router;
}

import { Router, type Request } from 'express';
import { createTaxYearSchema, setActiveTaxYearSchema, taxSettingsSchema, taxYearFromStartYear, type TaxYearsResponse } from '@crafty/shared';
import type { AppContext } from '../context';
import { setSetting } from '../db';
import { removeDocumentFile } from '../documents';
import { HttpError, parseId, parseWith } from '../http';
import { getTaxYear, listTaxYears, resolveActiveTaxYearId } from '../repo';
import { getUser } from '../users';

export function taxYearsRouter(ctx: AppContext): Router {
  const router = Router();

  // Each person has their own active tax year.
  const activeId = (req: Request) => resolveActiveTaxYearId(ctx.db, getUser(ctx.db, req.user!.id)?.activeTaxYearId ?? null);
  const setActive = (req: Request, taxYearId: number) =>
    ctx.db.prepare('UPDATE users SET active_tax_year_id = ? WHERE id = ?').run(taxYearId, req.user!.id);

  const respond = (req: Request): TaxYearsResponse => ({
    taxYears: listTaxYears(ctx.db),
    activeTaxYearId: activeId(req),
  });

  router.get('/', (req, res) => {
    res.json(respond(req));
  });

  router.post('/', (req, res) => {
    const { startYear } = parseWith(createTaxYearSchema, req.body);
    const year = taxYearFromStartYear(startYear);
    const db = ctx.db;
    if (db.prepare('SELECT 1 FROM tax_years WHERE label = ?').get(year.label)) {
      throw new HttpError(409, `Tax year ${year.label.replace('-', '/')} already exists`);
    }
    // Keep the year you were viewing (or switch to the new one if it's the first).
    const before = activeId(req);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO tax_years (label, start_date, end_date) VALUES (?, ?, ?)')
      .run(year.label, year.startDate, year.endDate);
    setActive(req, before ?? Number(lastInsertRowid));
    res.status(201).json({ ...respond(req), createdId: Number(lastInsertRowid) });
  });

  router.put('/active', (req, res) => {
    const { taxYearId } = parseWith(setActiveTaxYearSchema, req.body);
    if (!getTaxYear(ctx.db, taxYearId)) throw new HttpError(404, 'Tax year not found');
    setActive(req, taxYearId);
    res.json(respond(req));
  });

  /** Settings the tax estimate uses, such as other taxable income for the year. */
  router.put('/:id/tax-settings', (req, res) => {
    const id = parseId(req.params.id);
    if (!getTaxYear(ctx.db, id)) throw new HttpError(404, 'Tax year not found');
    const { otherIncomePence } = parseWith(taxSettingsSchema, req.body);
    ctx.db.prepare('UPDATE tax_years SET other_income_pence = ? WHERE id = ?').run(otherIncomePence, id);
    res.json(respond(req));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const db = ctx.db;
    const year = getTaxYear(db, id);
    if (!year) throw new HttpError(404, 'Tax year not found');

    const documents = (
      db
        .prepare(
          `SELECT d.filename AS name FROM documents d
           LEFT JOIN incomes i ON i.id = d.income_id
           LEFT JOIN expenses e ON e.id = d.expense_id
           WHERE COALESCE(i.tax_year_id, e.tax_year_id) = ?`,
        )
        .all(id) as { name: string }[]
    ).map((row) => row.name);

    // Transactions and line items go via ON DELETE CASCADE.
    db.prepare('DELETE FROM tax_years WHERE id = ?').run(id);
    if (listTaxYears(db).length === 0) setSetting(db, 'sample_data_loaded', null);
    for (const name of documents) removeDocumentFile(ctx, name);

    res.json({
      ...respond(req),
      deleted: { incomes: year.incomeCount, expenses: year.expenseCount, documents: documents.length },
    });
  });

  return router;
}

import { Router } from 'express';
import { createTaxYearSchema, setActiveTaxYearSchema, taxYearFromStartYear, type TaxYearsResponse } from '@crafty/shared';
import type { AppContext } from '../context';
import { setSetting } from '../db';
import { removeDocumentFile } from '../documents';
import { HttpError, parseId, parseWith } from '../http';
import { getTaxYear, listTaxYears, resolveActiveTaxYearId } from '../repo';

export function taxYearsRouter(ctx: AppContext): Router {
  const router = Router();

  const respond = (): TaxYearsResponse => ({
    taxYears: listTaxYears(ctx.db),
    activeTaxYearId: resolveActiveTaxYearId(ctx.db),
  });

  router.get('/', (_req, res) => {
    res.json(respond());
  });

  router.post('/', (req, res) => {
    const { startYear } = parseWith(createTaxYearSchema, req.body);
    const year = taxYearFromStartYear(startYear);
    const db = ctx.db;
    if (db.prepare('SELECT 1 FROM tax_years WHERE label = ?').get(year.label)) {
      throw new HttpError(409, `Tax year ${year.label.replace('-', '/')} already exists`);
    }
    const hadActive = resolveActiveTaxYearId(db) !== null;
    const { lastInsertRowid } = db
      .prepare('INSERT INTO tax_years (label, start_date, end_date) VALUES (?, ?, ?)')
      .run(year.label, year.startDate, year.endDate);
    if (!hadActive) setSetting(db, 'active_tax_year_id', String(lastInsertRowid));
    res.status(201).json({ ...respond(), createdId: Number(lastInsertRowid) });
  });

  router.put('/active', (req, res) => {
    const { taxYearId } = parseWith(setActiveTaxYearSchema, req.body);
    if (!getTaxYear(ctx.db, taxYearId)) throw new HttpError(404, 'Tax year not found');
    setSetting(ctx.db, 'active_tax_year_id', String(taxYearId));
    res.json(respond());
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const db = ctx.db;
    const year = getTaxYear(db, id);
    if (!year) throw new HttpError(404, 'Tax year not found');

    const documents = (
      db
        .prepare(
          `SELECT document_filename AS name FROM incomes WHERE tax_year_id = ? AND document_filename IS NOT NULL
           UNION ALL
           SELECT document_filename FROM expenses WHERE tax_year_id = ? AND document_filename IS NOT NULL`,
        )
        .all(id, id) as { name: string }[]
    ).map((row) => row.name);

    // Transactions and line items go via ON DELETE CASCADE.
    db.prepare('DELETE FROM tax_years WHERE id = ?').run(id);
    if (listTaxYears(db).length === 0) setSetting(db, 'sample_data_loaded', null);
    for (const name of documents) removeDocumentFile(ctx, name);

    res.json({
      ...respond(),
      deleted: { incomes: year.incomeCount, expenses: year.expenseCount, documents: documents.length },
    });
  });

  return router;
}

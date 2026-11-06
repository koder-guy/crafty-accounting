// Income and expense transaction routes.
import { Router } from 'express';
import {
  displayTaxYear,
  expenseInputSchema,
  formatDisplayDate,
  incomeInputSchema,
  isDateInTaxYear,
  MAX_DOCUMENTS,
  PAYMENT_METHOD_LABELS,
  penceToPounds,
  transactionFiltersSchema,
  type CategoryType,
  type TaxYear,
  type TransactionDocument,
} from '@crafty/shared';
import { z } from 'zod';
import type { AppContext } from '../context';
import { toCsv } from '../csv';
import { sendJsonExport } from '../jsonExport';
import { createUploader, removeDocumentFile, saveWithDocuments, uploadedFiles, type DocumentRename } from '../documents';
import { HttpError, parseId, parseWith, readPayload } from '../http';
import { syncScansNotification } from '../notifications';
import { getScanRow } from '../scans';
import { importTransactions } from '../transactionImport';
import {
  getCategory,
  getExpense,
  getIncome,
  getTaxYear,
  insertExpense,
  insertIncome,
  insertLineItem,
  lineItemParams,
  lineItemsTotal,
  listExpenses,
  listIncomes,
  NEXT_UPDATED_AT,
} from '../repo';

export function checkTaxYearAndDate(ctx: AppContext, taxYearId: number, date: string): TaxYear {
  const year = getTaxYear(ctx.db, taxYearId);
  if (!year) throw new HttpError(422, 'That tax year no longer exists');
  if (!isDateInTaxYear(date, year)) {
    throw new HttpError(
      422,
      `The date must fall within tax year ${displayTaxYear(year.label)} ` +
        `(${formatDisplayDate(year.startDate)} to ${formatDisplayDate(year.endDate)})`,
      [{ path: 'date', message: 'Date is outside the tax year' }],
    );
  }
  return year;
}

function checkCategory(ctx: AppContext, categoryId: number, type: CategoryType): void {
  const category = getCategory(ctx.db, categoryId);
  if (!category || category.type !== type) {
    throw new HttpError(422, `Choose a valid ${type === 'INCOME' ? 'income' : 'expense'} category`);
  }
}

/**
 * Refuses an edit made from an out-of-date copy, so one person can't silently
 * overwrite another's changes. Forms send the updatedAt they were loaded with.
 */
export function checkUnchanged(
  existing: { updatedAt: string; updatedBy: string | null },
  expectedUpdatedAt: string | undefined,
  noun = 'transaction',
): void {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === existing.updatedAt) return;
  const who = existing.updatedBy ?? 'someone else';
  throw new HttpError(409, `${who} changed this ${noun} while you were editing it, so your changes weren't saved. Load their version, then make yours again.`);
}

/**
 * Checks an edit's document changes: the documents to remove or rename must
 * belong to the transaction, none is both, and it can't end up with more than
 * MAX_DOCUMENTS. Returns the documents being removed and the renames that
 * change a name (their new names are checked when the files are placed).
 */
function documentChanges(
  existing: { documents: TransactionDocument[] },
  input: { removeDocumentIds?: number[]; renameDocuments?: { id: number; filename: string }[] },
  adding: number,
): { removing: TransactionDocument[]; renaming: (DocumentRename & { id: number })[] } {
  const owned = new Map(existing.documents.map((d) => [d.id, d]));
  const ownedDoc = (docId: number) => {
    const doc = owned.get(docId);
    if (!doc) throw new HttpError(422, 'A document does not belong to this transaction');
    return doc;
  };
  const removing = (input.removeDocumentIds ?? []).map(ownedDoc);
  const renamed = new Set<number>();
  const renaming = (input.renameDocuments ?? []).flatMap(({ id: docId, filename }) => {
    const doc = ownedDoc(docId);
    if (renamed.has(docId)) throw new HttpError(422, 'A document can only be renamed once in a save');
    renamed.add(docId);
    if (removing.includes(doc)) throw new HttpError(422, 'A document can\'t be renamed and removed in the same save');
    return filename === doc.filename ? [] : [{ id: docId, from: doc.filename, to: filename }];
  });
  if (existing.documents.length - removing.length + adding > MAX_DOCUMENTS) {
    throw new HttpError(422, `A transaction can have at most ${MAX_DOCUMENTS} documents`);
  }
  return { removing, renaming };
}

/** Records newly placed documents against a transaction, renames some, and drops removed ones. */
function storeDocuments(
  ctx: AppContext,
  owner: 'income_id' | 'expense_id',
  ownerId: number,
  added: string[],
  changes: { removing: TransactionDocument[]; renaming: { id: number; to: string }[] },
): void {
  const insert = ctx.db.prepare(`INSERT INTO documents (filename, ${owner}) VALUES (?, ?)`);
  for (const name of added) insert.run(name, ownerId);
  const rename = ctx.db.prepare('UPDATE documents SET filename = ? WHERE id = ?');
  for (const { id, to } of changes.renaming) rename.run(to, id);
  const remove = ctx.db.prepare('DELETE FROM documents WHERE id = ?');
  for (const doc of changes.removing) remove.run(doc.id);
}

const documentNames = (t: { documents: TransactionDocument[] }) => t.documents.map((d) => d.filename);

const exportFilename = (kind: string, year: TaxYear | null, ext: 'csv' | 'json') => `${kind}-${year?.label ?? 'export'}.${ext}`;

const deleteManySchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100_000) });

/**
 * Deletes the transactions the table shows (the ids it lists), in one database transaction, then their
 * documents' files. Ids already gone (deleted in another browser) are skipped.
 */
function deleteMany<T extends { documents: TransactionDocument[] }>(
  ctx: AppContext,
  table: 'incomes' | 'expenses',
  get: (id: number) => T | null,
  body: unknown,
): number {
  const ids = [...new Set(parseWith(deleteManySchema, body).ids)];
  const files: string[] = [];
  const del = ctx.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  let deleted = 0;
  ctx.db.transaction(() => {
    for (const id of ids) {
      const existing = get(id);
      if (!existing) continue;
      // Line items and document rows go via ON DELETE CASCADE.
      del.run(id);
      files.push(...documentNames(existing));
      deleted++;
    }
  })();
  for (const name of files) removeDocumentFile(ctx, name);
  return deleted;
}

export function incomesRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = createUploader(ctx);

  router.get('/', (req, res) => {
    res.json(listIncomes(ctx.db, parseWith(transactionFiltersSchema, req.query)));
  });

  router.get('/export.csv', (req, res) => {
    const filters = parseWith(transactionFiltersSchema, req.query);
    const rows = listIncomes(ctx.db, filters).map((i) => [
      i.date,
      i.description,
      i.source,
      i.reference,
      i.categoryName,
      i.hmrcCode,
      PAYMENT_METHOD_LABELS[i.paymentMethod],
      penceToPounds(i.amountPence),
      documentNames(i).join('; '),
      i.notes,
    ]);
    const csv = toCsv(
      ['Date', 'Description', 'Source', 'Reference', 'Category', 'HMRC code', 'Payment method', 'Amount (GBP)', 'Documents', 'Notes'],
      rows,
    );
    res.attachment(exportFilename('income', getTaxYear(ctx.db, filters.taxYearId), 'csv')).type('text/csv').send(csv);
  });

  router.get('/export.json', (req, res) => {
    const filters = parseWith(transactionFiltersSchema, req.query);
    const year = getTaxYear(ctx.db, filters.taxYearId);
    const incomes = listIncomes(ctx.db, filters).map((i) => ({
      id: i.id,
      date: i.date,
      description: i.description,
      source: i.source,
      reference: i.reference,
      category: i.categoryName,
      hmrcCode: i.hmrcCode,
      paymentMethod: i.paymentMethod,
      amountPence: i.amountPence,
      documents: documentNames(i),
      notes: i.notes,
      createdBy: i.createdBy,
      updatedBy: i.updatedBy,
    }));
    sendJsonExport(res, exportFilename('income', year, 'json'), { taxYear: year?.label ?? null, incomes });
  });

  // Imports a JSON export (see transactionImport.ts); preview first to see what it would do.
  router.post('/delete', (req, res) => {
    res.json({ deleted: deleteMany(ctx, 'incomes', (id) => getIncome(ctx.db, id), req.body) });
  });

  router.post('/import/preview', (req, res) => {
    res.json(importTransactions(ctx, req, 'incomes', false));
  });

  router.post('/import', (req, res) => {
    res.status(201).json(importTransactions(ctx, req, 'incomes', true));
  });

  router.get('/:id', (req, res) => {
    const income = getIncome(ctx.db, parseId(req.params.id));
    if (!income) throw new HttpError(404, 'Transaction not found');
    res.json(income);
  });

  router.post('/', upload.array('documents', MAX_DOCUMENTS), (req, res) => {
    const input = parseWith(incomeInputSchema, readPayload(req));
    checkTaxYearAndDate(ctx, input.taxYearId, input.date);
    checkCategory(ctx, input.categoryId, 'INCOME');
    const files = uploadedFiles(req.files);
    const id = saveWithDocuments(ctx, { files, removing: [] }, (filenames) =>
      ctx.db.transaction(() => {
        const incomeId = insertIncome(ctx.db, input, req.user!.name);
        storeDocuments(ctx, 'income_id', incomeId, filenames, { removing: [], renaming: [] });
        return incomeId;
      })(),
    );
    res.status(201).json(getIncome(ctx.db, id));
  });

  router.put('/:id', upload.array('documents', MAX_DOCUMENTS), (req, res) => {
    const id = parseId(req.params.id);
    const existing = getIncome(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Transaction not found');
    const input = parseWith(incomeInputSchema, readPayload(req));
    checkUnchanged(existing, input.expectedUpdatedAt);
    if (input.taxYearId !== existing.taxYearId) throw new HttpError(422, 'A transaction cannot be moved to another tax year');
    checkTaxYearAndDate(ctx, existing.taxYearId, input.date);
    checkCategory(ctx, input.categoryId, 'INCOME');
    const files = uploadedFiles(req.files);
    const changes = documentChanges(existing, input, files.length);
    saveWithDocuments(ctx, { files, removing: changes.removing.map((d) => d.filename), renaming: changes.renaming }, (filenames) =>
      ctx.db.transaction(() => {
        ctx.db
          .prepare(
            `UPDATE incomes SET date = ?, description = ?, source = ?, reference = ?, payment_method = ?,
               amount_pence = ?, category_id = ?, notes = ?, updated_by = ?,
               updated_at = ${NEXT_UPDATED_AT}
             WHERE id = ?`,
          )
          .run(
            input.date,
            input.description,
            input.source,
            input.reference,
            input.paymentMethod,
            input.amountPence,
            input.categoryId,
            input.notes,
            req.user!.name,
            id,
          );
        storeDocuments(ctx, 'income_id', id, filenames, changes);
      })(),
    );
    res.json(getIncome(ctx.db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const existing = getIncome(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Transaction not found');
    // Its documents' rows go via ON DELETE CASCADE; then the files.
    ctx.db.prepare('DELETE FROM incomes WHERE id = ?').run(id);
    for (const name of documentNames(existing)) removeDocumentFile(ctx, name);
    res.status(204).end();
  });

  return router;
}

export function expensesRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = createUploader(ctx);

  router.get('/', (req, res) => {
    res.json(listExpenses(ctx.db, parseWith(transactionFiltersSchema, req.query)));
  });

  router.get('/export.csv', (req, res) => {
    const filters = parseWith(transactionFiltersSchema, req.query);
    const rows = listExpenses(ctx.db, filters).map((e) => [
      e.date,
      e.payee,
      e.invoiceNumber,
      e.orderNumber,
      PAYMENT_METHOD_LABELS[e.paymentMethod],
      penceToPounds(e.totalPence),
      penceToPounds(e.disallowablePence),
      documentNames(e).join('; '),
      e.notes,
    ]);
    const csv = toCsv(
      ['Date', 'Payee', 'Invoice number', 'Order number', 'Payment method', 'Amount (GBP)', 'Disallowable (GBP)', 'Documents', 'Notes'],
      rows,
    );
    res.attachment(exportFilename('expenses', getTaxYear(ctx.db, filters.taxYearId), 'csv')).type('text/csv').send(csv);
  });

  router.get('/export.json', (req, res) => {
    const filters = parseWith(transactionFiltersSchema, req.query);
    const year = getTaxYear(ctx.db, filters.taxYearId);
    const expenses = listExpenses(ctx.db, filters).map((e) => ({
      id: e.id,
      date: e.date,
      payee: e.payee,
      invoiceNumber: e.invoiceNumber,
      orderNumber: e.orderNumber,
      paymentMethod: e.paymentMethod,
      totalPence: e.totalPence,
      allowablePence: e.totalPence - e.disallowablePence,
      disallowablePence: e.disallowablePence,
      lineItems: e.lineItems.map((li) => ({
        description: li.description,
        category: li.categoryName,
        hmrcCode: li.hmrcCode,
        amountPence: li.amountPence,
        disallowable: li.disallowable,
      })),
      documents: documentNames(e),
      notes: e.notes,
      createdBy: e.createdBy,
      updatedBy: e.updatedBy,
    }));
    sendJsonExport(res, exportFilename('expenses', year, 'json'), { taxYear: year?.label ?? null, expenses });
  });

  // Imports a JSON export (see transactionImport.ts); preview first to see what it would do.
  router.post('/delete', (req, res) => {
    res.json({ deleted: deleteMany(ctx, 'expenses', (id) => getExpense(ctx.db, id), req.body) });
  });

  router.post('/import/preview', (req, res) => {
    res.json(importTransactions(ctx, req, 'expenses', false));
  });

  router.post('/import', (req, res) => {
    res.status(201).json(importTransactions(ctx, req, 'expenses', true));
  });

  router.get('/:id', (req, res) => {
    const expense = getExpense(ctx.db, parseId(req.params.id));
    if (!expense) throw new HttpError(404, 'Transaction not found');
    res.json(expense);
  });

  router.post('/', upload.array('documents', MAX_DOCUMENTS), (req, res) => {
    const input = parseWith(expenseInputSchema, readPayload(req));
    checkTaxYearAndDate(ctx, input.taxYearId, input.date);
    input.lineItems.forEach((item) => checkCategory(ctx, item.categoryId, 'EXPENSE'));
    const files = uploadedFiles(req.files);
    // Checked from a scanned document: the scan goes in the same write, so it can't be saved twice.
    const scan = input.scanId === undefined ? null : getScanRow(ctx.db, input.scanId);
    if (input.scanId !== undefined && !scan) throw new HttpError(409, 'That document has already been saved or discarded, perhaps in another window.');
    const id = saveWithDocuments(ctx, { files, removing: scan ? [scan.filename] : [] }, (filenames) =>
      ctx.db.transaction(() => {
        if (scan && !ctx.db.prepare('DELETE FROM scans WHERE id = ?').run(scan.id).changes) {
          throw new HttpError(409, 'That document has already been saved or discarded, perhaps in another window.');
        }
        const expenseId = insertExpense(ctx.db, input, req.user!.name);
        storeDocuments(ctx, 'expense_id', expenseId, filenames, { removing: [], renaming: [] });
        return expenseId;
      })(),
    );
    if (scan) syncScansNotification(ctx);
    res.status(201).json(getExpense(ctx.db, id));
  });

  router.put('/:id', upload.array('documents', MAX_DOCUMENTS), (req, res) => {
    const id = parseId(req.params.id);
    const existing = getExpense(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Transaction not found');
    const input = parseWith(expenseInputSchema, readPayload(req));
    checkUnchanged(existing, input.expectedUpdatedAt);
    if (input.taxYearId !== existing.taxYearId) throw new HttpError(422, 'A transaction cannot be moved to another tax year');
    checkTaxYearAndDate(ctx, existing.taxYearId, input.date);
    input.lineItems.forEach((item) => checkCategory(ctx, item.categoryId, 'EXPENSE'));
    const existingIds = new Set(existing.lineItems.map((li) => li.id));
    for (const item of input.lineItems) {
      if (item.id !== undefined && !existingIds.has(item.id)) {
        throw new HttpError(422, 'A line item does not belong to this transaction');
      }
    }

    const files = uploadedFiles(req.files);
    const changes = documentChanges(existing, input, files.length);
    saveWithDocuments(ctx, { files, removing: changes.removing.map((d) => d.filename), renaming: changes.renaming }, (filenames) =>
      ctx.db.transaction(() => {
        ctx.db
          .prepare(
            `UPDATE expenses SET date = ?, payee = ?, invoice_number = ?, order_number = ?,
               payment_method = ?, total_pence = ?, notes = ?, updated_by = ?,
               updated_at = ${NEXT_UPDATED_AT}
             WHERE id = ?`,
          )
          .run(
            input.date,
            input.payee,
            input.invoiceNumber,
            input.orderNumber,
            input.paymentMethod,
            lineItemsTotal(input.lineItems),
            input.notes,
            req.user!.name,
            id,
          );
        storeDocuments(ctx, 'expense_id', id, filenames, changes);
        const keep = new Set(input.lineItems.flatMap((item) => (item.id ? [item.id] : [])));
        const remove = ctx.db.prepare('DELETE FROM expense_line_items WHERE id = ?');
        for (const lineId of existingIds) if (!keep.has(lineId)) remove.run(lineId);
        const update = ctx.db.prepare(
          `UPDATE expense_line_items SET description = @description, amount_pence = @amountPence,
             category_id = @categoryId, disallowable = @disallowable, sort_order = @sortOrder WHERE id = @id`,
        );
        const insert = insertLineItem(ctx.db, id);
        input.lineItems.forEach((item, index) => {
          if (item.id) update.run({ ...lineItemParams(ctx.db, item, index), id: item.id });
          else insert.run(lineItemParams(ctx.db, item, index));
        });
      })(),
    );
    res.json(getExpense(ctx.db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const existing = getExpense(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Transaction not found');
    // Line items and document rows go via ON DELETE CASCADE; then the files.
    ctx.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    for (const name of documentNames(existing)) removeDocumentFile(ctx, name);
    res.status(204).end();
  });

  return router;
}

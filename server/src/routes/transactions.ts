// Incoming (incomes) and outgoing (expenses) transaction routes.
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
import type { AppContext } from '../context';
import { toCsv } from '../csv';
import { createUploader, removeDocumentFile, saveWithDocuments, uploadedFiles } from '../documents';
import { HttpError, parseId, parseWith, readPayload } from '../http';
import { getCategory, getExpense, getIncome, getTaxYear, listExpenses, listIncomes, NEXT_UPDATED_AT } from '../repo';

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
 * Checks an edit's document changes: the documents to remove must belong to
 * the transaction, and it can't end up with more than MAX_DOCUMENTS.
 * Returns the documents being removed.
 */
function documentRemovals(
  existing: { documents: TransactionDocument[] },
  removeIds: number[] | undefined,
  adding: number,
): TransactionDocument[] {
  const owned = new Map(existing.documents.map((d) => [d.id, d]));
  const removing = (removeIds ?? []).map((docId) => {
    const doc = owned.get(docId);
    if (!doc) throw new HttpError(422, 'A document does not belong to this transaction');
    return doc;
  });
  if (existing.documents.length - removing.length + adding > MAX_DOCUMENTS) {
    throw new HttpError(422, `A transaction can have at most ${MAX_DOCUMENTS} documents`);
  }
  return removing;
}

/** Records newly placed documents against a transaction, and drops removed ones. */
function storeDocuments(
  ctx: AppContext,
  owner: 'income_id' | 'expense_id',
  ownerId: number,
  added: string[],
  removed: TransactionDocument[],
): void {
  const insert = ctx.db.prepare(`INSERT INTO documents (filename, ${owner}) VALUES (?, ?)`);
  for (const name of added) insert.run(name, ownerId);
  const remove = ctx.db.prepare('DELETE FROM documents WHERE id = ?');
  for (const doc of removed) remove.run(doc.id);
}

const documentNames = (t: { documents: TransactionDocument[] }) => t.documents.map((d) => d.filename);

const csvFilename = (kind: string, year: TaxYear | null) => `${kind}-${year?.label ?? 'export'}.csv`;

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
    res.attachment(csvFilename('incoming', getTaxYear(ctx.db, filters.taxYearId))).type('text/csv').send(csv);
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
        const result = ctx.db
          .prepare(
            `INSERT INTO incomes (tax_year_id, date, description, source, reference, payment_method,
               amount_pence, category_id, notes, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.taxYearId,
            input.date,
            input.description,
            input.source,
            input.reference,
            input.paymentMethod,
            input.amountPence,
            input.categoryId,
            input.notes,
            req.user!.name,
            req.user!.name,
          );
        const incomeId = Number(result.lastInsertRowid);
        storeDocuments(ctx, 'income_id', incomeId, filenames, []);
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
    const removing = documentRemovals(existing, input.removeDocumentIds, files.length);
    saveWithDocuments(ctx, { files, removing: removing.map((d) => d.filename) }, (filenames) =>
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
        storeDocuments(ctx, 'income_id', id, filenames, removing);
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
      e.description,
      PAYMENT_METHOD_LABELS[e.paymentMethod],
      penceToPounds(e.totalPence),
      penceToPounds(e.disallowablePence),
      documentNames(e).join('; '),
      e.notes,
    ]);
    const csv = toCsv(
      ['Date', 'Payee', 'Invoice number', 'Order number', 'Description', 'Payment method', 'Amount (GBP)', 'Disallowable (GBP)', 'Documents', 'Notes'],
      rows,
    );
    res.attachment(csvFilename('outgoing', getTaxYear(ctx.db, filters.taxYearId))).type('text/csv').send(csv);
  });

  router.get('/:id', (req, res) => {
    const expense = getExpense(ctx.db, parseId(req.params.id));
    if (!expense) throw new HttpError(404, 'Transaction not found');
    res.json(expense);
  });

  const insertLine = (expenseId: number) =>
    ctx.db.prepare(
      `INSERT INTO expense_line_items (expense_id, description, amount_pence, category_id, disallowable, sort_order)
       VALUES (${expenseId}, @description, @amountPence, @categoryId, @disallowable, @sortOrder)`,
    );

  const lineParams = (item: { description: string; amountPence: number; categoryId: number; disallowable: boolean }, sortOrder: number) => ({
    description: item.description,
    amountPence: item.amountPence,
    categoryId: item.categoryId,
    disallowable: item.disallowable ? 1 : 0,
    sortOrder,
  });

  router.post('/', upload.array('documents', MAX_DOCUMENTS), (req, res) => {
    const input = parseWith(expenseInputSchema, readPayload(req));
    checkTaxYearAndDate(ctx, input.taxYearId, input.date);
    input.lineItems.forEach((item) => checkCategory(ctx, item.categoryId, 'EXPENSE'));
    const files = uploadedFiles(req.files);
    const id = saveWithDocuments(ctx, { files, removing: [] }, (filenames) =>
      ctx.db.transaction(() => {
        const result = ctx.db
          .prepare(
            `INSERT INTO expenses (tax_year_id, date, payee, invoice_number, order_number, description,
               payment_method, total_pence, notes, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.taxYearId,
            input.date,
            input.payee,
            input.invoiceNumber,
            input.orderNumber,
            input.description,
            input.paymentMethod,
            input.totalPence,
            input.notes,
            req.user!.name,
            req.user!.name,
          );
        const expenseId = Number(result.lastInsertRowid);
        const insert = insertLine(expenseId);
        input.lineItems.forEach((item, index) => insert.run(lineParams(item, index)));
        storeDocuments(ctx, 'expense_id', expenseId, filenames, []);
        return expenseId;
      })(),
    );
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
    const removing = documentRemovals(existing, input.removeDocumentIds, files.length);
    saveWithDocuments(ctx, { files, removing: removing.map((d) => d.filename) }, (filenames) =>
      ctx.db.transaction(() => {
        ctx.db
          .prepare(
            `UPDATE expenses SET date = ?, payee = ?, invoice_number = ?, order_number = ?, description = ?,
               payment_method = ?, total_pence = ?, notes = ?, updated_by = ?,
               updated_at = ${NEXT_UPDATED_AT}
             WHERE id = ?`,
          )
          .run(
            input.date,
            input.payee,
            input.invoiceNumber,
            input.orderNumber,
            input.description,
            input.paymentMethod,
            input.totalPence,
            input.notes,
            req.user!.name,
            id,
          );
        storeDocuments(ctx, 'expense_id', id, filenames, removing);
        const keep = new Set(input.lineItems.flatMap((item) => (item.id ? [item.id] : [])));
        const remove = ctx.db.prepare('DELETE FROM expense_line_items WHERE id = ?');
        for (const lineId of existingIds) if (!keep.has(lineId)) remove.run(lineId);
        const update = ctx.db.prepare(
          `UPDATE expense_line_items SET description = @description, amount_pence = @amountPence,
             category_id = @categoryId, disallowable = @disallowable, sort_order = @sortOrder WHERE id = @id`,
        );
        const insert = insertLine(id);
        input.lineItems.forEach((item, index) => {
          if (item.id) update.run({ ...lineParams(item, index), id: item.id });
          else insert.run(lineParams(item, index));
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

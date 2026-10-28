// Incoming (incomes) and outgoing (expenses) transaction routes.
import { Router } from 'express';
import {
  displayTaxYear,
  expenseInputSchema,
  formatDisplayDate,
  incomeInputSchema,
  isDateInTaxYear,
  PAYMENT_METHOD_LABELS,
  penceToPounds,
  transactionFiltersSchema,
  type CategoryType,
  type TaxYear,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { toCsv } from '../csv';
import { createUploader, removeDocumentFile, saveWithDocument } from '../documents';
import { HttpError, parseId, parseWith, readPayload } from '../http';
import { getCategory, getExpense, getIncome, getTaxYear, listExpenses, listIncomes } from '../repo';

function checkTaxYearAndDate(ctx: AppContext, taxYearId: number, date: string): TaxYear {
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
function checkUnchanged(existing: { updatedAt: string; updatedBy: string | null }, expectedUpdatedAt: string | undefined): void {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === existing.updatedAt) return;
  const who = existing.updatedBy ?? 'someone else';
  throw new HttpError(409, `${who} changed this transaction while you were editing it, so your changes weren't saved. Load their version, then make yours again.`);
}

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
      i.documentFilename,
      i.notes,
    ]);
    const csv = toCsv(
      ['Date', 'Description', 'Source', 'Reference', 'Category', 'HMRC code', 'Payment method', 'Amount (GBP)', 'Document', 'Notes'],
      rows,
    );
    res.attachment(csvFilename('incoming', getTaxYear(ctx.db, filters.taxYearId))).type('text/csv').send(csv);
  });

  router.get('/:id', (req, res) => {
    const income = getIncome(ctx.db, parseId(req.params.id));
    if (!income) throw new HttpError(404, 'Transaction not found');
    res.json(income);
  });

  router.post('/', upload.single('document'), (req, res) => {
    const input = parseWith(incomeInputSchema, readPayload(req));
    checkTaxYearAndDate(ctx, input.taxYearId, input.date);
    checkCategory(ctx, input.categoryId, 'INCOME');
    const id = saveWithDocument(ctx, { file: req.file, current: null, remove: false }, (filename) => {
      const result = ctx.db
        .prepare(
          `INSERT INTO incomes (tax_year_id, date, description, source, reference, payment_method,
             amount_pence, category_id, notes, document_filename, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          filename,
          req.user!.name,
          req.user!.name,
        );
      return Number(result.lastInsertRowid);
    });
    res.status(201).json(getIncome(ctx.db, id));
  });

  router.put('/:id', upload.single('document'), (req, res) => {
    const id = parseId(req.params.id);
    const existing = getIncome(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Transaction not found');
    const input = parseWith(incomeInputSchema, readPayload(req));
    checkUnchanged(existing, input.expectedUpdatedAt);
    if (input.taxYearId !== existing.taxYearId) throw new HttpError(422, 'A transaction cannot be moved to another tax year');
    checkTaxYearAndDate(ctx, existing.taxYearId, input.date);
    checkCategory(ctx, input.categoryId, 'INCOME');
    saveWithDocument(ctx, { file: req.file, current: existing.documentFilename, remove: input.removeDocument }, (filename) =>
      ctx.db
        .prepare(
          `UPDATE incomes SET date = ?, description = ?, source = ?, reference = ?, payment_method = ?,
             amount_pence = ?, category_id = ?, notes = ?, document_filename = ?, updated_by = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
          filename,
          req.user!.name,
          id,
        ),
    );
    res.json(getIncome(ctx.db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const existing = getIncome(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Transaction not found');
    ctx.db.prepare('DELETE FROM incomes WHERE id = ?').run(id);
    removeDocumentFile(ctx, existing.documentFilename);
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
      e.documentFilename,
      e.notes,
    ]);
    const csv = toCsv(
      ['Date', 'Payee', 'Invoice number', 'Order number', 'Description', 'Payment method', 'Amount (GBP)', 'Disallowable (GBP)', 'Document', 'Notes'],
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

  router.post('/', upload.single('document'), (req, res) => {
    const input = parseWith(expenseInputSchema, readPayload(req));
    checkTaxYearAndDate(ctx, input.taxYearId, input.date);
    input.lineItems.forEach((item) => checkCategory(ctx, item.categoryId, 'EXPENSE'));
    const id = saveWithDocument(ctx, { file: req.file, current: null, remove: false }, (filename) =>
      ctx.db.transaction(() => {
        const result = ctx.db
          .prepare(
            `INSERT INTO expenses (tax_year_id, date, payee, invoice_number, order_number, description,
               payment_method, total_pence, notes, document_filename, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            filename,
            req.user!.name,
            req.user!.name,
          );
        const expenseId = Number(result.lastInsertRowid);
        const insert = insertLine(expenseId);
        input.lineItems.forEach((item, index) => insert.run(lineParams(item, index)));
        return expenseId;
      })(),
    );
    res.status(201).json(getExpense(ctx.db, id));
  });

  router.put('/:id', upload.single('document'), (req, res) => {
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

    saveWithDocument(ctx, { file: req.file, current: existing.documentFilename, remove: input.removeDocument }, (filename) =>
      ctx.db.transaction(() => {
        ctx.db
          .prepare(
            `UPDATE expenses SET date = ?, payee = ?, invoice_number = ?, order_number = ?, description = ?,
               payment_method = ?, total_pence = ?, notes = ?, document_filename = ?, updated_by = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
            filename,
            req.user!.name,
            id,
          );
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
    ctx.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    removeDocumentFile(ctx, existing.documentFilename);
    res.status(204).end();
  });

  return router;
}

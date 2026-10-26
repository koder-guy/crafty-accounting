// Data access: SQL rows in, API shapes (camelCase, shared types) out.
import type { Category, Expense, ExpenseWithLineItems, Income, LineItem, TaxYear, TransactionFilters } from '@crafty/shared';
import { taxYearStartYearForDate, todayIso } from '@crafty/shared';
import { getSetting, type Db } from './db';

type Row = Record<string, any>;

// ---- Tax years ----

const TAX_YEAR_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM incomes i WHERE i.tax_year_id = t.id) AS income_count,
    (SELECT COUNT(*) FROM expenses e WHERE e.tax_year_id = t.id) AS expense_count,
    (SELECT COUNT(*) FROM incomes i WHERE i.tax_year_id = t.id AND i.document_filename IS NOT NULL)
      + (SELECT COUNT(*) FROM expenses e WHERE e.tax_year_id = t.id AND e.document_filename IS NOT NULL) AS document_count
  FROM tax_years t`;

const mapTaxYear = (row: Row): TaxYear => ({
  id: row.id,
  label: row.label,
  startDate: row.start_date,
  endDate: row.end_date,
  incomeCount: row.income_count,
  expenseCount: row.expense_count,
  documentCount: row.document_count,
});

export function listTaxYears(db: Db): TaxYear[] {
  return (db.prepare(`${TAX_YEAR_SELECT} ORDER BY t.start_date DESC`).all() as Row[]).map(mapTaxYear);
}

export function getTaxYear(db: Db, id: number): TaxYear | null {
  const row = db.prepare(`${TAX_YEAR_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  return row ? mapTaxYear(row) : null;
}

/**
 * The stored active year if it still exists, otherwise the year containing
 * today, otherwise the most recent year.
 */
export function resolveActiveTaxYearId(db: Db): number | null {
  const years = listTaxYears(db);
  const stored = Number(getSetting(db, 'active_tax_year_id'));
  if (years.some((y) => y.id === stored)) return stored;
  const today = todayIso();
  const current = years.find((y) => y.startDate <= today && today <= y.endDate);
  return current?.id ?? years[0]?.id ?? null;
}

export function currentTaxYearStartYear(): number {
  return taxYearStartYearForDate(todayIso());
}

// ---- Categories ----

const CATEGORY_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM incomes i WHERE i.category_id = c.id)
      + (SELECT COUNT(*) FROM expense_line_items li WHERE li.category_id = c.id) AS usage_count
  FROM categories c`;

const mapCategory = (row: Row): Category => ({
  id: row.id,
  type: row.type,
  name: row.name,
  hmrcCode: row.hmrc_code,
  isCustom: row.is_custom === 1,
  usageCount: row.usage_count,
});

/** Standard categories in HMRC order, then custom ones alphabetically. */
export function listCategories(db: Db): Category[] {
  return (
    db.prepare(`${CATEGORY_SELECT} ORDER BY c.is_custom, c.sort_order, c.name COLLATE NOCASE`).all() as Row[]
  ).map(mapCategory);
}

export function getCategory(db: Db, id: number): Category | null {
  const row = db.prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  return row ? mapCategory(row) : null;
}

/** The standard category a custom one maps to (or the category itself if standard). */
export function standardCategoryFor(db: Db, category: Category): Category {
  if (!category.isCustom) return category;
  const row = db
    .prepare(`${CATEGORY_SELECT} WHERE c.is_custom = 0 AND c.type = ? AND c.hmrc_code = ?`)
    .get(category.type, category.hmrcCode) as Row;
  return mapCategory(row);
}

// ---- Filters ----

const likeTerm = (search: string) => `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function filterClauses(
  alias: string,
  amountColumn: string,
  filters: TransactionFilters,
  searchColumns: string[],
  extraSearch: { sql: string; termCount: number }[] = [],
): { where: string; params: unknown[] } {
  const clauses = [`${alias}.tax_year_id = ?`];
  const params: unknown[] = [filters.taxYearId];
  if (filters.search) {
    const term = likeTerm(filters.search);
    const parts = searchColumns.map((col) => `${col} LIKE ? ESCAPE '\\'`).concat(extraSearch.map((e) => e.sql));
    clauses.push(`(${parts.join(' OR ')})`);
    const count = searchColumns.length + extraSearch.reduce((acc, e) => acc + e.termCount, 0);
    for (let i = 0; i < count; i++) params.push(term);
  }
  if (filters.from) {
    clauses.push(`${alias}.date >= ?`);
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${alias}.date <= ?`);
    params.push(filters.to);
  }
  if (filters.paymentMethod) {
    clauses.push(`${alias}.payment_method = ?`);
    params.push(filters.paymentMethod);
  }
  if (filters.minPence !== undefined) {
    clauses.push(`${alias}.${amountColumn} >= ?`);
    params.push(filters.minPence);
  }
  if (filters.maxPence !== undefined) {
    clauses.push(`${alias}.${amountColumn} <= ?`);
    params.push(filters.maxPence);
  }
  return { where: clauses.join(' AND '), params };
}

// ---- Incomes ----

const INCOME_SELECT = `
  SELECT i.*, c.name AS category_name, c.hmrc_code
  FROM incomes i JOIN categories c ON c.id = i.category_id`;

const mapIncome = (row: Row): Income => ({
  id: row.id,
  taxYearId: row.tax_year_id,
  date: row.date,
  description: row.description,
  source: row.source,
  reference: row.reference,
  paymentMethod: row.payment_method,
  amountPence: row.amount_pence,
  categoryId: row.category_id,
  categoryName: row.category_name,
  hmrcCode: row.hmrc_code,
  notes: row.notes,
  documentFilename: row.document_filename,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listIncomes(db: Db, filters: TransactionFilters, limit?: number): Income[] {
  const { where, params } = filterClauses(
    'i',
    'amount_pence',
    filters,
    ['i.description', 'i.source', 'i.reference', 'i.notes', 'i.document_filename', 'c.name'],
  );
  let sql = `${INCOME_SELECT} WHERE ${where}`;
  if (filters.categoryId) {
    sql += ' AND i.category_id = ?';
    params.push(filters.categoryId);
  }
  sql += ' ORDER BY i.date DESC, i.id DESC';
  if (limit) sql += ` LIMIT ${Math.floor(limit)}`;
  return (db.prepare(sql).all(...params) as Row[]).map(mapIncome);
}

export function getIncome(db: Db, id: number): Income | null {
  const row = db.prepare(`${INCOME_SELECT} WHERE i.id = ?`).get(id) as Row | undefined;
  return row ? mapIncome(row) : null;
}

// ---- Expenses ----

const EXPENSE_SELECT = `
  SELECT e.*,
    (SELECT COUNT(*) FROM expense_line_items li WHERE li.expense_id = e.id) AS line_item_count,
    (SELECT COALESCE(SUM(li.amount_pence), 0) FROM expense_line_items li
      WHERE li.expense_id = e.id AND li.disallowable = 1) AS disallowable_pence,
    (SELECT group_concat(DISTINCT li.category_id) FROM expense_line_items li
      WHERE li.expense_id = e.id) AS category_ids
  FROM expenses e`;

function mapExpense(row: Row, categoryNames: Map<number, string>): Expense {
  const ids: number[] = row.category_ids ? String(row.category_ids).split(',').map(Number) : [];
  return {
    id: row.id,
    taxYearId: row.tax_year_id,
    date: row.date,
    supplier: row.supplier,
    invoiceNumber: row.invoice_number,
    orderNumber: row.order_number,
    description: row.description,
    paymentMethod: row.payment_method,
    totalPence: row.total_pence,
    disallowablePence: row.disallowable_pence,
    notes: row.notes,
    documentFilename: row.document_filename,
    lineItemCount: row.line_item_count,
    categoryNames: ids.map((id) => categoryNames.get(id) ?? 'Unknown'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const categoryNameMap = (db: Db) => new Map(listCategories(db).map((c) => [c.id, c.name]));

export function listExpenses(db: Db, filters: TransactionFilters, limit?: number): ExpenseWithLineItems[] {
  const lineSearch = `EXISTS (SELECT 1 FROM expense_line_items li JOIN categories c ON c.id = li.category_id
    WHERE li.expense_id = e.id AND (li.description LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\'))`;
  const { where, params } = filterClauses(
    'e',
    'total_pence',
    filters,
    ['e.supplier', 'e.invoice_number', 'e.order_number', 'e.description', 'e.notes', 'e.document_filename'],
    [{ sql: lineSearch, termCount: 2 }],
  );
  let sql = `${EXPENSE_SELECT} WHERE ${where}`;
  if (filters.categoryId) {
    sql += ' AND EXISTS (SELECT 1 FROM expense_line_items li WHERE li.expense_id = e.id AND li.category_id = ?)';
    params.push(filters.categoryId);
  }
  sql += ' ORDER BY e.date DESC, e.id DESC';
  if (limit) sql += ` LIMIT ${Math.floor(limit)}`;
  const names = categoryNameMap(db);
  const expenses = (db.prepare(sql).all(...params) as Row[]).map((row) => mapExpense(row, names));
  const lines = lineItemsFor(db, expenses.map((e) => e.id));
  return expenses.map((e) => ({ ...e, lineItems: lines.get(e.id) ?? [] }));
}

const mapLineItem = (li: Row): LineItem => ({
  id: li.id,
  description: li.description,
  amountPence: li.amount_pence,
  categoryId: li.category_id,
  categoryName: li.category_name,
  hmrcCode: li.hmrc_code,
  disallowable: li.disallowable === 1,
});

/** Line items for several expenses in one query, keyed by expense id. */
function lineItemsFor(db: Db, expenseIds: number[]): Map<number, LineItem[]> {
  const byExpense = new Map<number, LineItem[]>();
  if (expenseIds.length === 0) return byExpense;
  const rows = db
    .prepare(
      `SELECT li.*, c.name AS category_name, c.hmrc_code FROM expense_line_items li
       JOIN categories c ON c.id = li.category_id
       WHERE li.expense_id IN (SELECT value FROM json_each(?))
       ORDER BY li.sort_order, li.id`,
    )
    .all(JSON.stringify(expenseIds)) as Row[];
  for (const row of rows) {
    const list = byExpense.get(row.expense_id) ?? [];
    list.push(mapLineItem(row));
    byExpense.set(row.expense_id, list);
  }
  return byExpense;
}

export function getExpense(db: Db, id: number): ExpenseWithLineItems | null {
  const row = db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  const lineItems = lineItemsFor(db, [id]).get(id) ?? [];
  return { ...mapExpense(row, categoryNameMap(db)), lineItems };
}

// ---- Documents ----

export function isDocumentNameInUse(db: Db, filename: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM incomes WHERE document_filename = ?
       UNION ALL SELECT 1 FROM expenses WHERE document_filename = ? LIMIT 1`,
    )
    .get(filename, filename);
  return row !== undefined;
}

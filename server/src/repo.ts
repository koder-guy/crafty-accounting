// Data access: SQL rows in, API shapes (camelCase, shared types) out.
import type {
  Category,
  Expense,
  ExpenseWithLineItems,
  Income,
  LineItem,
  MileageCheck,
  MileageTrip,
  TaxYear,
  TransactionDocument,
  TransactionFilters,
  UseOfHomeResponse,
} from '@crafty/shared';
import {
  MILEAGE_HMRC_CODE,
  mileageClaims,
  startYearFromLabel,
  taxMonths,
  taxYearStartYearForDate,
  todayIso,
  USE_OF_HOME_HMRC_CODE,
  useOfHomeClaim,
} from '@crafty/shared';
import type { Db } from './db';

export type { Db };

type Row = Record<string, any>;

/**
 * SQL for a record's new updated_at when it's saved: now, but always at least
 * 2ms after the previous value. Edits are checked against updated_at (see
 * checkUnchanged), so two saves in the same millisecond must not share one.
 */
export const NEXT_UPDATED_AT = "strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday('now'), julianday(updated_at) + 0.002 / 86400.0))";

/** The same rule for a timestamp worked out in JavaScript (ISO strings sort in time order). */
export const nextTimestamp = (previous: string | null) =>
  new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 2 : 0)).toISOString();

// ---- Tax years ----

const TAX_YEAR_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM incomes i WHERE i.tax_year_id = t.id) AS income_count,
    (SELECT COUNT(*) FROM expenses e WHERE e.tax_year_id = t.id) AS expense_count,
    (SELECT COUNT(*) FROM documents d
      LEFT JOIN incomes i ON i.id = d.income_id
      LEFT JOIN expenses e ON e.id = d.expense_id
      WHERE COALESCE(i.tax_year_id, e.tax_year_id) = t.id) AS document_count,
    (SELECT COUNT(*) FROM mileage_trips m WHERE m.tax_year_id = t.id) AS mileage_count
  FROM tax_years t`;

const mapTaxYear = (row: Row): TaxYear => ({
  id: row.id,
  label: row.label,
  startDate: row.start_date,
  endDate: row.end_date,
  incomeCount: row.income_count,
  expenseCount: row.expense_count,
  documentCount: row.document_count,
  mileageCount: row.mileage_count,
  otherIncomePence: row.other_income_pence,
  submissionMethod: row.submission_method,
  mtdExpenses: row.mtd_expenses,
});

export function listTaxYears(db: Db): TaxYear[] {
  return (db.prepare(`${TAX_YEAR_SELECT} ORDER BY t.start_date DESC`).all() as Row[]).map(mapTaxYear);
}

export function getTaxYear(db: Db, id: number): TaxYear | null {
  const row = db.prepare(`${TAX_YEAR_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  return row ? mapTaxYear(row) : null;
}

/**
 * The person's chosen active year if it still exists, otherwise the year
 * containing today, otherwise the most recent year.
 */
export function resolveActiveTaxYearId(db: Db, chosenId: number | null): number | null {
  const years = listTaxYears(db);
  if (chosenId !== null && years.some((y) => y.id === chosenId)) return chosenId;
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
  documents: [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
});

export function listIncomes(db: Db, filters: TransactionFilters, limit?: number): Income[] {
  const { where, params } = filterClauses(
    'i',
    'amount_pence',
    filters,
    ['i.description', 'i.source', 'i.reference', 'i.notes', 'c.name'],
    [{ sql: documentSearch('income_id', 'i'), termCount: 1 }],
  );
  let sql = `${INCOME_SELECT} WHERE ${where}`;
  if (filters.categoryId) {
    sql += ' AND i.category_id = ?';
    params.push(filters.categoryId);
  }
  sql += ' ORDER BY i.date DESC, i.id DESC';
  if (limit) sql += ` LIMIT ${Math.floor(limit)}`;
  return withDocuments(db, 'income_id', (db.prepare(sql).all(...params) as Row[]).map(mapIncome));
}

export function getIncome(db: Db, id: number): Income | null {
  const row = db.prepare(`${INCOME_SELECT} WHERE i.id = ?`).get(id) as Row | undefined;
  return row ? withDocuments(db, 'income_id', [mapIncome(row)])[0] : null;
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
    payee: row.payee,
    invoiceNumber: row.invoice_number,
    orderNumber: row.order_number,
    description: row.description,
    paymentMethod: row.payment_method,
    totalPence: row.total_pence,
    disallowablePence: row.disallowable_pence,
    notes: row.notes,
    documents: [],
    lineItemCount: row.line_item_count,
    categoryNames: ids.map((id) => categoryNames.get(id) ?? 'Unknown'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
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
    ['e.payee', 'e.invoice_number', 'e.order_number', 'e.description', 'e.notes'],
    [
      { sql: lineSearch, termCount: 2 },
      { sql: documentSearch('expense_id', 'e'), termCount: 1 },
    ],
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
  return withDocuments(db, 'expense_id', expenses).map((e) => ({ ...e, lineItems: lines.get(e.id) ?? [] }));
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
  return { ...withDocuments(db, 'expense_id', [mapExpense(row, categoryNameMap(db))])[0], lineItems };
}

// ---- Documents ----

export function isDocumentNameInUse(db: Db, filename: string): boolean {
  return db.prepare('SELECT 1 FROM documents WHERE filename = ?').get(filename) !== undefined;
}

// ---- Documents ----

type DocumentOwner = 'income_id' | 'expense_id';

/** Search clause matching transactions with a document whose name contains the term. */
const documentSearch = (owner: DocumentOwner, alias: string) =>
  `EXISTS (SELECT 1 FROM documents d WHERE d.${owner} = ${alias}.id AND d.filename LIKE ? ESCAPE '\\')`;

/** Each transaction's documents, keyed by its id, oldest first. */
export function documentsFor(db: Db, owner: DocumentOwner, ids: number[]): Map<number, TransactionDocument[]> {
  const map = new Map<number, TransactionDocument[]>();
  if (ids.length === 0) return map;
  const rows = db
    .prepare(`SELECT id, filename, ${owner} AS owner FROM documents WHERE ${owner} IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify(ids)) as Row[];
  for (const r of rows) map.set(r.owner, [...(map.get(r.owner) ?? []), { id: r.id, filename: r.filename }]);
  return map;
}

function withDocuments<T extends { id: number; documents: TransactionDocument[] }>(db: Db, owner: DocumentOwner, items: T[]): T[] {
  const docs = documentsFor(db, owner, items.map((t) => t.id));
  return items.map((t) => ({ ...t, documents: docs.get(t.id) ?? [] }));
}

// ---- Mileage ----

const mapTrip = (row: Row, claimPence: number): MileageTrip => ({
  id: row.id,
  taxYearId: row.tax_year_id,
  date: row.date,
  description: row.description,
  vehicle: row.vehicle,
  distanceTenths: row.distance_tenths,
  claimPence,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
});

/** Every trip in the given tax years (all years if omitted), each with its claim, newest first. */
export function listMileage(db: Db, taxYearIds?: number[]): MileageTrip[] {
  const rows = (
    taxYearIds
      ? db.prepare('SELECT * FROM mileage_trips WHERE tax_year_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(taxYearIds))
      : db.prepare('SELECT * FROM mileage_trips').all()
  ) as Row[];
  // The car and van threshold runs per tax year, so work the claims out a year at a time.
  const byYear = new Map<number, Row[]>();
  for (const row of rows) byYear.set(row.tax_year_id, [...(byYear.get(row.tax_year_id) ?? []), row]);
  const claims = new Map<number, number>();
  for (const yearRows of byYear.values()) {
    const yearClaims = mileageClaims(
      yearRows.map((r) => ({ id: r.id, date: r.date, vehicle: r.vehicle, distanceTenths: r.distance_tenths })),
    );
    for (const [id, pence] of yearClaims) claims.set(id, pence);
  }
  return rows
    .map((row) => mapTrip(row, claims.get(row.id) ?? 0))
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
}

export function getMileageTrip(db: Db, id: number): MileageTrip | null {
  const row = db.prepare('SELECT tax_year_id FROM mileage_trips WHERE id = ?').get(id) as Row | undefined;
  return row ? (listMileage(db, [row.tax_year_id]).find((t) => t.id === id) ?? null) : null;
}

/** The standard "Car, van and travel expenses" category, which mileage claims count towards. */
export function mileageCategoryId(db: Db): number {
  const row = db.prepare('SELECT id FROM categories WHERE is_custom = 0 AND type = ? AND hmrc_code = ?').get('EXPENSE', MILEAGE_HMRC_CODE) as Row;
  return row.id;
}

/**
 * Mileage claims shaped like expense line items, so they count in every total
 * alongside outgoing transactions (MTD figures, dashboard, reports).
 */
export function mileageClaimLines(db: Db, taxYearIds?: number[]) {
  const categoryId = mileageCategoryId(db);
  return listMileage(db, taxYearIds).map((t) => ({
    tripId: t.id,
    date: t.date,
    description: t.description,
    amountPence: t.claimPence,
    disallowable: false,
    categoryId,
    hmrcCode: MILEAGE_HMRC_CODE,
  }));
}

// ---- Figures ----

export interface IncomeEntry {
  date: string;
  amountPence: number;
  paymentMethod: string;
  categoryId: number;
  hmrcCode: string;
}

export interface ExpenseEntry {
  date: string;
  amountPence: number;
  disallowable: boolean;
  categoryId: number;
  hmrcCode: string;
}

/**
 * Every income and every expense line in a tax year, with mileage and use of
 * home claims included as expense lines: the raw material for MTD and Self Assessment figures.
 */
export function yearEntries(db: Db, taxYearId: number): { incomes: IncomeEntry[]; lines: ExpenseEntry[] } {
  const incomes = db
    .prepare(
      `SELECT i.date, i.amount_pence AS amountPence, i.payment_method AS paymentMethod, i.category_id AS categoryId,
              c.hmrc_code AS hmrcCode
       FROM incomes i JOIN categories c ON c.id = i.category_id WHERE i.tax_year_id = ?`,
    )
    .all(taxYearId) as IncomeEntry[];
  const lines = (
    db
      .prepare(
        `SELECT e.date, li.amount_pence AS amountPence, li.disallowable, li.category_id AS categoryId, c.hmrc_code AS hmrcCode
         FROM expense_line_items li
         JOIN expenses e ON e.id = li.expense_id
         JOIN categories c ON c.id = li.category_id
         WHERE e.tax_year_id = ?`,
      )
      .all(taxYearId) as (Omit<ExpenseEntry, 'disallowable'> & { disallowable: number })[]
  ).map((line): ExpenseEntry => ({ ...line, disallowable: line.disallowable === 1 }));
  for (const claim of [...mileageClaimLines(db, [taxYearId]), ...useOfHomeClaimLines(db, [taxYearId])]) {
    lines.push({ date: claim.date, amountPence: claim.amountPence, disallowable: false, categoryId: claim.categoryId, hmrcCode: claim.hmrcCode });
  }
  return { incomes, lines };
}

/**
 * Flags a possible double claim: mileage at HMRC rates alongside allowable
 * outgoing in the same category (including custom categories mapped to it).
 * The app can't tell fuel from parking, so this is only ever a warning.
 */
export function mileageCheck(db: Db, taxYearId: number): MileageCheck | null {
  const mileagePence = mileageClaimLines(db, [taxYearId]).reduce((acc, c) => acc + c.amountPence, 0);
  if (mileagePence === 0) return null;
  const outgoing = db
    .prepare(
      `SELECT COALESCE(SUM(li.amount_pence), 0) AS pence, COUNT(*) AS count
       FROM expense_line_items li
       JOIN expenses e ON e.id = li.expense_id
       JOIN categories c ON c.id = li.category_id
       WHERE e.tax_year_id = ? AND c.hmrc_code = ? AND li.disallowable = 0`,
    )
    .get(taxYearId, MILEAGE_HMRC_CODE) as { pence: number; count: number };
  if (outgoing.count === 0) return null;
  return { mileagePence, outgoingPence: outgoing.pence, outgoingCount: outgoing.count, categoryId: mileageCategoryId(db) };
}

// ---- Use of home ----

/** The year's twelve tax months with the hours worked at home and the flat-rate claim for each. */
export function getUseOfHome(db: Db, taxYear: TaxYear): UseOfHomeResponse {
  const rows = db
    .prepare('SELECT month_index, hours, updated_by, updated_at FROM home_working_months WHERE tax_year_id = ?')
    .all(taxYear.id) as Row[];
  const hours = new Map(rows.map((r) => [r.month_index as number, r.hours as number]));
  const months = taxMonths(startYearFromLabel(taxYear.label)!).map((m) => {
    const h = hours.get(m.index) ?? 0;
    return { ...m, hours: h, claimPence: useOfHomeClaim(h) };
  });
  // Saves replace every row at once, so the latest row says when (and by whom) the hours last changed.
  const latest = rows.reduce<Row | null>((acc, r) => (!acc || r.updated_at > acc.updated_at ? r : acc), null);
  return {
    months,
    totals: {
      hours: months.reduce((acc, m) => acc + m.hours, 0),
      claimPence: months.reduce((acc, m) => acc + m.claimPence, 0),
      monthsClaimed: months.filter((m) => m.claimPence > 0).length,
    },
    updatedAt: latest?.updated_at ?? null,
    updatedBy: latest?.updated_by ?? null,
  };
}

/**
 * Use of home claims shaped like expense line items, one per month with a
 * claim, dated the month's last day (the 5th) so they fall in the right quarter.
 */
export function useOfHomeClaimLines(db: Db, taxYearIds?: number[]) {
  const years = listTaxYears(db).filter((y) => !taxYearIds || taxYearIds.includes(y.id));
  const categoryId = useOfHomeCategoryId(db);
  return years.flatMap((year) =>
    getUseOfHome(db, year)
      .months.filter((m) => m.claimPence > 0)
      .map((m) => ({
        taxYearId: year.id,
        monthIndex: m.index,
        date: m.endDate,
        description: `Use of home, ${m.range} (${m.hours} hours)`,
        amountPence: m.claimPence,
        disallowable: false,
        categoryId,
        hmrcCode: USE_OF_HOME_HMRC_CODE,
      })),
  );
}

/** The standard "Rent, rates, power and insurance costs" category, which use of home claims count towards. */
export function useOfHomeCategoryId(db: Db): number {
  const row = db.prepare('SELECT id FROM categories WHERE is_custom = 0 AND type = ? AND hmrc_code = ?').get('EXPENSE', USE_OF_HOME_HMRC_CODE) as Row;
  return row.id;
}

// Importing transactions from a JSON export (GET /api/{incomes,expenses}/export.json),
// whether from this install or another one. Each transaction goes into the tax year
// its date falls in, and its category is found by name, or else by the HMRC field it
// counts towards. Transactions the books already have are left out, so the same file
// can be imported twice. It's all or nothing: any problem and nothing is imported.
import type { Request } from 'express';
import {
  expenseImportRowSchema,
  formatDisplayDate,
  formatGBP,
  incomeImportRowSchema,
  isDateInTaxYear,
  MAX_IMPORT_ROWS,
  type Category,
  type CategoryType,
  type ExpenseImportRow,
  type ImportSummary,
  type IncomeImportRow,
  type TaxYear,
} from '@crafty/shared';
import type { z } from 'zod';
import type { AppContext } from './context';
import { HttpError } from './http';
import { expenseLineProblems, insertExpense, insertIncome, lineItemsTotal, listCategories, listExpenses, listIncomes, listTaxYears } from './repo';

export type ImportKind = 'incomes' | 'expenses';

const NOUN: Record<ImportKind, string> = { incomes: 'income', expenses: 'expense' };
const MAX_PROBLEMS = 50;

/** Matches transactions regardless of case and spacing in the text. */
const textKey = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const incomeKey = (i: { date: string; description: string; amountPence: number; paymentMethod: string }) =>
  [i.date, textKey(i.description), i.amountPence, i.paymentMethod].join('|');
const expenseKey = (e: { date: string; payee: string; totalPence: number; paymentMethod: string }) =>
  [e.date, textKey(e.payee), e.totalPence, e.paymentMethod].join('|');

class Problems {
  list: string[] = [];
  more = 0;
  add(message: string) {
    if (this.list.length < MAX_PROBLEMS) this.list.push(message);
    else this.more++;
  }
  done(): string[] {
    return this.more ? [...this.list, `…and ${this.more} more`] : this.list;
  }
}

/** The file's array of transactions, or why it isn't one this page can import. */
function rowsFrom(body: unknown, kind: ImportKind): unknown[] {
  const file = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const rows = file?.[kind];
  if (!Array.isArray(rows)) {
    const other: ImportKind = kind === 'incomes' ? 'expenses' : 'incomes';
    if (Array.isArray(file?.[other])) {
      throw new HttpError(422, `This is an ${NOUN[other]} export. Import it on the ${other === 'incomes' ? 'Income' : 'Expenses'} page.`);
    }
    throw new HttpError(422, `This isn't an ${NOUN[kind]} export from Crafty Accounting: it has no "${kind}" list.`);
  }
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(422, `A file can hold at most ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} transactions.`);
  return rows;
}

function categoryFinder(categories: Category[], type: CategoryType) {
  const ofType = categories.filter((c) => c.type === type);
  const byName = new Map(ofType.map((c) => [c.name.toLowerCase(), c]));
  const byCode = new Map(ofType.filter((c) => !c.isCustom).map((c) => [c.hmrcCode, c]));
  return (ref: { category?: string | null; hmrcCode?: string | null }): Category | null =>
    (ref.category && byName.get(ref.category.trim().toLowerCase())) || (ref.hmrcCode && byCode.get(ref.hmrcCode)) || null;
}

const describeCategory = (ref: { category?: string | null; hmrcCode?: string | null }) =>
  ref.category ? `“${ref.category}”` : ref.hmrcCode ? `with HMRC field “${ref.hmrcCode}”` : '(none given)';

interface Planned<T> {
  row: T;
  taxYear: TaxYear;
  key: string;
}

/**
 * Checks every row and works out what importing would do. Rows are numbered from 1
 * in the problems, with their date and description where they have them.
 */
function plan<Row extends { date: string; paymentMethod: string; documents?: unknown[] | null }>(
  ctx: AppContext,
  rows: unknown[],
  kind: ImportKind,
  schema: z.ZodType<Row>,
  check: (row: Row, label: string, problems: Problems) => string | null,
) {
  const problems = new Problems();
  const taxYears = listTaxYears(ctx.db);
  const planned: Planned<Row>[] = [];

  rows.forEach((raw, index) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const what = typeof r.description === 'string' ? r.description : typeof r.payee === 'string' ? r.payee : null;
    const label = [`${NOUN[kind][0]!.toUpperCase()}${NOUN[kind].slice(1)} ${index + 1}`, typeof r.date === 'string' ? formatDisplayDate(r.date) : null, what]
      .filter(Boolean)
      .join(' · ');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      // lineItems.0.amountPence → line 1, amountPence
      const field = issue.path
        .map((part, i) => (typeof part === 'number' && issue.path[i - 1] === 'lineItems' ? `line ${part + 1}` : String(part)))
        .filter((part) => part !== 'lineItems')
        .join(', ');
      problems.add(`${label}: ${field ? `${field}: ` : ''}${issue.message}`);
      return;
    }
    const row = parsed.data;
    const taxYear = taxYears.find((y) => isDateInTaxYear(row.date, y));
    if (!taxYear) {
      problems.add(`${label}: there's no tax year for ${formatDisplayDate(row.date)}. Add it in Settings → Tax Years first.`);
      return;
    }
    const key = check(row, label, problems);
    if (key !== null) planned.push({ row, taxYear, key });
  });

  return { planned, problems: problems.done() };
}

/** Leaves out the rows the books already have, counting repeats: two identical sales in the file and one in the books adds one. */
function newRows<T>(planned: Planned<T>[], existingKeys: (taxYearId: number) => string[]): { adding: Planned<T>[]; alreadyThere: number } {
  const remaining = new Map<string, number>();
  for (const taxYearId of new Set(planned.map((p) => p.taxYear.id))) {
    for (const key of existingKeys(taxYearId)) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const adding: Planned<T>[] = [];
  let alreadyThere = 0;
  for (const p of planned) {
    const left = remaining.get(p.key) ?? 0;
    if (left > 0) {
      remaining.set(p.key, left - 1);
      alreadyThere++;
    } else {
      adding.push(p);
    }
  }
  return { adding, alreadyThere };
}

function summarise<T extends { date: string; documents?: unknown[] | null }>(
  inFile: number,
  adding: Planned<T>[],
  amount: (row: T) => number,
  alreadyThere: number,
  problems: string[],
): ImportSummary {
  const years = new Map<number, ImportSummary['years'][number]>();
  for (const { row, taxYear } of adding) {
    const date = row.date;
    const year = years.get(taxYear.id) ?? { taxYearId: taxYear.id, label: taxYear.label, adding: 0, firstDate: date };
    year.adding++;
    if (date < year.firstDate) year.firstDate = date;
    years.set(taxYear.id, year);
  }
  return {
    inFile,
    adding: problems.length ? 0 : adding.length,
    addingPence: problems.length ? 0 : adding.reduce((acc, p) => acc + amount(p.row), 0),
    alreadyThere: problems.length ? 0 : alreadyThere,
    documentsLeftOut: problems.length ? 0 : adding.reduce((acc, p) => acc + (p.row.documents?.length ?? 0), 0),
    years: problems.length ? [] : [...years.values()].sort((a, b) => a.label.localeCompare(b.label)),
    problems,
  };
}

/**
 * Previews (`save` false) or carries out an import of the request's JSON export.
 * Carrying it out refuses (422) a file with problems, adding nothing.
 */
export function importTransactions(ctx: AppContext, req: Request, kind: ImportKind, save: boolean): ImportSummary {
  const rows = rowsFrom(req.body, kind);
  const by = req.user!.name;
  const categories = listCategories(ctx.db);

  if (kind === 'incomes') {
    const findCategory = categoryFinder(categories, 'INCOME');
    const categoryIds = new Map<IncomeImportRow, number>();
    const { planned, problems } = plan(ctx, rows, kind, incomeImportRowSchema, (row, label, problems) => {
      const category = findCategory(row);
      if (!category) {
        problems.add(`${label}: there's no income category ${describeCategory(row)}.`);
        return null;
      }
      categoryIds.set(row, category.id);
      return incomeKey(row);
    });
    const { adding, alreadyThere } = newRows(planned, (taxYearId) => listIncomes(ctx.db, { taxYearId }).map(incomeKey));
    const summary = summarise(rows.length, adding, (row) => row.amountPence, alreadyThere, problems);
    if (save) {
      refuseProblems(problems);
      ctx.db.transaction(() => {
        for (const { row, taxYear } of adding) {
          insertIncome(ctx.db, { ...row, taxYearId: taxYear.id, categoryId: categoryIds.get(row)! }, by);
        }
      })();
    }
    return summary;
  }

  const findCategory = categoryFinder(categories, 'EXPENSE');
  const lineCategoryIds = new Map<ExpenseImportRow, number[]>();
  const { planned, problems } = plan(ctx, rows, kind, expenseImportRowSchema, (row, label, problems) => {
    const ids: number[] = [];
    let ok = true;
    row.lineItems.forEach((line, index) => {
      const category = findCategory(line);
      if (category) ids.push(category.id);
      else {
        problems.add(`${label}: line ${index + 1}: there's no expense category ${describeCategory(line)}.`);
        ok = false;
      }
    });
    const total = lineItemsTotal(row.lineItems);
    if (row.totalPence != null && row.totalPence !== total) {
      problems.add(`${label}: its total, ${formatGBP(row.totalPence)}, isn't the sum of its line items, ${formatGBP(total)}.`);
      ok = false;
    }
    if (!ok) return null;
    for (const problem of expenseLineProblems(ctx.db, row.lineItems.map((line, i) => ({ ...line, categoryId: ids[i]! })))) {
      problems.add(`${label}: ${problem.index === null ? '' : `line ${problem.index + 1}: `}${problem.message}.`);
      ok = false;
    }
    if (!ok) return null;
    lineCategoryIds.set(row, ids);
    return expenseKey({ ...row, totalPence: total });
  });
  const { adding, alreadyThere } = newRows(planned, (taxYearId) => listExpenses(ctx.db, { taxYearId }).map(expenseKey));
  const summary = summarise(rows.length, adding, (row) => lineItemsTotal(row.lineItems), alreadyThere, problems);
  if (save) {
    refuseProblems(problems);
    ctx.db.transaction(() => {
      for (const { row, taxYear } of adding) {
        const ids = lineCategoryIds.get(row)!;
        insertExpense(
          ctx.db,
          { ...row, taxYearId: taxYear.id, lineItems: row.lineItems.map((line, i) => ({ ...line, categoryId: ids[i]! })) },
          by,
        );
      }
    })();
  }
  return summary;
}

function refuseProblems(problems: string[]): void {
  if (problems.length === 0) return;
  throw new HttpError(422, `Nothing was imported. ${problems[0]}${problems.length > 1 ? ' (and other problems)' : ''}`);
}

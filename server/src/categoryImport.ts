// Custom categories go between installs as a JSON export (GET /api/categories/export.json).
// Each one is matched to the standard category it maps to by type and HMRC field, and
// those the books already have (same name and mapping) are left out, so the same file
// can be imported twice. It's all or nothing: any problem and nothing is imported.
import {
  CASH_BASIS_UNUSED_CODE,
  customCategoryImportRowSchema,
  type Category,
  type CategoryImportSummary,
} from '@crafty/shared';
import type { AppContext } from './context';
import { HttpError } from './http';
import { listCategories } from './repo';

/** Most categories one file can hold. */
const MAX_CATEGORIES = 1000;
const MAX_PROBLEMS = 50;

const TYPE_NOUN = { INCOME: 'income', EXPENSE: 'expense' } as const;
const nameKey = (type: string, name: string) => `${type}|${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/** What `export.json` holds: each custom category with the standard one it maps to. */
export function categoriesExport(ctx: AppContext) {
  const all = listCategories(ctx.db);
  const standard = (c: Category) => all.find((s) => !s.isCustom && s.type === c.type && s.hmrcCode === c.hmrcCode);
  return all
    .filter((c) => c.isCustom)
    .map((c) => ({ name: c.name, type: c.type, hmrcCode: c.hmrcCode, mapsTo: standard(c)?.name ?? null }));
}

/**
 * Previews (`save` false) or carries out an import of a custom categories export.
 * Carrying it out refuses (422) a file with problems, adding nothing.
 */
export function importCategories(ctx: AppContext, body: unknown, save: boolean): CategoryImportSummary {
  const file = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const rows = file?.categories;
  if (!Array.isArray(rows)) {
    if (Array.isArray(file?.incomes) || Array.isArray(file?.expenses)) {
      throw new HttpError(422, 'This is a transactions export. Import it on the Income or Expenses page.');
    }
    throw new HttpError(422, 'This isn’t a custom categories export from Crafty Accounting: it has no "categories" list.');
  }
  if (rows.length > MAX_CATEGORIES) throw new HttpError(422, `A file can hold at most ${MAX_CATEGORIES.toLocaleString('en-GB')} categories.`);

  const all = listCategories(ctx.db);
  const existing = new Map(all.map((c) => [nameKey(c.type, c.name), c]));
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);
  const adding: (CategoryImportSummary['adding'][number] & { hmrcCode: string })[] = [];
  const inFile = new Map<string, string>();
  let alreadyThere = 0;

  rows.forEach((raw, index) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const label = [`Category ${index + 1}`, typeof r.name === 'string' && r.name.trim() ? `“${r.name.trim()}”` : null].filter(Boolean).join(' · ');
    const parsed = customCategoryImportRowSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      problem(`${label}: ${issue.path.length ? `${issue.path.join(', ')}: ` : ''}${issue.message}`);
      return;
    }
    const row = parsed.data;
    const name = row.name.replace(/\s+/g, ' ');
    const target = all.find((c) => !c.isCustom && c.type === row.type && c.hmrcCode === row.hmrcCode);
    if (!target) {
      problem(`${label}: there's no standard ${TYPE_NOUN[row.type]} category with HMRC field “${row.hmrcCode}”.`);
      return;
    }
    const key = nameKey(row.type, name);
    const seen = inFile.get(key);
    if (seen !== undefined) {
      // A repeat in the file is fine as long as it maps the same way.
      if (seen !== row.hmrcCode) problem(`${label}: the file has another ${TYPE_NOUN[row.type]} category with this name, mapped differently.`);
      return;
    }
    inFile.set(key, row.hmrcCode);
    const there = existing.get(key);
    if (there) {
      if (there.isCustom && there.hmrcCode === row.hmrcCode) alreadyThere++;
      else if (!there.isCustom) problem(`${label}: that's the name of a standard MTD category.`);
      else {
        const mappedTo = all.find((c) => !c.isCustom && c.type === there.type && c.hmrcCode === there.hmrcCode);
        problem(`${label}: you already have it, mapped to ${mappedTo?.name ?? there.hmrcCode} rather than ${target.name}.`);
      }
      return;
    }
    if (row.hmrcCode === CASH_BASIS_UNUSED_CODE) {
      problem(`${label}: it maps to ${target.name}, which isn't used on the cash basis.`);
      return;
    }
    adding.push({ name, type: row.type, mapsTo: target.name, hmrcCode: row.hmrcCode });
  });

  const shown = problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `…and ${problems.length - MAX_PROBLEMS} more`] : problems;
  if (save) {
    if (problems.length) throw new HttpError(422, `Nothing was imported. ${problems[0]}${problems.length > 1 ? ' (and other problems)' : ''}`);
    const insert = ctx.db.prepare('INSERT INTO categories (type, name, hmrc_code, sort_order, is_custom) VALUES (?, ?, ?, 1000, 1)');
    ctx.db.transaction(() => {
      for (const c of adding) insert.run(c.type, c.name, c.hmrcCode);
    })();
  }
  return {
    inFile: rows.length,
    adding: problems.length ? [] : adding.map(({ name, type, mapsTo }) => ({ name, type, mapsTo })),
    alreadyThere: problems.length ? 0 : alreadyThere,
    problems: shown,
  };
}

// Standard MTD categories are fixed; custom categories carry the user's own
// name and map onto one standard category (taking its type and HMRC code), so
// MTD totals are unaffected by how finely transactions are categorised.
import { Router } from 'express';
import { customCategorySchema } from '@crafty/shared';
import { categoriesExport, importCategories } from '../categoryImport';
import type { AppContext } from '../context';
import { sendJsonExport } from '../jsonExport';
import { HttpError, parseId, parseWith } from '../http';
import { getCategory, listCategories, standardCategoryFor } from '../repo';

export function categoriesRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listCategories(ctx.db));
  });

  router.get('/export.json', (_req, res) => {
    sendJsonExport(res, 'custom-categories.json', { categories: categoriesExport(ctx) });
  });

  // Imports a JSON export (see categoryImport.ts); preview first to see what it would do.
  router.post('/import/preview', (req, res) => {
    res.json(importCategories(ctx, req.body, false));
  });

  router.post('/import', (req, res) => {
    res.status(201).json(importCategories(ctx, req.body, true));
  });

  /** Validates the input and returns the standard category to map to. */
  const readInput = (body: unknown, exceptId?: number) => {
    const input = parseWith(customCategorySchema, body);
    const target = getCategory(ctx.db, input.mapsToCategoryId);
    if (!target || target.isCustom) throw new HttpError(422, 'Choose one of the standard MTD categories to map to');
    const clash = ctx.db
      .prepare('SELECT 1 FROM categories WHERE type = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(target.type, input.name, exceptId ?? 0);
    if (clash) throw new HttpError(409, `There is already a category called "${input.name}"`);
    return { name: input.name, target };
  };

  const getCustom = (id: number) => {
    const category = getCategory(ctx.db, id);
    if (!category) throw new HttpError(404, 'Category not found');
    if (!category.isCustom) throw new HttpError(422, 'The standard MTD categories cannot be changed');
    return category;
  };

  router.post('/', (req, res) => {
    const { name, target } = readInput(req.body);
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO categories (type, name, hmrc_code, sort_order, is_custom) VALUES (?, ?, ?, 1000, 1)')
      .run(target.type, name, target.hmrcCode);
    res.status(201).json(getCategory(ctx.db, Number(lastInsertRowid)));
  });

  router.put('/:id', (req, res) => {
    const category = getCustom(parseId(req.params.id));
    const { name, target } = readInput(req.body, category.id);
    const remapping = target.type !== category.type || target.hmrcCode !== category.hmrcCode;
    if (remapping && category.usageCount > 0) {
      // Moving a used category would silently change past MTD totals.
      throw new HttpError(
        409,
        'This category is already used, so its MTD category cannot change. Create a new category instead.',
      );
    }
    ctx.db
      .prepare('UPDATE categories SET type = ?, name = ?, hmrc_code = ? WHERE id = ?')
      .run(target.type, name, target.hmrcCode, category.id);
    res.json(getCategory(ctx.db, category.id));
  });

  /** Deletes a custom category, moving anything using it to its standard category. */
  router.delete('/:id', (req, res) => {
    const category = getCustom(parseId(req.params.id));
    const standard = standardCategoryFor(ctx.db, category);
    const result = ctx.db.transaction(() => {
      const incomes = ctx.db.prepare('UPDATE incomes SET category_id = ? WHERE category_id = ?').run(standard.id, category.id);
      const lines = ctx.db
        .prepare('UPDATE expense_line_items SET category_id = ? WHERE category_id = ?')
        .run(standard.id, category.id);
      ctx.db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
      return { incomes: incomes.changes, lineItems: lines.changes };
    })();
    res.json({ reassignedTo: standard, ...result });
  });

  return router;
}

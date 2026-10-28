// Hours worked at home each month, claimed at HMRC's flat rate.
import { Router } from 'express';
import { z } from 'zod';
import { useOfHomeInputSchema } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { getTaxYear, getUseOfHome } from '../repo';

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

export function useOfHomeRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const taxYear = getTaxYear(ctx.db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    res.json(getUseOfHome(ctx.db, taxYear));
  });

  /** Replaces the year's hours in one go. */
  router.put('/', (req, res) => {
    const input = parseWith(useOfHomeInputSchema, req.body);
    const taxYear = getTaxYear(ctx.db, input.taxYearId);
    if (!taxYear) throw new HttpError(422, 'That tax year no longer exists');
    const current = getUseOfHome(ctx.db, taxYear);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
      throw new HttpError(
        409,
        `${current.updatedBy ?? 'Someone else'} changed these hours while you were editing them, so yours weren't saved. Load their version, then make yours again.`,
      );
    }
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM home_working_months WHERE tax_year_id = ?').run(taxYear.id);
      const insert = ctx.db.prepare('INSERT INTO home_working_months (tax_year_id, month_index, hours, updated_by) VALUES (?, ?, ?, ?)');
      for (const m of input.months) if (m.hours > 0) insert.run(taxYear.id, m.index, m.hours, req.user!.name);
    })();
    res.json(getUseOfHome(ctx.db, taxYear));
  });

  return router;
}

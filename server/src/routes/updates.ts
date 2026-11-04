import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context';
import { parseWith } from '../http';

const applySchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });

/** Settings → Updates. Checking and applying are changes, so editors only (readOnlyGuard). */
export function updatesRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.updates.status());
  });

  router.post('/check', async (_req, res) => {
    await ctx.updates.check();
    res.json(ctx.updates.status());
  });

  router.post('/apply', async (req, res) => {
    const { version } = parseWith(applySchema, req.body);
    await ctx.updates.apply(version);
    res.status(202).json(ctx.updates.status());
  });

  return router;
}

// Settings → Square (the access token, shown only as a hint, and the categories imports go into)
// and Income → Import from Square.
import { Router } from 'express';
import { squareImportSchema, squarePayoutsQuerySchema, squareSettingsSchema, type SquarePayoutList } from '@crafty/shared';
import type { AppContext } from '../context';
import { parseWith } from '../http';
import { checkSquareToken, getSquareSettings, importSquarePayouts, listSquarePayouts, removeSquareToken, saveSquareCategory, saveSquareToken, squareStatus } from '../square';

export function squareRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(squareStatus(ctx.db));
  });

  // A new token is checked with Square before it's saved.
  router.put('/', async (req, res) => {
    const input = parseWith(squareSettingsSchema, req.body);
    const environment = input.environment ?? getSquareSettings(ctx.db).environment;
    const merchantName = input.accessToken ? await checkSquareToken(ctx, input.accessToken, environment) : null;
    ctx.db.transaction(() => {
      if (input.accessToken) saveSquareToken(ctx.db, input.accessToken, environment, merchantName, req.user!.name);
      if (input.incomeCategoryId) saveSquareCategory(ctx.db, 'income', input.incomeCategoryId);
      if (input.feeCategoryId) saveSquareCategory(ctx.db, 'fee', input.feeCategoryId);
    })();
    res.json(squareStatus(ctx.db));
  });

  router.delete('/token', (_req, res) => {
    removeSquareToken(ctx.db);
    res.json(squareStatus(ctx.db));
  });

  router.get('/payouts', async (req, res) => {
    const { from } = parseWith(squarePayoutsQuerySchema, req.query);
    const body: SquarePayoutList = { from, payouts: await listSquarePayouts(ctx, from) };
    res.json(body);
  });

  router.post('/import', async (req, res) => {
    const { payoutIds } = parseWith(squareImportSchema, req.body);
    res.json(await importSquarePayouts(ctx, payoutIds, req.user!.name));
  });

  return router;
}

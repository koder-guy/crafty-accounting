// Lets a new install load the sample data from the dashboard, so the app can
// be explored before entering real books. Only allowed while there are no
// tax years, so it can never mix with real data.
import { Router } from 'express';
import type { AppContext } from '../context';
import { getSetting } from '../db';
import { HttpError } from '../http';
import { generateSampleData, hasData } from '../sampleData';

export function sampleDataRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const exists = hasData(ctx.db);
    res.json({ loaded: exists && getSetting(ctx.db, 'sample_data_loaded') === '1', canLoad: !exists });
  });

  router.post('/', (_req, res) => {
    if (hasData(ctx.db)) throw new HttpError(409, 'Sample data can only be loaded when there are no tax years');
    const result = generateSampleData(ctx.db, ctx.paths.uploadsDir);
    res.status(201).json(result);
  });

  return router;
}

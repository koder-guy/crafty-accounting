import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieSession from 'cookie-session';
import type { AppContext } from './context';
import { errorHandler, HttpError } from './http';
import { listCategories } from './repo';
import { authRouter, requireAuth } from './routes/auth';
import { backupRouter } from './routes/backup';
import { dashboardRouter } from './routes/dashboard';
import { documentsRouter } from './routes/documents';
import { mtdRouter } from './routes/mtd';
import { taxYearsRouter } from './routes/taxYears';
import { expensesRouter, incomesRouter } from './routes/transactions';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Remove any uploaded temp file the handler didn't consume (e.g. on a validation error).
    res.on('finish', () => {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    });
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(
    cookieSession({
      name: 'crafty_session',
      keys: [ctx.config.sessionSecret],
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.cookieSecure,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRouter(ctx));

  app.use('/api', requireAuth);
  app.use('/api/tax-years', taxYearsRouter(ctx));
  app.get('/api/categories', (_req, res) => {
    res.json(listCategories(ctx.db));
  });
  app.use('/api/incomes', incomesRouter(ctx));
  app.use('/api/expenses', expensesRouter(ctx));
  app.use('/api/documents', documentsRouter(ctx));
  app.use('/api/dashboard', dashboardRouter(ctx));
  app.use('/api/mtd', mtdRouter(ctx));
  app.use('/api', backupRouter(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  const clientDist = ctx.config.clientDist;
  if (clientDist) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

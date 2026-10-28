import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieSession from 'cookie-session';
import type { AppContext } from './context';
import { errorHandler, HttpError } from './http';
import { authRouter, requireAuth } from './routes/auth';
import { backupRouter } from './routes/backup';
import { categoriesRouter } from './routes/categories';
import { dashboardRouter } from './routes/dashboard';
import { documentsRouter } from './routes/documents';
import { mileageRouter } from './routes/mileage';
import { mtdRouter } from './routes/mtd';
import { useOfHomeRouter } from './routes/useOfHome';
import { reportsRouter } from './routes/reports';
import { sampleDataRouter } from './routes/sampleData';
import { taxYearsRouter } from './routes/taxYears';
import { expensesRouter, incomesRouter } from './routes/transactions';
import { usersRouter } from './routes/users';

/** Identifies one open browser tab, so it isn't told about its own changes. */
const clientId = (value: unknown) => (typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : null);

/** Changes that only affect the person making them, so nobody else needs telling. */
const PERSONAL_CHANGES = new Set(['/tax-years/active']);

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Over HTTPS (e.g. via Caddy), tell browsers to keep using HTTPS for six months.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
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

  app.use('/api', requireAuth(ctx));

  app.get('/api/events', (req, res) => {
    ctx.liveUpdates.subscribe(res, clientId(req.query.client));
  });
  // After any successful change, tell the other open browsers to refetch.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !PERSONAL_CHANGES.has(req.path)) {
      // Read the path now: routers rewrite it while handling the request.
      const area = req.path.split('/')[1] ?? '';
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        ctx.liveUpdates.publish({ area, by: req.user!.name }, clientId(req.get('X-Client-Id')));
      });
    }
    next();
  });

  app.use('/api/users', usersRouter(ctx));
  app.use('/api/tax-years', taxYearsRouter(ctx));
  app.use('/api/categories', categoriesRouter(ctx));
  app.use('/api/incomes', incomesRouter(ctx));
  app.use('/api/expenses', expensesRouter(ctx));
  app.use('/api/mileage', mileageRouter(ctx));
  app.use('/api/use-of-home', useOfHomeRouter(ctx));
  app.use('/api/documents', documentsRouter(ctx));
  app.use('/api/dashboard', dashboardRouter(ctx));
  app.use('/api/mtd', mtdRouter(ctx));
  app.use('/api/reports', reportsRouter(ctx));
  app.use('/api/sample-data', sampleDataRouter(ctx));
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

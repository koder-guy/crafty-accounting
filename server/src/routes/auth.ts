import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { loginSchema, type MeResponse } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { authenticate, getUser } from '../users';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in person, set by requireAuth. */
      user?: { id: number; name: string; activeTaxYearId: number | null };
    }
  }
}

/** Loads the signed-in user on every request, so a removed user is signed out straight away. */
export function requireAuth(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const user = typeof req.session?.userId === 'number' ? getUser(ctx.db, req.session.userId) : null;
    if (!user) {
      req.session = null;
      next(new HttpError(401, 'Please sign in'));
      return;
    }
    req.user = user;
    next();
  };
}

export function authRouter(ctx: AppContext): Router {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    },
  });

  router.post('/login', loginLimiter, (req, res) => {
    const { name, password } = parseWith(loginSchema, req.body);
    const user = authenticate(ctx.db, name, password);
    if (!user) throw new HttpError(401, 'Incorrect name or password');
    req.session = { userId: user.id };
    res.json({ authenticated: true, user } satisfies MeResponse);
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.json({ authenticated: false } satisfies MeResponse);
  });

  router.get('/me', (req, res) => {
    const user = typeof req.session?.userId === 'number' ? getUser(ctx.db, req.session.userId) : null;
    const body: MeResponse = user
      ? { authenticated: true, user: { id: user.id, name: user.name, createdAt: user.createdAt } }
      : { authenticated: false };
    res.json(body);
  });

  return router;
}

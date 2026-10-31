import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { loginSchema, type MeResponse, type Role } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { authenticate, getUser } from '../users';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in person, set by requireAuth. */
      user?: { id: number; name: string; role: Role; activeTaxYearId: number | null; mustChangePassword: boolean };
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

/**
 * Until someone with the default password has chosen their own, they can do
 * nothing but that. Mounted on /api after requireAuth; signing out is under /api/auth.
 */
export const passwordChangeGuard: RequestHandler = (req, _res, next) => {
  if (!req.user?.mustChangePassword) return next();
  if (req.method === 'PUT' && req.path === `/users/${req.user.id}`) return next();
  next(new HttpError(403, 'Choose a new password before carrying on.'));
};

/** Backup downloads are for editors only: a backup is a full copy of the books, more than viewing and exporting. */
const EDITOR_ONLY_DOWNLOADS = [/^\/backup\.(sql|zip)$/, /^\/backup\/auto(\/|$)/];

/** Changes a read-only person may still make, which only affect themselves. */
const READ_ONLY_ALLOWED = [
  { method: 'PUT', path: /^\/tax-years\/active$/ },
  // Changing their own password; the users router checks it's their own and nothing else.
  { method: 'PUT', path: /^\/users\/\d+$/ },
];

/** Refuses changes (and backup downloads) from read-only people. Mounted on /api after requireAuth. */
export const readOnlyGuard: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'viewer') return next();
  const reading = req.method === 'GET' || req.method === 'HEAD';
  if (reading && !EDITOR_ONLY_DOWNLOADS.some((p) => p.test(req.path))) return next();
  if (!reading && READ_ONLY_ALLOWED.some((a) => a.method === req.method && a.path.test(req.path))) return next();
  next(new HttpError(403, 'Your account is read-only. Ask an editor to make this change.'));
};

export function authRouter(ctx: AppContext): Router {
  const router = Router();

  const meResponse = (userId: number | null): MeResponse => {
    const user = userId === null ? null : getUser(ctx.db, userId);
    return user
      ? {
          authenticated: true,
          user: { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt },
          mustChangePassword: user.mustChangePassword,
        }
      : { authenticated: false };
  };

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
    if (!user) throw new HttpError(401, 'Incorrect username or password');
    req.session = { userId: user.id };
    res.json(meResponse(user.id));
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.json({ authenticated: false } satisfies MeResponse);
  });

  router.get('/me', (req, res) => {
    res.json(meResponse(typeof req.session?.userId === 'number' ? req.session.userId : null));
  });

  return router;
}

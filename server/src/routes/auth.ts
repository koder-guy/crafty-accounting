import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { loginSchema, type MeResponse, type Role } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { authenticate, getUser } from '../users';
import { businessIsSetUp } from '../businessDetails';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in person, set by requireAuth. */
      user?: { id: number; name: string; role: Role; activeTaxYearId: number | null; mustChangePassword: boolean };
    }
  }
}

/**
 * Marks sessions made since the sign-in cookie became a browser-session cookie
 * (no expiry, gone when the browser quits). Cookies from before then kept a
 * 30-day expiry, so they're refused and the person signs in once more.
 * Version 3 also names when the person was added (`since`), see sessionUser.
 */
const SESSION_VERSION = 3;

/**
 * The signed-in person, or null for no session, one from an older version, or one for someone
 * no longer here. A session names the person by id and when they were added: SESSION_SECRET
 * outlives the data (the installers keep it in .env), and a new database's first person has
 * the same id as the last one's, so an old browser's cookie mustn't sign it in as them.
 */
function sessionUser(ctx: AppContext, req: Express.Request) {
  const s = req.session;
  if (s?.v !== SESSION_VERSION || typeof s.userId !== 'number' || typeof s.since !== 'string') return null;
  const user = getUser(ctx.db, s.userId);
  return user && user.createdAt === s.since ? user : null;
}

/** Loads the signed-in user on every request, so a removed user is signed out straight away. */
export function requireAuth(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const user = sessionUser(ctx, req);
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

/** Backup downloads are for editors only: a backup is a full copy of the books, more than viewing and exporting. So is listing Square payouts, which is the start of importing them. */
const EDITOR_ONLY_DOWNLOADS = [/^\/backup\.(sql|zip)$/, /^\/backup\/auto(\/|$)/, /^\/square\/payouts$/];

/** Changes a read-only person may still make, which only affect themselves. */
const READ_ONLY_ALLOWED = [
  { method: 'PUT', path: /^\/tax-years\/active$/ },
  // Changing their own password; the users router checks it's their own and nothing else.
  { method: 'PUT', path: /^\/users\/\d+$/ },
  // Marking their own notifications read.
  { method: 'POST', path: /^\/notifications\/(\d+\/read|read-all)$/ },
];

/** Refuses changes (and backup downloads) from read-only people. Mounted on /api after requireAuth. */
export const readOnlyGuard: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'viewer') return next();
  const reading = req.method === 'GET' || req.method === 'HEAD';
  if (reading && !EDITOR_ONLY_DOWNLOADS.some((p) => p.test(req.path))) return next();
  if (!reading && READ_ONLY_ALLOWED.some((a) => a.method === req.method && a.path.test(req.path))) return next();
  next(new HttpError(403, 'Your account is read-only. Ask an editor to make this change.'));
};

/** Changes allowed before the business is set up: setting it up (or bringing it in), and looking after the people who sign in. */
const BEFORE_SETUP_ALLOWED = [
  { method: 'PUT', path: /^\/business$/ },
  { method: 'POST', path: /^\/sample-data$/ },
  { method: 'POST', path: /^\/restore$/ },
  { method: 'POST', path: /^\/backup\/auto\/files\/[^/]+\/restore$/ },
  { method: '*', path: /^\/users(\/|$)/ },
  { method: 'PUT', path: /^\/tax-years\/active$/ },
  { method: 'POST', path: /^\/notifications\/(\d+\/read|read-all)$/ },
];

/**
 * Until the business details are saved, nothing else can be changed: the app shows
 * the setup screen instead. Reading is still allowed. Mounted on /api after readOnlyGuard.
 */
export function businessSetupGuard(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (BEFORE_SETUP_ALLOWED.some((a) => (a.method === '*' || a.method === req.method) && a.path.test(req.path))) return next();
    if (businessIsSetUp(ctx.db)) return next();
    next(new HttpError(403, 'Set up your business details first, in Settings → Business Details.'));
  };
}

export function authRouter(ctx: AppContext): Router {
  const router = Router();

  const meResponse = (user: ReturnType<typeof getUser>): MeResponse => {
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
    req.session = { userId: user.id, since: user.createdAt, v: SESSION_VERSION };
    res.json(meResponse(getUser(ctx.db, user.id)));
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.json({ authenticated: false } satisfies MeResponse);
  });

  router.get('/me', (req, res) => {
    const user = sessionUser(ctx, req);
    if (!user && req.session?.userId !== undefined) req.session = null;
    res.json(meResponse(user));
  });

  return router;
}

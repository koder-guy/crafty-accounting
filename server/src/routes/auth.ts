import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { loginSchema } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.session?.authenticated) next();
  else next(new HttpError(401, 'Please sign in'));
};

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const expected = digest(ctx.config.adminPassword);

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
    const { password } = parseWith(loginSchema, req.body);
    if (!crypto.timingSafeEqual(digest(password), expected)) {
      throw new HttpError(401, 'Incorrect password');
    }
    req.session = { authenticated: true };
    res.json({ authenticated: true });
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.json({ authenticated: false });
  });

  router.get('/me', (req, res) => {
    res.json({ authenticated: Boolean(req.session?.authenticated) });
  });

  return router;
}

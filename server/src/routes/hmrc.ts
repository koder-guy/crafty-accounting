// Settings → HMRC: the National Insurance number and the connection (OAuth
// sign-in) used to talk to HMRC's Making Tax Digital APIs.
import { Router, type Request } from 'express';
import { hmrcNinoInputSchema, type HmrcStatus } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { clearHmrcTokens, completeHmrcAuth, getHmrcConnection, setHmrcNino, startHmrcAuth, type PendingHmrcAuth } from '../hmrc';

/** Where people land after signing in to HMRC, with the outcome in the query string. */
const SETTINGS_PAGE = '/settings/hmrc';

export function hmrcRouter(ctx: AppContext): Router {
  const router = Router();
  const environment = () => ctx.config.hmrc.environment;

  // The redirect URI must match one registered with the HMRC app exactly, so
  // HMRC_REDIRECT_URI can fix it when the address seen here differs (an unusual proxy).
  const redirectUri = (req: Request) => ctx.config.hmrc.redirectUri ?? `${req.protocol}://${req.get('host')}/api/hmrc/callback`;

  router.get('/', (req, res) => {
    const row = getHmrcConnection(ctx.db, environment());
    const status: HmrcStatus = {
      environment: environment(),
      configured: Boolean(ctx.config.hmrc.clientId && ctx.config.hmrc.clientSecret),
      redirectUri: redirectUri(req),
      nino: row?.nino ?? null,
      connection:
        row?.refresh_token && row.connected_by && row.connected_at && row.refresh_expires_at
          ? { connectedBy: row.connected_by, connectedAt: row.connected_at, expiresAt: row.refresh_expires_at }
          : null,
    };
    res.json(status);
  });

  router.put('/nino', (req, res) => {
    const { nino } = parseWith(hmrcNinoInputSchema, req.body);
    setHmrcNino(ctx.db, environment(), nino);
    res.json({ nino });
  });

  router.post('/connect', (req, res) => {
    const { url, pending } = startHmrcAuth(ctx, redirectUri(req));
    req.session!.hmrcAuth = pending;
    res.json({ url });
  });

  // HMRC sends the browser back here after sign-in. It's a page visit, not an
  // API call, so problems go back to the settings page rather than as JSON.
  router.get('/callback', async (req, res) => {
    const pending = req.session?.hmrcAuth as PendingHmrcAuth | undefined;
    if (req.session) delete req.session.hmrcAuth;
    const back = (params: Record<string, string>) => res.redirect(`${SETTINGS_PAGE}?${new URLSearchParams(params)}`);
    const { code, state, error, error_description: description } = req.query;

    if (req.user!.role === 'viewer') return back({ error: 'Only editors can connect to HMRC.' });
    if (typeof error === 'string') {
      return back({
        error:
          error === 'access_denied'
            ? 'You didn’t give the app authority at HMRC, so nothing changed.'
            : `HMRC sign-in failed: ${typeof description === 'string' ? description : error}`,
      });
    }
    if (!pending || typeof code !== 'string' || state !== pending.state) {
      return back({ error: 'That HMRC sign-in expired or wasn’t started here. Try connecting again.' });
    }
    try {
      await completeHmrcAuth(ctx, pending, code, req.user!.name);
    } catch (err) {
      return back({ error: err instanceof HttpError ? err.message : 'Could not finish connecting to HMRC.' });
    }
    // A GET isn't broadcast automatically, so tell the other open browsers here.
    ctx.liveUpdates.publish({ area: 'hmrc', by: req.user!.name }, null);
    back({ connected: '1' });
  });

  router.delete('/connection', (_req, res) => {
    clearHmrcTokens(ctx.db, environment());
    res.status(204).end();
  });

  return router;
}

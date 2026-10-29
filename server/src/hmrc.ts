// The connection to HMRC's APIs for Making Tax Digital: OAuth 2.0 sign-in
// (authorisation code with PKCE), and access tokens that refresh themselves.
// See https://developer.service.hmrc.gov.uk/api-documentation/docs/authorisation/user-restricted-endpoints
import crypto from 'node:crypto';
import type { HmrcEnvironment } from '@crafty/shared';
import type { AppContext } from './context';
import type { Db } from './db';
import { HttpError } from './http';

export const HMRC_HOSTS: Record<HmrcEnvironment, { web: string; api: string }> = {
  sandbox: { web: 'https://test-www.tax.service.gov.uk', api: 'https://test-api.service.hmrc.gov.uk' },
  production: { web: 'https://www.tax.service.gov.uk', api: 'https://api.service.hmrc.gov.uk' },
};

/** Reading obligations and figures, and sending updates, for Income Tax Self Assessment. */
export const HMRC_SCOPE = 'read:self-assessment write:self-assessment';

/** Refresh tokens last 18 months; after that HMRC has to be signed in to again. */
const REFRESH_TOKEN_MONTHS = 18;
/** Refresh access tokens this long before they expire, so a call doesn't race the expiry. */
const REFRESH_MARGIN_MS = 60 * 1000;

export interface HmrcConnectionRow {
  environment: HmrcEnvironment;
  nino: string | null;
  access_token: string | null;
  refresh_token: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  scope: string | null;
  connected_by: string | null;
  connected_at: string | null;
}

export function getHmrcConnection(db: Db, environment: HmrcEnvironment): HmrcConnectionRow | null {
  return (db.prepare('SELECT * FROM hmrc_connections WHERE environment = ?').get(environment) as HmrcConnectionRow | undefined) ?? null;
}

export function setHmrcNino(db: Db, environment: HmrcEnvironment, nino: string | null): void {
  db.prepare(
    `INSERT INTO hmrc_connections (environment, nino) VALUES (?, ?)
     ON CONFLICT (environment) DO UPDATE SET nino = excluded.nino, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(environment, nino);
}

/** Forgets the tokens. HMRC keeps the authority until it's removed in the HMRC account or the tokens expire. */
export function clearHmrcTokens(db: Db, environment: HmrcEnvironment): void {
  db.prepare(
    `UPDATE hmrc_connections SET access_token = NULL, refresh_token = NULL, access_expires_at = NULL, refresh_expires_at = NULL,
       scope = NULL, connected_by = NULL, connected_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE environment = ?`,
  ).run(environment);
}

const base64Url = (bytes: Buffer) => bytes.toString('base64url');

/** What the browser keeps (in its signed session cookie) between starting a sign-in and HMRC sending it back. */
export interface PendingHmrcAuth {
  state: string;
  verifier: string;
  redirectUri: string;
  environment: HmrcEnvironment;
}

/** Starts a sign-in: returns HMRC's page to send the browser to and what to check when it comes back. */
export function startHmrcAuth(ctx: AppContext, redirectUri: string): { url: string; pending: PendingHmrcAuth } {
  const { environment, clientId } = ctx.config.hmrc;
  if (!clientId) throw new HttpError(400, 'Set HMRC_CLIENT_ID and HMRC_CLIENT_SECRET before connecting to HMRC');
  const pending: PendingHmrcAuth = {
    state: base64Url(crypto.randomBytes(16)),
    verifier: base64Url(crypto.randomBytes(32)),
    redirectUri,
    environment,
  };
  const url = new URL('/oauth/authorize', HMRC_HOSTS[environment].web);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: HMRC_SCOPE,
    state: pending.state,
    redirect_uri: redirectUri,
    code_challenge: base64Url(crypto.createHash('sha256').update(pending.verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), pending };
}

/** HMRC refused the refresh token or code: it has expired or been revoked, so HMRC needs signing in to again. */
class HmrcGrantRefused extends HttpError {
  constructor() {
    super(400, 'HMRC no longer accepts this sign-in. Connect to HMRC again.');
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

/** Posts to HMRC's token endpoint. A refused grant (expired or revoked) is an HttpError the person can act on. */
async function requestTokens(ctx: AppContext, fields: Record<string, string>): Promise<TokenResponse> {
  const { environment, clientId, clientSecret } = ctx.config.hmrc;
  if (!clientId || !clientSecret) throw new HttpError(400, 'Set HMRC_CLIENT_ID and HMRC_CLIENT_SECRET before connecting to HMRC');
  let res: Response;
  try {
    res = await ctx.fetch(`${HMRC_HOSTS[environment].api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }).toString(),
    });
  } catch {
    throw new HttpError(502, 'Could not reach HMRC. Check the server is online and try again.');
  }
  const body = (await res.json().catch(() => null)) as (Partial<TokenResponse> & { error?: string; error_description?: string }) | null;
  if (!res.ok || !body?.access_token || !body.refresh_token || typeof body.expires_in !== 'number') {
    if (body?.error === 'invalid_grant') throw new HmrcGrantRefused();
    if (body?.error === 'invalid_client') throw new HttpError(400, 'HMRC did not accept HMRC_CLIENT_ID and HMRC_CLIENT_SECRET.');
    throw new HttpError(502, `HMRC refused the sign-in${body?.error_description ? `: ${body.error_description}` : ` (${res.status})`}`);
  }
  return body as TokenResponse;
}

function saveTokens(db: Db, environment: HmrcEnvironment, tokens: TokenResponse, now: Date, connectedBy?: string): void {
  const accessExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
  if (connectedBy) {
    const refreshExpires = new Date(now);
    refreshExpires.setUTCMonth(refreshExpires.getUTCMonth() + REFRESH_TOKEN_MONTHS);
    db.prepare(
      `INSERT INTO hmrc_connections (environment, access_token, refresh_token, access_expires_at, refresh_expires_at, scope, connected_by, connected_at)
       VALUES (@environment, @access, @refresh, @accessExpiresAt, @refreshExpiresAt, @scope, @connectedBy, @now)
       ON CONFLICT (environment) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, scope = excluded.scope,
         connected_by = excluded.connected_by, connected_at = excluded.connected_at, updated_at = excluded.connected_at`,
    ).run({
      environment,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      accessExpiresAt,
      refreshExpiresAt: refreshExpires.toISOString(),
      scope: tokens.scope ?? HMRC_SCOPE,
      connectedBy,
      now: now.toISOString(),
    });
  } else {
    // A refresh gives a new refresh token too, but HMRC keeps the original 18 month limit.
    db.prepare(
      `UPDATE hmrc_connections SET access_token = ?, refresh_token = ?, access_expires_at = ?, updated_at = ? WHERE environment = ?`,
    ).run(tokens.access_token, tokens.refresh_token, accessExpiresAt, now.toISOString(), environment);
  }
}

/** Finishes a sign-in: swaps the code HMRC sent back for tokens and stores them. */
export async function completeHmrcAuth(ctx: AppContext, pending: PendingHmrcAuth, code: string, connectedBy: string): Promise<void> {
  if (pending.environment !== ctx.config.hmrc.environment) throw new HttpError(400, 'The HMRC service changed during sign-in. Try again.');
  const tokens = await requestTokens(ctx, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  saveTokens(ctx.db, pending.environment, tokens, new Date(), connectedBy);
}

// Refreshing replaces both tokens, so two calls refreshing at once would leave
// one with a dead token. Calls that arrive during a refresh wait for it.
const refreshing = new WeakMap<AppContext, Promise<string>>();

/** An access token for HMRC's APIs, refreshed first if it has expired (or is about to). */
export function hmrcAccessToken(ctx: AppContext, now = new Date()): Promise<string> {
  const environment = ctx.config.hmrc.environment;
  const row = getHmrcConnection(ctx.db, environment);
  if (!row?.access_token || !row.refresh_token) return Promise.reject(new HttpError(400, 'Connect to HMRC first (Settings → HMRC).'));
  if (row.access_expires_at && new Date(row.access_expires_at).getTime() - REFRESH_MARGIN_MS > now.getTime()) {
    return Promise.resolve(row.access_token);
  }
  const inFlight = refreshing.get(ctx);
  if (inFlight) return inFlight;
  const refresh = requestTokens(ctx, { grant_type: 'refresh_token', refresh_token: row.refresh_token })
    .then((tokens) => {
      saveTokens(ctx.db, environment, tokens, now);
      return tokens.access_token;
    })
    .catch((err) => {
      // Expired or revoked: forget the tokens so the page shows it needs connecting again.
      if (err instanceof HmrcGrantRefused) clearHmrcTokens(ctx.db, environment);
      throw err;
    })
    .finally(() => refreshing.delete(ctx));
  refreshing.set(ctx, refresh);
  return refresh;
}

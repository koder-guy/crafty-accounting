// The connection to HMRC's APIs for Making Tax Digital: OAuth 2.0 sign-in
// (authorisation code with PKCE), and access tokens that refresh themselves.
// See https://developer.service.hmrc.gov.uk/api-documentation/docs/authorisation/user-restricted-endpoints
import crypto from 'node:crypto';
import type { Request } from 'express';
import type { HmrcBusiness, HmrcEnvironment } from '@crafty/shared';
import type { AppContext } from './context';
import type { Db } from './db';
import { fraudPreventionForRequest } from './fraudPrevention';
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
  business_id: string | null;
  trading_name: string | null;
}

export function getHmrcConnection(db: Db, environment: HmrcEnvironment): HmrcConnectionRow | null {
  return (db.prepare('SELECT * FROM hmrc_connections WHERE environment = ?').get(environment) as HmrcConnectionRow | undefined) ?? null;
}

/** Sets the National Insurance number. A different one means a different taxpayer, so the business is forgotten. */
export function setHmrcNino(db: Db, environment: HmrcEnvironment, nino: string | null): void {
  db.prepare(
    `INSERT INTO hmrc_connections (environment, nino) VALUES (?, ?)
     ON CONFLICT (environment) DO UPDATE SET nino = excluded.nino,
       business_id = CASE WHEN nino IS excluded.nino THEN business_id END,
       trading_name = CASE WHEN nino IS excluded.nino THEN trading_name END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(environment, nino);
}

export function setHmrcBusiness(db: Db, environment: HmrcEnvironment, business: HmrcBusiness): void {
  db.prepare(
    `UPDATE hmrc_connections SET business_id = ?, trading_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE environment = ?`,
  ).run(business.businessId, business.tradingName, environment);
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

/** HMRC's error body: a code and message, sometimes with several errors inside. */
interface HmrcErrorBody {
  code?: string;
  message?: string;
  errors?: { code?: string; message?: string }[];
}

/** One of HMRC's APIs. The app must be subscribed to this version of it on HMRC's Developer Hub. */
export interface HmrcApi {
  name: string;
  /** Sent in the Accept header (e.g. "2.0"). */
  version: string;
}

export interface HmrcCall {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  api: HmrcApi;
  query?: Record<string, string>;
  body?: unknown;
  /** Sandbox only: which of HMRC's test scenarios to answer with (Gov-Test-Scenario). */
  testScenario?: string;
}

/**
 * Calls one of HMRC's MTD APIs for the person behind `req`, with a fresh
 * access token and the fraud prevention headers HMRC requires. HMRC's errors
 * become HttpErrors with its message, never 401 (that would sign the person
 * out of this app).
 */
export async function callHmrc<T>(ctx: AppContext, req: Request, call: HmrcCall): Promise<T> {
  return (await callHmrcWithReceipt<T>(ctx, req, call)).body;
}

/** callHmrc, also returning HMRC's correlation id: the only receipt HMRC gives for an update. */
export async function callHmrcWithReceipt<T>(
  ctx: AppContext,
  req: Request,
  call: HmrcCall,
): Promise<{ body: T; correlationId: string | null }> {
  const environment = ctx.config.hmrc.environment;
  const token = await hmrcAccessToken(ctx);
  const url = new URL(call.path, HMRC_HOSTS[environment].api);
  if (call.query) url.search = new URLSearchParams(call.query).toString();
  const headers: Record<string, string> = {
    ...(await fraudPreventionForRequest(req, ctx.config.trustProxy)),
    Accept: `application/vnd.hmrc.${call.api.version}+json`,
    Authorization: `Bearer ${token}`,
  };
  if (call.body !== undefined) headers['Content-Type'] = 'application/json';
  if (call.testScenario && environment === 'sandbox') headers['Gov-Test-Scenario'] = call.testScenario;

  let res: Response;
  try {
    res = await ctx.fetch(url, { method: call.method ?? 'GET', headers, body: call.body === undefined ? undefined : JSON.stringify(call.body) });
  } catch {
    throw new HttpError(502, 'Could not reach HMRC. Check the server is online and try again.');
  }
  const correlationId = res.headers.get('X-CorrelationId');
  if (res.status === 204) return { body: undefined as T, correlationId };
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { body: body as T, correlationId };

  const error = (body ?? {}) as HmrcErrorBody;
  console.warn(`HMRC ${call.method ?? 'GET'} ${call.path} failed: ${res.status} ${error.code ?? ''}${correlationId ? ` (correlation id ${correlationId})` : ''}`);
  if (res.status === 401) {
    clearHmrcTokens(ctx.db, environment);
    throw new HttpError(400, 'HMRC no longer accepts this sign-in. Connect to HMRC again.');
  }
  if (error.code === 'CLIENT_OR_AGENT_NOT_AUTHORISED') {
    throw new HttpError(403, 'HMRC says the person who connected can’t act for this National Insurance number. Check it in Settings → HMRC.');
  }
  if (/not subscribed/i.test(error.message ?? '')) {
    throw new HttpError(
      502,
      `The app isn’t subscribed to HMRC’s ${call.api.name} API, version ${call.api.version}. Subscribe your application to it on HMRC’s Developer Hub, then try again.`,
    );
  }
  const messages = [error.message, ...(error.errors ?? []).map((e) => e.message)].filter(Boolean);
  const detail = messages.length ? messages.join(' ') : `status ${res.status}`;
  throw new HttpError(res.status === 404 ? 404 : 502, `HMRC: ${detail}`);
}

const appTokens = new WeakMap<AppContext, { token: string; until: number }>();

/** A token for HMRC's application-restricted APIs (such as the fraud header test API), which act for the app rather than a person. */
async function hmrcAppToken(ctx: AppContext): Promise<string> {
  const cached = appTokens.get(ctx);
  if (cached && cached.until > Date.now()) return cached.token;
  const { environment, clientId, clientSecret } = ctx.config.hmrc;
  if (!clientId || !clientSecret) throw new HttpError(400, 'Set HMRC_CLIENT_ID and HMRC_CLIENT_SECRET first');
  let res: Response;
  try {
    res = await ctx.fetch(`${HMRC_HOSTS[environment].api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
    });
  } catch {
    throw new HttpError(502, 'Could not reach HMRC. Check the server is online and try again.');
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!res.ok || !body?.access_token) throw new HttpError(502, `HMRC refused the app’s credentials (${res.status})`);
  appTokens.set(ctx, { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 });
  return body.access_token;
}

/** Sends this request's fraud prevention headers to HMRC's sandbox test API and returns its verdict. */
export async function checkFraudHeaders(ctx: AppContext, req: Request): Promise<unknown> {
  if (ctx.config.hmrc.environment !== 'sandbox') throw new HttpError(400, 'HMRC’s fraud header test API is only in the sandbox');
  const token = await hmrcAppToken(ctx);
  let res: Response;
  try {
    res = await ctx.fetch(`${HMRC_HOSTS.sandbox.api}/test/fraud-prevention-headers/validate`, {
      headers: {
        ...(await fraudPreventionForRequest(req, ctx.config.trustProxy)),
        Accept: 'application/vnd.hmrc.1.0+json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new HttpError(502, 'Could not reach HMRC. Check the server is online and try again.');
  }
  const body = (await res.json().catch(() => null)) as HmrcErrorBody | null;
  if (!res.ok) {
    throw new HttpError(502, `HMRC’s fraud header test API refused the request: ${body?.message ?? res.status}. Is the app subscribed to it?`);
  }
  return body;
}

// Settings → HMRC: the National Insurance number and the connection (OAuth
// sign-in) used to talk to HMRC's Making Tax Digital APIs, the business that
// updates are for, and HMRC's obligations (the updates it expects).
import { isDeepStrictEqual } from 'node:util';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  MTD_FIRST_SEND_YEAR,
  mtdEarliestSendDate,
  mtdPayload,
  startYearFromLabel,
  todayIso,
  hmrcBusinessSchema,
  hmrcNinoInputSchema,
  type HmrcBusiness,
  type HmrcFraudHeaderCheck,
  type HmrcObligation,
  type HmrcStatus,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseId, parseWith } from '../http';
import {
  callHmrc,
  callHmrcWithReceipt,
  checkFraudHeaders,
  clearHmrcTokens,
  completeHmrcAuth,
  getHmrcConnection,
  setHmrcBusiness,
  setHmrcNino,
  startHmrcAuth,
  type PendingHmrcAuth,
} from '../hmrc';
import { getTaxYear } from '../repo';
import { getSubmissions, parseQuarter, quarterSummaries } from './mtd';

const BUSINESS_DETAILS_VERSION = '2.0';
const OBLIGATIONS_VERSION = '3.0';
const SELF_EMPLOYMENT_VERSION = '5.0';

/** The update as the person saw it before confirming, so it's only sent if the figures haven't changed since. */
const sendSchema = z.object({ payload: z.unknown() });

const obligationsQuerySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

interface ListBusinessesResponse {
  listOfBusinesses?: { typeOfBusiness: string; businessId: string; tradingName?: string }[];
}

interface ObligationsResponse {
  obligations?: {
    typeOfBusiness: string;
    businessId: string;
    obligationDetails: { periodStartDate: string; periodEndDate: string; dueDate: string; status: string; receivedDate?: string }[];
  }[];
}

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
      business: row?.business_id ? { businessId: row.business_id, tradingName: row.trading_name } : null,
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

  /** The National Insurance number, or a clear error if it isn't set yet. */
  const requireNino = () => {
    const nino = getHmrcConnection(ctx.db, environment())?.nino;
    if (!nino) throw new HttpError(400, 'Enter the National Insurance number in Settings → HMRC first.');
    return nino;
  };

  // Asks HMRC for the self-employment businesses; if there's just one, it's the one.
  router.post('/businesses/find', async (req, res) => {
    const nino = requireNino();
    let found: ListBusinessesResponse;
    try {
      found = await callHmrc<ListBusinessesResponse>(ctx, req, {
        path: `/individuals/business/details/${nino}/list`,
        version: BUSINESS_DETAILS_VERSION,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) found = {};
      else throw err;
    }
    const businesses: HmrcBusiness[] = (found.listOfBusinesses ?? [])
      .filter((b) => b.typeOfBusiness === 'self-employment')
      .map((b) => ({ businessId: b.businessId, tradingName: b.tradingName?.trim() || null }));
    if (businesses.length === 1) setHmrcBusiness(ctx.db, environment(), businesses[0]);
    res.json({ businesses });
  });

  router.put('/business', (req, res) => {
    requireNino();
    const business = parseWith(hmrcBusinessSchema, req.body);
    setHmrcBusiness(ctx.db, environment(), business);
    res.json(business);
  });

  // The quarterly updates HMRC expects for the business in a tax year, and which it has received.
  router.get('/obligations', async (req, res) => {
    const { taxYearId } = parseWith(obligationsQuerySchema, req.query);
    const taxYear = getTaxYear(ctx.db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    const nino = requireNino();
    const businessId = getHmrcConnection(ctx.db, environment())?.business_id;
    if (!businessId) throw new HttpError(400, 'Find your business in Settings → HMRC first.');

    let found: ObligationsResponse;
    try {
      found = await callHmrc<ObligationsResponse>(ctx, req, {
        path: `/obligations/details/${nino}/income-and-expenditure`,
        version: OBLIGATIONS_VERSION,
        query: { typeOfBusiness: 'self-employment', businessId, fromDate: taxYear.startDate, toDate: taxYear.endDate },
        // The sandbox's default answer is fixed 2018-19 test data; DYNAMIC answers for the dates asked.
        testScenario: 'DYNAMIC',
      });
    } catch (err) {
      // HMRC answers 404 when there are no obligations in the range.
      if (err instanceof HttpError && err.status === 404) found = {};
      else throw err;
    }
    const obligations: HmrcObligation[] = (found.obligations ?? [])
      .filter((o) => o.businessId === businessId)
      .flatMap((o) => o.obligationDetails)
      .map((d): HmrcObligation => ({
        periodStartDate: d.periodStartDate,
        periodEndDate: d.periodEndDate,
        dueDate: d.dueDate,
        status: d.status.toLowerCase() === 'fulfilled' ? 'fulfilled' : 'open',
        receivedDate: d.receivedDate ?? null,
      }))
      .sort((a, b) => a.periodEndDate.localeCompare(b.periodEndDate));
    res.json(obligations);
  });

  // Sends a quarter's year-to-date figures to HMRC as a cumulative period
  // summary. Sending again replaces what HMRC has (HMRC refuses if a later
  // quarter has been sent since).
  router.post('/quarters/:taxYearId/:quarter/send', async (req, res) => {
    const taxYearId = parseId(req.params.taxYearId);
    const quarter = parseQuarter(req.params.quarter);
    const taxYear = getTaxYear(ctx.db, taxYearId);
    if (!taxYear) throw new HttpError(404, 'Tax year not found');
    const startYear = startYearFromLabel(taxYear.label)!;
    if (startYear < MTD_FIRST_SEND_YEAR) throw new HttpError(400, 'Quarterly updates can only be sent to HMRC from the 2025/26 tax year.');
    const nino = requireNino();
    const businessId = getHmrcConnection(ctx.db, environment())?.business_id;
    if (!businessId) throw new HttpError(400, 'Find your business in Settings → HMRC first.');

    const q = quarterSummaries(ctx.db, taxYear).find((x) => x.quarter === quarter)!;
    if (todayIso() < mtdEarliestSendDate(q)) {
      throw new HttpError(400, `HMRC won’t take this update until ${mtdEarliestSendDate(q)}, 10 days before the quarter ends.`);
    }
    const payload = mtdPayload(q.cumulative, taxYear.startDate, q.endDate);
    if (!isDeepStrictEqual(parseWith(sendSchema, req.body).payload, payload)) {
      throw new HttpError(409, 'The figures have changed since you checked them. Check them again before sending.');
    }

    const { correlationId } = await callHmrcWithReceipt(ctx, req, {
      method: 'PUT',
      path: `/individuals/business/self-employment/${nino}/${businessId}/cumulative/${taxYear.label}`,
      version: SELF_EMPLOYMENT_VERSION,
      body: payload,
    });
    const sentAt = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on, sent_by, sent_at, sent_environment, correlation_id, sent_payload)
         VALUES (@taxYearId, @quarter, @submittedOn, @by, @sentAt, @environment, @correlationId, @payload)
         ON CONFLICT (tax_year_id, quarter) DO UPDATE SET submitted_on = excluded.submitted_on, sent_by = excluded.sent_by,
           sent_at = excluded.sent_at, sent_environment = excluded.sent_environment, correlation_id = excluded.correlation_id,
           sent_payload = excluded.sent_payload`,
      )
      .run({
        taxYearId,
        quarter,
        submittedOn: todayIso(),
        by: req.user!.name,
        sentAt,
        environment: environment(),
        correlationId,
        payload: JSON.stringify(payload),
      });
    res.json(getSubmissions(ctx.db, taxYearId).get(quarter));
  });

  router.get('/fraud-headers/check', async (req, res) => {
    const result = (await checkFraudHeaders(ctx, req)) as Partial<HmrcFraudHeaderCheck>;
    const check: HmrcFraudHeaderCheck = {
      code: result.code ?? 'UNKNOWN',
      message: result.message ?? '',
      errors: result.errors ?? [],
      warnings: result.warnings ?? [],
    };
    res.json(check);
  });

  router.delete('/connection', (_req, res) => {
    clearHmrcTokens(ctx.db, environment());
    res.status(204).end();
  });

  return router;
}

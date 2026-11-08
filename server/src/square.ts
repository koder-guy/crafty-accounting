// The Square connection (one row in square_settings; the token is never sent to a browser) and
// importing Square's payouts. Calls go through ctx.fetch, which tests replace.
//
// Each payout becomes one income of the card sales it paid out, before Square's fees and less
// refunds, plus one expense for the fees, so turnover is the whole of the sales and income less
// the fees is what reached the bank. Both are dated the day of the sales (the cash basis counts
// money as received when Square takes it for you), paid by bank transfer. A payout holding
// anything else (holds, adjustments, chargebacks, loan repayments) is left to add by hand.
import {
  displayTaxYear,
  formatDisplayDate,
  formatGBP,
  isDateInTaxYear,
  SQUARE_FEES_DESCRIPTION,
  SQUARE_INCOME_DESCRIPTION,
  SQUARE_PAYEE,
  squareFeeCategory,
  squareIncomeCategory,
  squareTokenHint,
  type Category,
  type SquareEnvironment,
  type SquareImportResult,
  type SquarePayout,
  type SquareStatus,
  type TaxYear,
} from '@crafty/shared';
import type { AppContext } from './context';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Db } from './db';
import { documentPath, ensureSpaceFor, removeDocumentFile } from './documents';
import { HttpError } from './http';
import { insertExpense, insertIncome, isDocumentNameInUse, listCategories, listTaxYears } from './repo';
import { entryTypeName, londonDateTime, payoutStatementPdf, type PayoutStatement, type StatementPayment } from './squareStatement';

const API_BASE: Record<SquareEnvironment, string> = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};
/** The API version the calls are written for. */
export const SQUARE_VERSION = '2025-01-23';
/** Payout entries fetched at once. */
const CONCURRENCY = 4;
const TIME_ZONE = 'Europe/London';

// ---- Settings ----

interface Row {
  access_token: string | null;
  environment: SquareEnvironment;
  merchant_name: string | null;
  token_added_by: string | null;
  token_added_at: string | null;
  income_category_id: number | null;
  fee_category_id: number | null;
}

export interface SquareSettings {
  accessToken: string | null;
  environment: SquareEnvironment;
  merchantName: string | null;
  tokenAddedBy: string | null;
  tokenAddedAt: string | null;
  incomeCategory: Category;
  feeCategory: Category;
  incomeCategoryAutomatic: boolean;
  feeCategoryAutomatic: boolean;
}

/**
 * The saved category if it's still there and of the right kind (a restore can take a custom one
 * away), else the standard one.
 */
function savedCategory(categories: Category[], savedId: number | null, type: Category['type']): Category | null {
  return categories.find((c) => c.id === savedId && c.type === type && c.hmrcCode !== 'depreciation') ?? null;
}

const standardCategory = (categories: Category[], type: Category['type'], code: string): Category =>
  categories.find((c) => c.type === type && !c.isCustom && c.hmrcCode === code)!;

export function getSquareSettings(db: Db): SquareSettings {
  const row = db.prepare('SELECT * FROM square_settings WHERE id = 1').get() as Row | undefined;
  const categories = listCategories(db);
  const token = row?.access_token ?? null;
  const savedIncome = savedCategory(categories, row?.income_category_id ?? null, 'INCOME');
  const savedFee = savedCategory(categories, row?.fee_category_id ?? null, 'EXPENSE');
  return {
    accessToken: token,
    environment: row?.environment ?? 'production',
    merchantName: token ? (row?.merchant_name ?? null) : null,
    tokenAddedBy: token ? (row?.token_added_by ?? null) : null,
    tokenAddedAt: token ? (row?.token_added_at ?? null) : null,
    // Unless one is chosen, a custom category named for Square's sales, else the standard one.
    incomeCategory: savedIncome ?? squareIncomeCategory(categories) ?? standardCategory(categories, 'INCOME', 'turnover'),
    // Unless one is chosen, a custom category named for Square's fees, else the standard one.
    feeCategory: savedFee ?? squareFeeCategory(categories) ?? standardCategory(categories, 'EXPENSE', 'financeCharges'),
    incomeCategoryAutomatic: savedIncome === null,
    feeCategoryAutomatic: savedFee === null,
  };
}

export function squareStatus(db: Db): SquareStatus {
  const s = getSquareSettings(db);
  return {
    configured: s.accessToken !== null,
    tokenHint: s.accessToken ? squareTokenHint(s.accessToken) : null,
    environment: s.environment,
    merchantName: s.merchantName,
    tokenAddedBy: s.tokenAddedBy,
    tokenAddedAt: s.tokenAddedAt,
    incomeCategoryId: s.incomeCategory.id,
    feeCategoryId: s.feeCategory.id,
    incomeCategoryAutomatic: s.incomeCategoryAutomatic,
    feeCategoryAutomatic: s.feeCategoryAutomatic,
  };
}

const ensureRow = (db: Db) => db.prepare('INSERT OR IGNORE INTO square_settings (id) VALUES (1)').run();

export function saveSquareToken(db: Db, token: string, environment: SquareEnvironment, merchantName: string | null, by: string): void {
  ensureRow(db);
  db.prepare(
    "UPDATE square_settings SET access_token = ?, environment = ?, merchant_name = ?, token_added_by = ?, token_added_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1",
  ).run(token, environment, merchantName, by);
}

/** Null goes back to choosing automatically. */
export function saveSquareCategory(db: Db, kind: 'income' | 'fee', categoryId: number | null): void {
  const column = kind === 'income' ? 'income_category_id' : 'fee_category_id';
  if (categoryId === null) {
    ensureRow(db);
    db.prepare(`UPDATE square_settings SET ${column} = NULL WHERE id = 1`).run();
    return;
  }
  const category = listCategories(db).find((c) => c.id === categoryId);
  const type = kind === 'income' ? 'INCOME' : 'EXPENSE';
  if (!category || category.type !== type) throw new HttpError(422, `Choose an ${kind === 'income' ? 'income' : 'expense'} category`);
  if (category.hmrcCode === 'depreciation') throw new HttpError(422, 'Fees can’t go under depreciation');
  ensureRow(db);
  db.prepare(`UPDATE square_settings SET ${column} = ? WHERE id = 1`).run(categoryId);
}

export function removeSquareToken(db: Db): void {
  db.prepare('UPDATE square_settings SET access_token = NULL, merchant_name = NULL, token_added_by = NULL, token_added_at = NULL WHERE id = 1').run();
}

// ---- Calling Square ----

interface Money {
  amount: number;
  currency_code: string;
}

export interface SquarePayoutData {
  id: string;
  status: string;
  location_id?: string;
  amount_money?: Money;
  arrival_date?: string;
  payout_fee?: { amount_money?: Money }[];
}

export interface SquarePayoutEntry {
  id: string;
  type: string;
  effective_at?: string;
  gross_amount_money?: Money;
  fee_amount_money?: Money;
  net_amount_money?: Money;
  type_charge_details?: { payment_id?: string };
  type_refund_details?: { payment_id?: string };
}

interface SquarePaymentData {
  id: string;
  receipt_number?: string;
  receipt_url?: string;
  card_details?: { card?: { card_brand?: string; last_4?: string } };
}

async function callSquare<T>(ctx: AppContext, token: string, environment: SquareEnvironment, path: string, query: Record<string, string | undefined> = {}): Promise<T> {
  const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  const url = `${ctx.config.squareApiUrl ?? API_BASE[environment]}${path}${params.size ? `?${params}` : ''}`;
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(502, 'Couldn’t reach Square. Check the server is online.');
  }
  const body = (await res.json().catch(() => null)) as { errors?: { code?: string; detail?: string }[] } | null;
  if (res.ok && body) return body as T;
  const detail = body?.errors?.[0]?.detail;
  // Never 401 to the browser, which would sign the person out.
  if (res.status === 401) {
    throw new HttpError(422, `Square didn’t accept the access token${environment === 'sandbox' ? ' as a sandbox token' : ''}. Check you copied all of it, and that it’s a ${environment} token.`);
  }
  if (res.status === 403) throw new HttpError(422, `Square refused: the access token can’t read ${path.includes('payout') ? 'payouts' : 'the account'}.${detail ? ` (${detail})` : ''}`);
  if (res.status === 404) throw new HttpError(404, 'Square has no record of that.');
  if (res.status === 429) throw new HttpError(503, 'Square is busy. Try again in a minute.');
  throw new HttpError(502, `Square gave an error${detail ? `: ${detail}` : ` (${res.status})`}.`);
}

/** Checks a token with Square and returns the business's name. Books are in pounds, so a Square account in another currency is refused. */
export async function checkSquareToken(ctx: AppContext, token: string, environment: SquareEnvironment): Promise<string | null> {
  const { merchant } = await callSquare<{ merchant?: { business_name?: string; currency?: string } }>(ctx, token, environment, '/v2/merchants/me');
  if (merchant?.currency && merchant.currency !== 'GBP') {
    throw new HttpError(422, `That Square account takes payments in ${merchant.currency}. These books are kept in pounds.`);
  }
  return merchant?.business_name ?? null;
}

function requireToken(ctx: AppContext): { token: string; environment: SquareEnvironment } {
  const s = getSquareSettings(ctx.db);
  if (!s.accessToken) throw new HttpError(404, 'Square isn’t connected. Add an access token in Settings → Square Integration.');
  return { token: s.accessToken, environment: s.environment };
}

async function listLocationIds(ctx: AppContext, token: string, environment: SquareEnvironment): Promise<string[]> {
  const { locations } = await callSquare<{ locations?: { id: string }[] }>(ctx, token, environment, '/v2/locations');
  return (locations ?? []).map((l) => l.id);
}

/** Days after a tax year ends that a payout for its last sales may still be made (bank holidays at Easter). */
const PAYOUT_LAG_DAYS = 14;

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Payouts that could hold a tax year's sales: made from its first day until a little after its
 * last, for every location (Square lists only the main one unless asked), newest first.
 */
async function fetchPayouts(ctx: AppContext, token: string, environment: SquareEnvironment, year: TaxYear): Promise<SquarePayoutData[]> {
  const payouts = new Map<string, SquarePayoutData>();
  for (const locationId of await listLocationIds(ctx, token, environment)) {
    let cursor: string | undefined;
    do {
      const page = await callSquare<{ payouts?: SquarePayoutData[]; cursor?: string }>(ctx, token, environment, '/v2/payouts', {
        location_id: locationId,
        begin_time: `${year.startDate}T00:00:00Z`,
        end_time: `${addDays(year.endDate, PAYOUT_LAG_DAYS + 1)}T00:00:00Z`,
        sort_order: 'DESC',
        limit: '100',
        cursor,
      });
      for (const p of page.payouts ?? []) payouts.set(p.id, p);
      cursor = page.cursor || undefined;
    } while (cursor);
  }
  // Only money that has gone to the bank; a failed payout is paid again later as a new one.
  return [...payouts.values()]
    .filter((p) => (p.status === 'SENT' || p.status === 'PAID') && p.arrival_date)
    .sort((a, b) => b.arrival_date!.localeCompare(a.arrival_date!) || b.id.localeCompare(a.id));
}

async function fetchEntries(ctx: AppContext, token: string, environment: SquareEnvironment, payoutId: string): Promise<SquarePayoutEntry[]> {
  const entries: SquarePayoutEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await callSquare<{ payout_entries?: SquarePayoutEntry[]; cursor?: string }>(
      ctx,
      token,
      environment,
      `/v2/payouts/${encodeURIComponent(payoutId)}/payout-entries`,
      { limit: '100', cursor },
    );
    entries.push(...(page.payout_entries ?? []));
    cursor = page.cursor || undefined;
  } while (cursor);
  return entries;
}

/** Runs `work` over the items a few at a time, keeping their order. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) results.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(work))));
  return results;
}

// ---- Payout statements ----

/** Payments looked up one by one when the listing missed them (refunds of older sales), at most. */
const MAX_SINGLE_PAYMENTS = 20;

const paymentIdOf = (e: SquarePayoutEntry) => e.type_charge_details?.payment_id ?? e.type_refund_details?.payment_id;

const CARD_BRANDS: Record<string, string> = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMERICAN_EXPRESS: 'Amex', MAESTRO: 'Maestro', DISCOVER: 'Discover' };

function statementPayment(p: SquarePaymentData): StatementPayment {
  const card = p.card_details?.card;
  const brand = card?.card_brand ? (CARD_BRANDS[card.card_brand] ?? entryTypeName(card.card_brand)) : null;
  const last4 = card?.last_4 ? `•••• ${card.last_4}` : null;
  return {
    receiptNumber: p.receipt_number ?? null,
    receiptUrl: p.receipt_url ?? null,
    card: brand || last4 ? [brand, last4].filter(Boolean).join(' ') : null,
  };
}

/**
 * The payments behind a payout's sales and refunds, for their receipt numbers: listed for the
 * days of its entries, then any missed (a refund of an older sale) one by one. Only for the
 * statement, so a token that can't read payments just leaves them out (null).
 */
async function fetchPayments(
  ctx: AppContext,
  token: string,
  environment: SquareEnvironment,
  payout: SquarePayoutData,
  entries: SquarePayoutEntry[],
): Promise<Map<string, StatementPayment> | null> {
  const wanted = new Set(entries.map(paymentIdOf).filter((id): id is string => !!id));
  const found = new Map<string, StatementPayment>();
  if (wanted.size === 0) return found;
  const times = entries
    .map((e) => e.effective_at)
    .filter((t): t is string => !!t)
    .sort();
  try {
    if (times.length) {
      let cursor: string | undefined;
      do {
        const page = await callSquare<{ payments?: SquarePaymentData[]; cursor?: string }>(ctx, token, environment, '/v2/payments', {
          begin_time: new Date(Date.parse(times[0]) - 86_400_000).toISOString(),
          end_time: new Date(Date.parse(times.at(-1)!) + 86_400_000).toISOString(),
          location_id: payout.location_id,
          limit: '100',
          cursor,
        });
        for (const p of page.payments ?? []) if (wanted.has(p.id)) found.set(p.id, statementPayment(p));
        cursor = page.cursor || undefined;
      } while (cursor);
    }
    const missing = [...wanted].filter((id) => !found.has(id)).slice(0, MAX_SINGLE_PAYMENTS);
    await inBatches(missing, async (id) => {
      const reply = await callSquare<{ payment?: SquarePaymentData }>(ctx, token, environment, `/v2/payments/${encodeURIComponent(id)}`).catch(() => null);
      if (reply?.payment) found.set(id, statementPayment(reply.payment));
    });
    return found;
  } catch {
    return null;
  }
}

/** A payout's statement: its entries oldest first, plus the fee taken from the payout itself when it isn't an entry. */
export function buildStatement(
  payout: SquarePayoutData,
  entries: SquarePayoutEntry[],
  payments: Map<string, StatementPayment> | null,
  merchantName: string | null,
  madeOn: string,
): PayoutStatement {
  const figures = payoutFigures(payout, entries);
  const rows = [...entries]
    .sort((a, b) => (a.effective_at ?? '').localeCompare(b.effective_at ?? ''))
    .map((e) => {
      const net = amountOf(e.net_amount_money);
      const fee = amountOf(e.fee_amount_money);
      const id = paymentIdOf(e);
      return {
        when: e.effective_at ? londonDateTime(e.effective_at) : '',
        type: entryTypeName(e.type),
        payment: id ? (payments?.get(id) ?? null) : null,
        grossPence: e.gross_amount_money ? amountOf(e.gross_amount_money) : net + fee,
        feePence: fee,
        netPence: net,
      };
    });
  const difference = figures.netPence - rows.reduce((acc, r) => acc + r.netPence, 0);
  if (difference !== 0) rows.push({ when: '', type: 'Payout fee', payment: null, grossPence: 0, feePence: -difference, netPence: difference });
  return {
    merchantName,
    payoutId: payout.id,
    arrivalDate: payout.arrival_date!,
    netPence: figures.netPence,
    salesPence: figures.incomePence + figures.refundsPence,
    refundsPence: figures.refundsPence,
    incomePence: figures.incomePence,
    feesPence: figures.feesPence,
    rows,
    receiptsRead: rows.some((r) => r.payment?.receiptNumber),
    madeOn,
  };
}

/** The statement's names on the income and on the fee expense (each document has a name of its own), clear of any taken. */
function statementNames(ctx: AppContext, date: string, payoutId: string): { income: string; fees: string } {
  const base = `${date}_Square_payout_${payoutId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const free = (name: string) => !isDocumentNameInUse(ctx.db, name) && !fs.existsSync(documentPath(ctx, name));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const names = { income: `${base}${suffix}.pdf`, fees: `${base}_fees${suffix}.pdf` };
    if (free(names.income) && free(names.fees)) return names;
  }
}

// ---- Working out a payout ----

/** Entries that are Square's charges (or refunds of them) in their own right, rather than taken off a sale. */
const FEE_TYPES = new Set([
  'FEE',
  'DEPOSIT_FEE',
  'DEPOSIT_FEE_REFUND',
  'TAX_ON_FEE',
  'PAID_SERVICE_FEE',
  'PAID_SERVICE_FEE_REFUND',
  'SUBSCRIPTION_FEE',
  'SUBSCRIPTION_FEE_PAID_REFUND',
  'SUBSCRIPTION_FEE_REFUND',
  'THIRD_PARTY_FEE',
  'THIRD_PARTY_FEE_REFUND',
]);

const amountOf = (money: Money | undefined) => money?.amount ?? 0;

/** An instant's date in the UK, where the markets are. */
export const londonDate = (instant: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));

export interface PayoutFigures {
  netPence: number;
  incomePence: number;
  feesPence: number;
  refundsPence: number;
  saleDates: string[];
  problem: string | null;
}

/** What a payout is made of: card sales less refunds, Square's fees, and anything that stops it being imported. */
export function payoutFigures(payout: SquarePayoutData, entries: SquarePayoutEntry[]): PayoutFigures {
  const netPence = amountOf(payout.amount_money);
  let sales = 0;
  let refunds = 0;
  let fees = 0;
  let entriesNet = 0;
  const other = new Map<string, number>();
  const saleDates = new Set<string>();
  let otherCurrency = payout.amount_money !== undefined && payout.amount_money.currency_code !== 'GBP';

  for (const e of entries) {
    for (const m of [e.gross_amount_money, e.fee_amount_money, e.net_amount_money]) if (m && m.currency_code !== 'GBP') otherCurrency = true;
    const net = amountOf(e.net_amount_money);
    entriesNet += net;
    if (FEE_TYPES.has(e.type)) {
      fees -= net;
    } else if (e.type === 'CHARGE' || e.type === 'REFUND') {
      const gross = e.gross_amount_money ? amountOf(e.gross_amount_money) : net + amountOf(e.fee_amount_money);
      // The fee taken off it (or given back with a refund): gross less net, whichever way Square signs it.
      fees += gross - net;
      if (e.type === 'CHARGE') {
        sales += gross;
        if (e.effective_at) saleDates.add(londonDate(e.effective_at));
      } else {
        refunds -= gross;
      }
    } else if (net !== 0) {
      other.set(e.type, (other.get(e.type) ?? 0) + net);
    }
  }
  // A fee for an instant payout may be taken from the payout rather than listed as an entry.
  const payoutFee = (payout.payout_fee ?? []).reduce((acc, f) => acc + amountOf(f.amount_money), 0);
  if (entriesNet !== netPence && payoutFee > 0 && entriesNet - payoutFee === netPence) fees += payoutFee;

  const figures = { netPence, incomePence: sales - refunds, feesPence: fees, refundsPence: refunds, saleDates: [...saleDates].sort() };
  const problem = otherCurrency
    ? 'It isn’t in pounds.'
    : other.size > 0
      ? `It also holds Square adjustments that aren’t sales or fees: ${[...other.entries()].map(([type, pence]) => `${type.toLowerCase().replace(/_/g, ' ')} (${formatGBP(pence)})`).join(', ')}.`
      : figures.incomePence - figures.feesPence !== netPence
        ? `Its sales and fees don’t add up to the ${formatGBP(netPence)} paid.`
        : saleDates.size === 0
          ? 'It has no card sales in it.'
          : figures.incomePence <= 0
            ? 'Its refunds are as much as its sales or more.'
            : figures.feesPence < 0
              ? 'Square gave back more in fees than it took.'
              : null;
  return { ...figures, problem };
}

// ---- Listing and importing ----

interface Imported {
  incomeId: number;
  date: string;
  amountPence: number;
}

/** Payouts already in the books: by the id saved on import, or as the reference of an income (one imported from a JSON export keeps it there). */
function importedPayouts(db: Db, ids: string[]): Map<string, Imported> {
  const found = new Map<string, Imported>();
  if (ids.length === 0) return found;
  const marks = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, date, amount_pence, square_payout_id, reference FROM incomes
       WHERE square_payout_id IN (${marks}) OR (reference IN (${marks}) AND source = ?) ORDER BY id`,
    )
    .all(...ids, ...ids, SQUARE_PAYEE) as { id: number; date: string; amount_pence: number; square_payout_id: string | null; reference: string | null }[];
  for (const r of rows) {
    const payoutId = r.square_payout_id ?? r.reference!;
    if (!found.has(payoutId)) found.set(payoutId, { incomeId: r.id, date: r.date, amountPence: r.amount_pence });
  }
  return found;
}

function possibleDuplicate(db: Db, date: string, amounts: number[]): SquarePayout['possibleDuplicate'] {
  const row = db
    .prepare(
      `SELECT id, description, amount_pence FROM incomes
       WHERE date = ? AND amount_pence IN (${amounts.map(() => '?').join(', ')}) AND square_payout_id IS NULL ORDER BY id LIMIT 1`,
    )
    .get(date, ...amounts) as { id: number; description: string; amount_pence: number } | undefined;
  return row ? { id: row.id, description: row.description, amountPence: row.amount_pence } : null;
}

function describe(ctx: AppContext, payout: SquarePayoutData, entries: SquarePayoutEntry[], taxYears: TaxYear[]): SquarePayout {
  const figures = payoutFigures(payout, entries);
  const saleDate = figures.saleDates.at(-1) ?? null;
  const years = new Set(figures.saleDates.map((d) => taxYears.find((y) => isDateInTaxYear(d, y))?.label ?? null));
  const taxYear = saleDate ? (taxYears.find((y) => isDateInTaxYear(saleDate, y)) ?? null) : null;
  let problem = figures.problem;
  if (!problem && years.size > 1) problem = 'Its sales fall in two tax years.';
  if (!problem && !taxYear) problem = `There’s no tax year for ${formatDisplayDate(saleDate!)}. Add it in Settings → Tax Years first.`;
  return {
    id: payout.id,
    arrivalDate: payout.arrival_date!,
    netPence: figures.netPence,
    incomeId: null,
    saleDate,
    saleDates: figures.saleDates,
    incomePence: figures.incomePence,
    feesPence: figures.feesPence,
    refundsPence: figures.refundsPence,
    taxYearId: taxYear?.id ?? null,
    taxYearLabel: taxYear?.label ?? null,
    problem,
    possibleDuplicate: saleDate && !problem ? possibleDuplicate(ctx.db, saleDate, [figures.incomePence, figures.netPence]) : null,
  };
}

const importedRow = (payout: SquarePayoutData, imported: Imported): SquarePayout => ({
  id: payout.id,
  arrivalDate: payout.arrival_date!,
  netPence: amountOf(payout.amount_money),
  incomeId: imported.incomeId,
  saleDate: imported.date,
  saleDates: [],
  incomePence: imported.amountPence,
  feesPence: 0,
  refundsPence: 0,
  taxYearId: null,
  taxYearLabel: null,
  problem: null,
  possibleDuplicate: null,
});

function findTaxYear(ctx: AppContext, taxYearId: number): TaxYear {
  const year = listTaxYears(ctx.db).find((y) => y.id === taxYearId);
  if (!year) throw new HttpError(404, 'Tax year not found');
  return year;
}

/** The tax year a payout belongs to: its sales' (or, imported, its income's), else the day it reached the bank. */
const belongsTo = (p: SquarePayout, year: TaxYear) => isDateInTaxYear(p.saleDate ?? p.arrivalDate, year);

/**
 * Square's payouts for one tax year's sales, newest first: those already imported, and what
 * importing each of the others would add. A payout early in the year for the last year's sales is
 * left out, and one just after it ends for its last sales is in.
 */
export async function listSquarePayouts(ctx: AppContext, taxYearId: number): Promise<SquarePayout[]> {
  const year = findTaxYear(ctx, taxYearId);
  const { token, environment } = requireToken(ctx);
  const payouts = await fetchPayouts(ctx, token, environment, year);
  const imported = importedPayouts(ctx.db, payouts.map((p) => p.id));
  const taxYears = listTaxYears(ctx.db);
  const listed = await inBatches(payouts, async (p) => {
    const already = imported.get(p.id);
    return already ? importedRow(p, already) : describe(ctx, p, await fetchEntries(ctx, token, environment, p.id), taxYears);
  });
  return listed.filter((p) => belongsTo(p, year));
}

function incomeNotes(p: SquarePayout): string {
  const lines = [`Square paid ${formatGBP(p.netPence)} into the bank on ${formatDisplayDate(p.arrivalDate)}, after ${formatGBP(p.feesPence)} of fees (an expense of their own).`];
  if (p.saleDates.length > 1) lines.push(`Sales on ${p.saleDates.map(formatDisplayDate).join(', ')}.`);
  if (p.refundsPence > 0) lines.push(`Less ${formatGBP(p.refundsPence)} of refunds.`);
  return lines.join('\n');
}

/**
 * Imports the chosen payouts, fetching each from Square again rather than trusting the browser's
 * figures. All or nothing: a payout that can't be imported refuses the lot. One imported already
 * (perhaps from another browser) is left out.
 */
export async function importSquarePayouts(ctx: AppContext, taxYearId: number, payoutIds: string[], by: string): Promise<SquareImportResult> {
  const year = findTaxYear(ctx, taxYearId);
  const { token, environment } = requireToken(ctx);
  const ids = [...new Set(payoutIds)];
  const settings = getSquareSettings(ctx.db);
  const taxYears = listTaxYears(ctx.db);
  const alreadyBefore = importedPayouts(ctx.db, ids);
  const toFetch = ids.filter((id) => !alreadyBefore.has(id));

  const described = await inBatches(toFetch, async (id) => {
    const { payout } = await callSquare<{ payout?: SquarePayoutData }>(ctx, token, environment, `/v2/payouts/${encodeURIComponent(id)}`);
    if (!payout || (payout.status !== 'SENT' && payout.status !== 'PAID') || !payout.arrival_date) {
      throw new HttpError(422, `Nothing was imported. Square payout ${id} hasn’t been paid into the bank.`);
    }
    const entries = await fetchEntries(ctx, token, environment, id);
    return { ...describe(ctx, payout, entries, taxYears), payout, entries };
  });
  const elsewhere = described.find((p) => !belongsTo(p, year));
  if (elsewhere) {
    throw new HttpError(
      422,
      `Nothing was imported. The payout of ${formatGBP(elsewhere.netPence)} on ${formatDisplayDate(elsewhere.arrivalDate)} is for sales outside tax year ${displayTaxYear(year.label)}.`,
    );
  }
  const refused = described.find((p) => p.problem);
  if (refused) {
    throw new HttpError(422, `Nothing was imported. The payout of ${formatGBP(refused.netPence)} on ${formatDisplayDate(refused.arrivalDate)} can’t be imported: ${refused.problem}`);
  }

  // A statement of each payout, attached to its income and its fee expense.
  const today = new Date().toISOString().slice(0, 10);
  const statements = new Map(
    await inBatches(described, async (p) => {
      const payments = await fetchPayments(ctx, token, environment, p.payout, p.entries);
      const pdf = await payoutStatementPdf(buildStatement(p.payout, p.entries, payments, settings.merchantName, today));
      return [p.id, Buffer.from(pdf)] as const;
    }),
  );
  ensureSpaceFor(
    ctx,
    described.reduce((sum, p) => sum + statements.get(p.id)!.length * (p.feesPence > 0 ? 2 : 1), 0),
  );
  const placed: string[] = [];
  const attach = (name: string, owner: 'income_id' | 'expense_id', ownerId: number, pdf: Buffer) => {
    fs.writeFileSync(documentPath(ctx, name), pdf, { flag: 'wx' });
    placed.push(name);
    const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
    ctx.db.prepare(`INSERT INTO documents (filename, ${owner}, sha256) VALUES (?, ?, ?)`).run(name, ownerId, sha256);
  };

  const result: SquareImportResult = { imported: 0, alreadyImported: alreadyBefore.size, incomePence: 0, feesPence: 0, years: [] };
  try {
    ctx.db.transaction(() => {
      // Checked again inside the write, in case another browser imported one meanwhile.
      const already = importedPayouts(ctx.db, described.map((p) => p.id));
      for (const p of described) {
        if (already.has(p.id)) {
          result.alreadyImported++;
          continue;
        }
        const date = p.saleDate!;
        const taxYearId = p.taxYearId!;
        const incomeId = insertIncome(
          ctx.db,
          {
            taxYearId,
            date,
            description: SQUARE_INCOME_DESCRIPTION,
            source: SQUARE_PAYEE,
            reference: p.id,
            paymentMethod: 'bank_transfer',
            amountPence: p.incomePence,
            categoryId: settings.incomeCategory.id,
            notes: incomeNotes(p),
          },
          by,
        );
        ctx.db.prepare('UPDATE incomes SET square_payout_id = ? WHERE id = ?').run(p.id, incomeId);
        const names = statementNames(ctx, date, p.id);
        const pdf = statements.get(p.id)!;
        attach(names.income, 'income_id', incomeId, pdf);
        if (p.feesPence > 0) {
          const expenseId = insertExpense(
            ctx.db,
            {
              taxYearId,
              date,
              payee: SQUARE_PAYEE,
              invoiceNumber: null,
              orderNumber: p.id,
              paymentMethod: 'bank_transfer',
              notes: `Taken from the Square payout paid into the bank on ${formatDisplayDate(p.arrivalDate)}.`,
              lineItems: [{ description: SQUARE_FEES_DESCRIPTION, amountPence: p.feesPence, categoryId: settings.feeCategory.id, disallowable: false }],
            },
            by,
          );
          ctx.db.prepare('UPDATE expenses SET square_payout_id = ? WHERE id = ?').run(p.id, expenseId);
          attach(names.fees, 'expense_id', expenseId, pdf);
        }
        result.imported++;
        result.incomePence += p.incomePence;
        result.feesPence += p.feesPence;
        const year = result.years.find((y) => y.taxYearId === taxYearId);
        if (!year) result.years.push({ taxYearId, label: p.taxYearLabel!, firstDate: date });
        else if (date < year.firstDate) year.firstDate = date;
      }
    })();
    placed.length = 0;
  } finally {
    // Only still set if the write failed.
    for (const name of placed) removeDocumentFile(ctx, name);
  }
  result.years.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}

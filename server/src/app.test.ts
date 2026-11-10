import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { APP_VERSION, mtdPayload, photoFilename, type Category, type SubmissionMethod } from '@crafty/shared';
import { createApp } from './app';
import { dumpSql } from './backup';
import { NEXT_UPDATED_AT, nextTimestamp } from './repo';
import { seedCategories, type Db } from './db';
import { getAiSettings } from './aiSettings';
import { MIGRATIONS } from './db/migrations';
import { isAutoBackupDue, nextAutoBackup, runAutoBackup } from './autoBackup';
import { loadConfig } from './config';
import { createContext, type AppContext } from './context';
import { documentNameProblem } from './documents';
import { fraudPreventionHeaders, parseBrowserData, publicIp } from './fraudPrevention';
import { hmrcAccessToken } from './hmrc';
import { categoryListText, toInvoiceReading, type InvoiceInput } from './invoiceReader';
import { geminiReader } from './readers/gemini';
import { HttpError } from './http';
import { changeSummaries, newestTag, startUpdateChecker } from './updates';
import { checkDiskSpace, raiseNotification, syncUpdateNotification } from './notifications';
import { sameInvoice } from './scans';
import { buildStatement } from './square';
import { clearData, generateSampleData } from './sampleData';
import { saveBusiness } from './businessDetails';
import forge from 'node-forge';
import { checkCertificateExpiry } from './notifications';
import { siteHost, writeTlsFiles } from './tlsCertificate';

const NAME = 'Admin';
const PASSWORD = 'test-password';
const PDF = Buffer.from('%PDF-1.4\n%test\n');

let dataDir: string;
let ctx: AppContext;
let agent: ReturnType<typeof request.agent>;
let categories: Category[];

const cat = (code: string) => categories.find((c) => c.hmrcCode === code)!.id;

const BUSINESS = { ownerName: 'Jo Maker', tradingName: 'Jo Makes', description: 'Handmade cards', postcode: 'OX1 1AA' };
const BUSINESS_DETAILS = {
  ...BUSINESS,
  addressLine1: null,
  addressLine2: null,
  town: null,
  county: null,
  email: null,
  phone: null,
  website: null,
  startDate: null,
  endDate: null,
  utr: null,
};

/** Most tests are about the books, so the business is set up first, as the app would insist. */
const setUpBusiness = (db: Db) => saveBusiness(db, BUSINESS_DETAILS, { by: 'Test', updatedAt: new Date().toISOString() });

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
  ctx = createContext(loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, CLIENT_DIST: path.join(dataDir, 'none') }));
  setUpBusiness(ctx.db);
  agent = request.agent(createApp(ctx));
  await agent.post('/api/auth/login').send({ name: NAME, password: PASSWORD }).expect(200);
  categories = (await agent.get('/api/categories').expect(200)).body;
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createYear(startYear = 2025, submissionMethod: SubmissionMethod = 'self_assessment'): Promise<number> {
  const res = await agent.post('/api/tax-years').send({ startYear, submissionMethod }).expect(201);
  return res.body.createdId;
}

function income(taxYearId: number, overrides: Record<string, unknown> = {}) {
  return {
    taxYearId,
    date: '2025-06-14',
    description: 'Abingdon Market sales',
    source: 'Abingdon Market',
    paymentMethod: 'card',
    amountPence: 38000,
    categoryId: cat('turnover'),
    ...overrides,
  };
}

function expense(taxYearId: number, overrides: Record<string, unknown> = {}) {
  return {
    taxYearId,
    date: '2025-05-02',
    payee: 'Bead World',
    invoiceNumber: 'INV-100',
    paymentMethod: 'card',
    lineItems: [
      { description: 'Glass beads', amountPence: 3000, categoryId: cat('costOfGoods') },
      { description: 'Postage', amountPence: 550, categoryId: cat('adminCosts') },
      { description: 'Personal item', amountPence: 1000, categoryId: cat('otherExpenses'), disallowable: true },
    ],
    ...overrides,
  };
}

describe('auth', () => {
  it('rejects requests without a session and wrong passwords', async () => {
    const anon = request(createApp(ctx));
    await anon.get('/api/tax-years').expect(401);
    await anon.post('/api/auth/login').send({ name: NAME, password: 'nope' }).expect(401);
    await anon.post('/api/auth/login').send({ name: 'Nobody', password: PASSWORD }).expect(401);
    expect((await anon.get('/api/auth/me')).body.authenticated).toBe(false);
  });

  it('signs in by name, ignoring case, and says who is signed in', async () => {
    const other = request.agent(createApp(ctx));
    await other.post('/api/auth/login').send({ name: 'admin', password: PASSWORD }).expect(200);
    expect((await other.get('/api/auth/me')).body).toMatchObject({ authenticated: true, user: { name: NAME } });
  });

  it('signs in only until the browser quits (a session cookie, with no expiry)', async () => {
    const res = await request(createApp(ctx)).post('/api/auth/login').send({ name: NAME, password: PASSWORD }).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.filter((c) => c.startsWith('crafty_session'));
    expect(session.length).toBeGreaterThan(0);
    for (const c of session) expect(c).not.toMatch(/expires=|max-age=/i);
  });

  it('refuses a sign-in cookie from before 1.9.4, which had a 30-day expiry', async () => {
    // Signed the way cookie-session (keygrip) does, with the session's contents back then.
    const value = Buffer.from(JSON.stringify({ userId: 1 })).toString('base64');
    const sig = crypto
      .createHmac('sha1', ctx.config.sessionSecret)
      .update(`crafty_session=${value}`)
      .digest('base64')
      .replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c]!);
    const cookie = `crafty_session=${value}; crafty_session.sig=${sig}`;
    const app = createApp(ctx);
    await request(app).get('/api/tax-years').set('Cookie', cookie).expect(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.authenticated).toBe(false);
  });

  it("doesn't let a sign-in to old data sign in to new data with the same SESSION_SECRET", async () => {
    // The installers keep SESSION_SECRET in .env, so it outlives a data folder that's deleted and started again.
    const env = { ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'kept-in-env' };
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
    const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
    const before = createContext(loadConfig({ ...env, DATA_DIR: oldDir, CLIENT_DIST: path.join(oldDir, 'none') }));
    await new Promise((r) => setTimeout(r, 5)); // so the new Admin isn't added in the same millisecond
    const after = createContext(loadConfig({ ...env, DATA_DIR: newDir, CLIENT_DIST: path.join(newDir, 'none') }));
    try {
      const login = await request(createApp(before)).post('/api/auth/login').send({ name: NAME, password: PASSWORD }).expect(200);
      const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
      await request(createApp(before)).get('/api/tax-years').set('Cookie', cookie).expect(200);

      const app = createApp(after);
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body).toEqual({ authenticated: false });
      await request(app).get('/api/business').set('Cookie', cookie).expect(401);
    } finally {
      before.db.close();
      after.db.close();
      fs.rmSync(oldDir, { recursive: true, force: true });
      fs.rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('keeps people signed in through a restore, which keeps them as they were', async () => {
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    await agent.get('/api/tax-years').expect(200);
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    await agent.get('/api/tax-years').expect(200);
  });

  it('creates Admin / admin on a new install, who must choose a new password first', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
    const fresh = createContext(loadConfig({ DATA_DIR: emptyDir, CLIENT_DIST: path.join(emptyDir, 'none') }));
    try {
      const admin = request.agent(createApp(fresh));
      const login = await admin.post('/api/auth/login').send({ name: 'Admin', password: 'admin' }).expect(200);
      expect(login.body).toMatchObject({ authenticated: true, user: { name: 'Admin', role: 'editor' }, mustChangePassword: true });
      const id = login.body.user.id;

      // Nothing else until then: not the books, not other changes to themselves.
      expect((await admin.get('/api/tax-years').expect(403)).body.error).toMatch(/new password/);
      await admin.post('/api/tax-years').send({ startYear: 2025 }).expect(403);
      await admin.put(`/api/users/${id}`).send({ name: 'Me' }).expect(403);
      await admin.put(`/api/users/${id}`).send({ password: 'short' }).expect(400);

      await admin.put(`/api/users/${id}`).send({ password: 'my-own-password' }).expect(200);
      expect((await admin.get('/api/auth/me')).body.mustChangePassword).toBe(false);
      await admin.get('/api/tax-years').expect(200);
      await admin.post('/api/auth/logout').expect(200);
      await admin.post('/api/auth/login').send({ name: 'Admin', password: 'admin' }).expect(401);
      await admin.post('/api/auth/login').send({ name: 'Admin', password: 'my-own-password' }).expect(200);
    } finally {
      fresh.db.close();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('uses ADMIN_NAME and ADMIN_PASSWORD for the first person, without a forced change, and only then', async () => {
    expect((await agent.get('/api/auth/me')).body).toMatchObject({ user: { name: NAME }, mustChangePassword: false });
    // The test install already has a user, so the settings are ignored.
    ctx.db.close();
    ctx = createContext(loadConfig({ DATA_DIR: dataDir, ADMIN_NAME: 'Someone', ADMIN_PASSWORD: 'ignored' }));
    expect(ctx.db.prepare('SELECT name FROM users').all()).toEqual([{ name: NAME }]);
  });
});

/** Adds a person and returns an agent signed in as them. */
async function addPerson(name: string, password = 'second-password', role: 'editor' | 'viewer' = 'editor') {
  await agent.post('/api/users').send({ name, password, role }).expect(201);
  const other = request.agent(createApp(ctx));
  await other.post('/api/auth/login').send({ name, password }).expect(200);
  return other;
}

describe('people', () => {
  it('adds people, who can then sign in, and refuses duplicates and short passwords', async () => {
    await addPerson('Jo');
    await agent.post('/api/users').send({ name: 'jo', password: 'long-enough' }).expect(409);
    await agent.post('/api/users').send({ name: 'Sam', password: 'short' }).expect(400);
    expect((await agent.get('/api/users').expect(200)).body.map((u: { name: string }) => u.name)).toEqual(['Admin', 'Jo']);
  });

  it('renames people and changes passwords', async () => {
    const jo = await addPerson('Jo');
    const id = (await jo.get('/api/auth/me')).body.user.id;
    await agent.put(`/api/users/${id}`).send({ name: 'Joanne', password: 'new-password' }).expect(200);
    await request(createApp(ctx)).post('/api/auth/login').send({ name: 'Jo', password: 'second-password' }).expect(401);
    await request(createApp(ctx)).post('/api/auth/login').send({ name: 'Joanne', password: 'new-password' }).expect(200);
    await agent.put(`/api/users/${id}`).send({ name: 'admin' }).expect(409);
  });

  it('removes people, signing them out, but not yourself', async () => {
    const jo = await addPerson('Jo');
    const me = (await agent.get('/api/auth/me')).body.user.id;
    const id = (await jo.get('/api/auth/me')).body.user.id;
    await jo.delete(`/api/users/${id}`).expect(422);
    await jo.delete(`/api/users/${me}`).expect(204);
    await agent.get('/api/tax-years').expect(401);
    await jo.get('/api/tax-years').expect(200);
  });
});

describe('HTTPS behind a proxy', () => {
  it('sends secure cookies and HSTS when the proxy says the request was HTTPS', async () => {
    const proxied = request(
      createApp({ ...ctx, config: { ...ctx.config, cookieSecure: true, trustProxy: true } }),
    );
    const res = await proxied
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ name: NAME, password: PASSWORD })
      .expect(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
    expect(String(res.headers['set-cookie'])).toMatch(/;\s*secure/i);

    const plain = await request(createApp(ctx)).get('/api/health').expect(200);
    expect(plain.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('categories', () => {
  it('seeds the standard MTD categories', () => {
    expect(categories.filter((c) => c.type === 'INCOME').map((c) => c.hmrcCode)).toEqual(['turnover', 'other']);
    expect(categories.filter((c) => c.type === 'EXPENSE')).toHaveLength(15);
  });
});

describe('custom categories', () => {
  const create = (name: string, code: string) =>
    agent.post('/api/categories').send({ name, mapsToCategoryId: cat(code) });

  it('creates categories that take their type and MTD field from the standard one', async () => {
    const { body } = await create('Printer filament', 'costOfGoods').expect(201);
    expect(body).toMatchObject({ name: 'Printer filament', type: 'EXPENSE', hmrcCode: 'costOfGoods', isCustom: true, usageCount: 0 });
    const income = (await create('Etsy sales', 'turnover').expect(201)).body;
    expect(income.type).toBe('INCOME');
    await create('printer FILAMENT', 'adminCosts').expect(409);
    await create('Cost of goods bought for resale or goods used', 'costOfGoods').expect(409);
    await agent.post('/api/categories').send({ name: 'Nested', mapsToCategoryId: body.id }).expect(422);
  });

  it('protects the standard categories', async () => {
    await agent.put(`/api/categories/${cat('costOfGoods')}`).send({ name: 'Stock', mapsToCategoryId: cat('costOfGoods') }).expect(422);
    await agent.delete(`/api/categories/${cat('costOfGoods')}`).expect(422);
  });

  it('can be used on transactions and counts towards its MTD field', async () => {
    const yearId = await createYear();
    const filament = (await create('Printer filament', 'costOfGoods').expect(201)).body;
    const etsy = (await create('Etsy sales', 'turnover').expect(201)).body;
    await agent.post('/api/incomes').send(income(yearId, { categoryId: etsy.id, amountPence: 5000 })).expect(201);
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 1000 })).expect(201);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
      .expect(201);
    await agent.post('/api/incomes').send(income(yearId, { categoryId: filament.id })).expect(422);

    const { body } = await agent.get('/api/mtd/quarters').query({ taxYearId: yearId }).expect(200);
    expect(body.quarters[0].period.periodIncome).toEqual({ turnover: 6000 });
    expect(body.quarters[0].period.periodExpenses).toEqual({ costOfGoods: 2500 });
    const dash = (await agent.get('/api/dashboard').query({ taxYearId: yearId }).expect(200)).body;
    expect(dash.expensesByCategory.map((c: { name: string }) => c.name)).toEqual(['Printer filament']);
  });

  it('renames freely but only remaps unused categories', async () => {
    const yearId = await createYear();
    const filament = (await create('Filament', 'costOfGoods').expect(201)).body;
    await agent.put(`/api/categories/${filament.id}`).send({ name: 'Printer filament', mapsToCategoryId: cat('adminCosts') }).expect(200);
    await agent.put(`/api/categories/${filament.id}`).send({ name: 'Printer filament', mapsToCategoryId: cat('costOfGoods') }).expect(200);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
      .expect(201);
    await agent.put(`/api/categories/${filament.id}`).send({ name: 'Filament (PLA)', mapsToCategoryId: cat('costOfGoods') }).expect(200);
    await agent.put(`/api/categories/${filament.id}`).send({ name: 'Filament (PLA)', mapsToCategoryId: cat('adminCosts') }).expect(409);
  });

  it('deletes a used category by moving its transactions to the standard category', async () => {
    const yearId = await createYear();
    const filament = (await create('Printer filament', 'costOfGoods').expect(201)).body;
    const etsy = (await create('Etsy sales', 'turnover').expect(201)).body;
    await agent.post('/api/incomes').send(income(yearId, { categoryId: etsy.id })).expect(201);
    const exp = (
      await agent
        .post('/api/expenses')
        .send(expense(yearId, { lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
        .expect(201)
    ).body;
    const before = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId })).body.quarters[0].period;

    const del = (await agent.delete(`/api/categories/${filament.id}`).expect(200)).body;
    expect(del).toMatchObject({ incomes: 0, lineItems: 1, reassignedTo: { hmrcCode: 'costOfGoods', isCustom: false } });
    expect((await agent.delete(`/api/categories/${etsy.id}`).expect(200)).body.incomes).toBe(1);

    expect((await agent.get(`/api/expenses/${exp.id}`)).body.lineItems[0].categoryId).toBe(cat('costOfGoods'));
    const after = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId })).body.quarters[0].period;
    expect(after).toEqual(before);
    expect((await agent.get('/api/categories')).body.some((c: { isCustom: boolean }) => c.isCustom)).toBe(false);
  });

  it('exports and imports custom categories, leaving out ones already there', async () => {
    await create('Printer filament', 'costOfGoods').expect(201);
    await create('Etsy sales', 'turnover').expect(201);
    const res = await agent.get('/api/categories/export.json').expect(200);
    expect(res.headers['content-disposition']).toContain('custom-categories.json');
    const file = JSON.parse(res.text);
    expect(file.categories).toEqual([
      { name: 'Etsy sales', type: 'INCOME', hmrcCode: 'turnover', mapsTo: expect.any(String) },
      { name: 'Printer filament', type: 'EXPENSE', hmrcCode: 'costOfGoods', mapsTo: expect.any(String) },
    ]);

    const same = (await agent.post('/api/categories/import/preview').send(file).expect(200)).body;
    expect(same).toMatchObject({ inFile: 2, adding: [], alreadyThere: 2, problems: [] });

    file.categories.push({ name: 'Packaging', type: 'EXPENSE', hmrcCode: 'adminCosts' });
    const preview = (await agent.post('/api/categories/import/preview').send(file).expect(200)).body;
    expect(preview).toMatchObject({ inFile: 3, alreadyThere: 2, problems: [] });
    expect(preview.adding).toEqual([{ name: 'Packaging', type: 'EXPENSE', mapsTo: expect.any(String) }]);
    expect((await agent.get('/api/categories')).body.some((c: { name: string }) => c.name === 'Packaging')).toBe(false);

    await agent.post('/api/categories/import').send(file).expect(201);
    const packaging = (await agent.get('/api/categories')).body.find((c: { name: string }) => c.name === 'Packaging');
    expect(packaging).toMatchObject({ type: 'EXPENSE', hmrcCode: 'adminCosts', isCustom: true });
  });

  it('imports nothing from a file with problems', async () => {
    await create('Printer filament', 'costOfGoods').expect(201);
    const file = {
      categories: [
        { name: 'Packaging', type: 'EXPENSE', hmrcCode: 'adminCosts' },
        { name: 'Printer filament', type: 'EXPENSE', hmrcCode: 'adminCosts' },
        { name: 'Stalls', type: 'EXPENSE', hmrcCode: 'noSuchField' },
        { name: 'Old kit', type: 'EXPENSE', hmrcCode: 'depreciation' },
        { name: '', type: 'EXPENSE', hmrcCode: 'adminCosts' },
      ],
    };
    const preview = (await agent.post('/api/categories/import/preview').send(file).expect(200)).body;
    expect(preview.adding).toEqual([]);
    expect(preview.problems).toHaveLength(4);
    expect(preview.problems[0]).toContain('already have it');
    await agent.post('/api/categories/import').send(file).expect(422);
    expect((await agent.get('/api/categories')).body.some((c: { name: string }) => c.name === 'Packaging')).toBe(false);

    await agent.post('/api/categories/import/preview').send({ expenses: [] }).expect(422);
    await agent.post('/api/categories/import/preview').send([]).expect(422);
  });
});

describe('tax years', () => {
  it('creates UK tax years, rejects duplicates and makes the first one active', async () => {
    const id = await createYear(2025);
    const { body } = await agent.get('/api/tax-years').expect(200);
    expect(body.activeTaxYearId).toBe(id);
    expect(body.taxYears[0]).toMatchObject({ label: '2025-26', startDate: '2025-04-06', endDate: '2026-04-05' });
    await agent.post('/api/tax-years').send({ startYear: 2025 }).expect(409);
  });

  it('switches the active tax year for each person separately', async () => {
    const first = await createYear(2024);
    const second = await createYear(2025);
    const jo = await addPerson('Jo');
    await jo.put('/api/tax-years/active').send({ taxYearId: first }).expect(200);
    const { body } = await agent.put('/api/tax-years/active').send({ taxYearId: second }).expect(200);
    expect(body.activeTaxYearId).toBe(second);
    expect((await jo.get('/api/tax-years')).body.activeTaxYearId).toBe(first);
  });

  it('stays on the year you were viewing when you add another', async () => {
    const first = await createYear(2024);
    await createYear(2025);
    expect((await agent.get('/api/tax-years')).body.activeTaxYearId).toBe(first);
  });

  it('deletes all transactions and documents in the year', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('documents', PDF, 'receipt-1.pdf').expect(201);
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'receipt-1.pdf'))).toBe(true);

    const { body } = await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    expect(body.deleted).toEqual({ incomes: 1, expenses: 1, documents: 1 });
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'receipt-1.pdf'))).toBe(false);
    const counts = ctx.db
      .prepare('SELECT (SELECT COUNT(*) FROM incomes) + (SELECT COUNT(*) FROM expenses) + (SELECT COUNT(*) FROM expense_line_items) AS n')
      .get() as { n: number };
    expect(counts.n).toBe(0);
    expect(body.activeTaxYearId).toBeNull();
  });
});

describe('read-only people', () => {
  it('can view, export and download documents, but not change anything', async () => {
    const yearId = await createYear();
    const saved = (await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('documents', PDF, 'payout.pdf').expect(201)).body;
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    expect((await viewer.get('/api/auth/me')).body.user).toMatchObject({ name: 'Accountant', role: 'viewer' });

    for (const path of ['/api/dashboard', '/api/mtd/quarters', '/api/mileage', '/api/use-of-home', '/api/reports/tax-estimate', '/api/reports/year-end']) {
      await viewer.get(path).query({ taxYearId: yearId }).expect(200);
    }
    await viewer.get('/api/reports/breakdown').query({ from: '2025-04-06', to: '2026-04-05' }).expect(200);
    await viewer.get(`/api/incomes/${saved.id}`).expect(200);
    await viewer.get('/api/incomes/export.csv').query({ taxYearId: yearId }).expect(200);
    await viewer.get('/api/incomes/export.json').query({ taxYearId: yearId }).expect(200);
    await viewer.get('/api/expenses/export.json').query({ taxYearId: yearId }).expect(200);
    await viewer.get('/api/documents/payout.pdf').expect(200);

    const refused = [
      viewer.post('/api/incomes').send(income(yearId)),
      viewer.put(`/api/incomes/${saved.id}`).send(income(yearId)),
      viewer.delete(`/api/incomes/${saved.id}`),
      viewer.post('/api/incomes/delete').send({ ids: [saved.id] }),
      viewer.post('/api/expenses').send(expense(yearId)),
      viewer.post('/api/incomes/import').send({ incomes: [] }),
      viewer.post('/api/expenses/import/preview').send({ expenses: [] }),
      viewer.post('/api/categories/import').send({ categories: [] }),
      viewer.post('/api/mileage').send({ taxYearId: yearId, date: '2025-06-14', description: 'Trip', vehicle: 'car', distanceTenths: 10 }),
      viewer.put('/api/use-of-home').send({ taxYearId: yearId, months: [] }),
      viewer.put(`/api/tax-years/${yearId}/tax-settings`).send({ otherIncomePence: 1 }),
      viewer.post('/api/tax-years').send({ startYear: 2024 }),
      viewer.delete(`/api/tax-years/${yearId}`),
      viewer.post('/api/categories').send({ name: 'Beads', mapsToCategoryId: cat('costOfGoods') }),
      viewer.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-01' }),
      viewer.post('/api/sample-data'),
      viewer.post('/api/reset').send({ confirm: 'RESET' }),
      viewer.post('/api/users').send({ name: 'Sam', password: 'long-enough' }),
    ];
    for (const res of await Promise.all(refused)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/read-only/);
    }
    expect((await agent.get(`/api/incomes/${saved.id}`)).body.amountPence).toBe(38000);
  });

  it('cannot download backups', async () => {
    await createYear();
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    for (const path of ['/api/backup.sql', '/api/backup.zip', '/api/backup/auto', '/api/backup/auto/files/x.zip']) {
      await viewer.get(path).expect(403);
    }
    await agent.get('/api/backup.sql').expect(200);
  });

  it('can choose their own tax year and change their own password, and nothing else about people', async () => {
    const first = await createYear(2024);
    await createYear(2025);
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await viewer.put('/api/tax-years/active').send({ taxYearId: first }).expect(200);

    const me = (await viewer.get('/api/auth/me')).body.user.id;
    const admin = (await agent.get('/api/auth/me')).body.user.id;
    await viewer.put(`/api/users/${me}`).send({ password: 'a-new-password' }).expect(200);
    await request(createApp(ctx)).post('/api/auth/login').send({ name: 'Accountant', password: 'a-new-password' }).expect(200);
    await viewer.put(`/api/users/${me}`).send({ role: 'editor' }).expect(403);
    await viewer.put(`/api/users/${me}`).send({ name: 'Boss' }).expect(403);
    await viewer.put(`/api/users/${admin}`).send({ password: 'taken-over!' }).expect(403);
  });

  it('can be made an editor, and the last editor stays one', async () => {
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    const me = (await agent.get('/api/auth/me')).body.user.id;
    await agent.put(`/api/users/${me}`).send({ role: 'viewer' }).expect(422);

    const id = (await viewer.get('/api/auth/me')).body.user.id;
    await agent.put(`/api/users/${id}`).send({ role: 'editor' }).expect(200);
    await viewer.post('/api/tax-years').send({ startYear: 2025 }).expect(201);
    // With two editors, one can step down.
    await agent.put(`/api/users/${me}`).send({ role: 'viewer' }).expect(200);
    await agent.post('/api/tax-years').send({ startYear: 2024 }).expect(403);
  });
});

describe('working together', () => {
  it('records who added and last changed each transaction', async () => {
    const yearId = await createYear();
    const jo = await addPerson('Jo');
    const created = (await agent.post('/api/incomes').send(income(yearId)).expect(201)).body;
    expect(created).toMatchObject({ createdBy: NAME, updatedBy: NAME });
    const edited = (await jo.put(`/api/incomes/${created.id}`).send(income(yearId, { amountPence: 100 })).expect(200)).body;
    expect(edited).toMatchObject({ createdBy: NAME, updatedBy: 'Jo' });

    const spent = (await jo.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    expect(spent).toMatchObject({ createdBy: 'Jo', updatedBy: 'Jo' });
  });

  it('refuses an edit made from an out-of-date copy', async () => {
    const yearId = await createYear();
    const jo = await addPerson('Jo');
    const original = (await agent.post('/api/incomes').send(income(yearId)).expect(201)).body;
    // Both open the form; Jo saves first.
    const joSaved = (
      await jo.put(`/api/incomes/${original.id}`).send(income(yearId, { amountPence: 100, expectedUpdatedAt: original.updatedAt })).expect(200)
    ).body;
    const stale = await agent
      .put(`/api/incomes/${original.id}`)
      .send(income(yearId, { amountPence: 200, expectedUpdatedAt: original.updatedAt }))
      .expect(409);
    expect(stale.body.error).toMatch(/^Jo changed this transaction/);
    expect((await agent.get(`/api/incomes/${original.id}`)).body.amountPence).toBe(100);
    await agent.put(`/api/incomes/${original.id}`).send(income(yearId, { amountPence: 200, expectedUpdatedAt: joSaved.updatedAt })).expect(200);

    const bought = (await agent.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    await jo.put(`/api/expenses/${bought.id}`).send(expense(yearId, { notes: 'Jo', expectedUpdatedAt: bought.updatedAt })).expect(200);
    await agent.put(`/api/expenses/${bought.id}`).send(expense(yearId, { notes: 'Me', expectedUpdatedAt: bought.updatedAt })).expect(409);
  });

  it('gives every save a new version, even two in the same millisecond', async () => {
    const yearId = await createYear();
    const saved = (await agent.post('/api/incomes').send(income(yearId)).expect(201)).body;
    // Back-to-back writes straight to the database, faster than any clock tick.
    const touch = ctx.db.prepare(`UPDATE incomes SET notes = 'x', updated_at = ${NEXT_UPDATED_AT} WHERE id = ?`);
    const read = ctx.db.prepare('SELECT updated_at AS at FROM incomes WHERE id = ?');
    const seen = [saved.updatedAt];
    for (let n = 0; n < 5; n++) {
      touch.run(saved.id);
      seen.push((read.get(saved.id) as { at: string }).at);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(seen);
    expect(nextTimestamp('2999-01-01T00:00:00.000Z')).toBe('2999-01-01T00:00:00.002Z');
  });

  it('tells other open browsers about changes, but not the one that made them', async () => {
    const yearId = await createYear();
    const jo = await addPerson('Jo');
    const server = createApp(ctx).listen(0);
    const port = (server.address() as { port: number }).port;
    const cookie = (await jo.post('/api/auth/login').send({ name: 'Jo', password: 'second-password' })).headers['set-cookie'];
    const abort = new AbortController();
    try {
      const res = await fetch(`http://localhost:${port}/api/events?client=jo-tab`, {
        headers: { Cookie: ([] as string[]).concat(cookie ?? []).map((c) => c.split(';')[0]).join('; ') },
        signal: abort.signal,
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const next = async () => (received += decoder.decode((await reader.read()).value));
      await next();
      expect(received).toContain(': connected');
      expect(ctx.liveUpdates.size).toBe(1);

      // Jo's own change from the same tab isn't echoed back; the admin's change is sent.
      await jo.post('/api/incomes').set('X-Client-Id', 'jo-tab').send(income(yearId)).expect(201);
      await agent.post('/api/incomes').set('X-Client-Id', 'admin-tab').send(income(yearId)).expect(201);
      await agent.put('/api/tax-years/active').send({ taxYearId: yearId }).expect(200);
      await agent.post('/api/categories').send({ name: 'Beads', mapsToCategoryId: cat('costOfGoods') }).expect(201);
      while (received.split('event: changed').length < 3) await next();
      const events = received
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events).toEqual([
        { area: 'incomes', by: NAME },
        { area: 'categories', by: NAME },
      ]);
    } finally {
      abort.abort();
      server.close();
    }
  });
});

describe('incomes', () => {
  it('deletes the transactions listed, with their documents', async () => {
    const yearId = await createYear();
    const keep = (await agent.post('/api/incomes').send(income(yearId, { description: 'Keep' })).expect(201)).body;
    const a = (await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('documents', PDF, 'gone.pdf').expect(201)).body;
    const b = (await agent.post('/api/incomes').send(income(yearId)).expect(201)).body;
    await agent.post('/api/incomes/delete').send({ ids: [] }).expect(400);

    const { body } = await agent.post('/api/incomes/delete').send({ ids: [a.id, b.id, a.id, 99999] }).expect(200);
    expect(body).toEqual({ deleted: 2 });
    expect((await agent.get('/api/incomes').query({ taxYearId: yearId })).body.map((i: { id: number }) => i.id)).toEqual([keep.id]);
    await agent.get('/api/documents/gone.pdf').expect(404);

    const e1 = (await agent.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    const e2 = (await agent.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    expect((await agent.post('/api/expenses/delete').send({ ids: [e1.id] }).expect(200)).body).toEqual({ deleted: 1 });
    expect((await agent.get('/api/expenses').query({ taxYearId: yearId })).body.map((e: { id: number }) => e.id)).toEqual([e2.id]);
  });

  it('rejects a date outside the tax year', async () => {
    const yearId = await createYear();
    const res = await agent.post('/api/incomes').send(income(yearId, { date: '2025-04-05' })).expect(422);
    expect(res.body.error).toMatch(/2025\/26/);
    await agent.post('/api/incomes').send(income(yearId, { date: '2026-04-05' })).expect(201);
  });

  it('rejects an expense category on an income', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId, { categoryId: cat('costOfGoods') })).expect(422);
  });

  it('keeps the original filename and rejects duplicates', async () => {
    const yearId = await createYear();
    const first = await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId)))
      .attach('documents', PDF, 'Square payout 14-06-2025.pdf')
      .expect(201);
    expect(first.body.documents).toMatchObject([{ filename: 'Square payout 14-06-2025.pdf' }]);

    const dup = await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId)))
      .attach('documents', PDF, 'Square payout 14-06-2025.pdf')
      .expect(409);
    expect(dup.body.error).toMatch(/already stored/);
    expect((await agent.get('/api/incomes').query({ taxYearId: yearId })).body).toHaveLength(1);

    const doc = await agent.get(`/api/documents/${encodeURIComponent('Square payout 14-06-2025.pdf')}`).expect(200);
    expect(doc.headers['content-type']).toBe('application/pdf');
  });

  it('stores photos from a camera under their generated names', async () => {
    const yearId = await createYear();
    const jpeg = photoFilename({ type: 'image/jpeg', name: 'image.jpg' });
    const heic = photoFilename({ type: 'image/heic', name: 'IMG_0001.HEIC' });
    expect(documentNameProblem(jpeg)).toBeNull();
    expect(documentNameProblem(heic)).toBeNull();
    await agent
      .post('/api/expenses')
      .field('data', JSON.stringify(expense(yearId)))
      .attach('documents', Buffer.from('jpeg'), jpeg)
      .attach('documents', Buffer.from('heic'), heic)
      .expect(201);
    const saved = await agent.get(`/api/documents/${encodeURIComponent(jpeg)}`).expect(200);
    expect(saved.headers['content-type']).toBe('image/jpeg');
    const savedHeic = await agent.get(`/api/documents/${encodeURIComponent(heic)}`).expect(200);
    expect(savedHeic.headers['content-type']).toBe('image/heic');
  });

  it('rejects disallowed file types', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('documents', PDF, 'notes.exe').expect(400);
  });

  it('attaches several documents, adds and removes them on edit, and deletes them with the record', async () => {
    const yearId = await createYear();
    const exists = (name: string) => fs.existsSync(path.join(dataDir, 'uploads', name));
    const created = (
      await agent
        .post('/api/incomes')
        .field('data', JSON.stringify(income(yearId)))
        .attach('documents', PDF, 'a.pdf')
        .attach('documents', PDF, 'b.pdf')
        .expect(201)
    ).body;
    expect(created.documents.map((d: { filename: string }) => d.filename)).toEqual(['a.pdf', 'b.pdf']);
    const [a, b] = created.documents;

    // Remove one and add another in the same save.
    const edited = (
      await agent
        .put(`/api/incomes/${created.id}`)
        .field('data', JSON.stringify(income(yearId, { removeDocumentIds: [a.id] })))
        .attach('documents', PDF, 'c.pdf')
        .expect(200)
    ).body;
    expect(edited.documents.map((d: { filename: string }) => d.filename)).toEqual(['b.pdf', 'c.pdf']);
    expect([exists('a.pdf'), exists('b.pdf'), exists('c.pdf')]).toEqual([false, true, true]);

    // A plain save without removals keeps them.
    await agent.put(`/api/incomes/${created.id}`).send(income(yearId)).expect(200);
    expect((await agent.get(`/api/incomes/${created.id}`)).body.documents).toHaveLength(2);
    // Another transaction's document can't be removed through this one.
    const other = (await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('documents', PDF, 'd.pdf')).body;
    await agent.put(`/api/incomes/${created.id}`).send(income(yearId, { removeDocumentIds: [other.documents[0].id] })).expect(422);

    expect((await agent.get('/api/incomes').query({ taxYearId: yearId, search: 'c.pdf' })).body.map((i: { id: number }) => i.id)).toEqual([
      created.id,
    ]);
    expect((await agent.get('/api/tax-years')).body.taxYears[0].documentCount).toBe(3);
    const csv = (await agent.get('/api/incomes/export.csv').query({ taxYearId: yearId })).text;
    expect(csv).toContain('b.pdf; c.pdf');

    await agent.delete(`/api/incomes/${created.id}`).expect(204);
    expect([exists('b.pdf'), exists('c.pdf'), exists('d.pdf')]).toEqual([false, false, true]);
    await agent.get('/api/documents/b.pdf').expect(404);
    expect(b.filename).toBe('b.pdf');
  });

  it('refuses clashing names, and more than the limit, without keeping any of the files', async () => {
    const yearId = await createYear();
    const exists = (name: string) => fs.existsSync(path.join(dataDir, 'uploads', name));
    await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId)))
      .attach('documents', PDF, 'same.pdf')
      .attach('documents', PDF, 'same.pdf')
      .expect(409);
    await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId)))
      .attach('documents', PDF, 'fine.pdf')
      .attach('documents', PDF, 'bad.exe')
      .expect(400);
    expect([exists('same.pdf'), exists('fine.pdf')]).toEqual([false, false]);

    let req = agent.post('/api/incomes').field('data', JSON.stringify(income(yearId)));
    for (let n = 1; n <= 10; n++) req = req.attach('documents', PDF, `doc-${n}.pdf`);
    const full = (await req.expect(201)).body;
    const more = await agent
      .put(`/api/incomes/${full.id}`)
      .field('data', JSON.stringify(income(yearId)))
      .attach('documents', PDF, 'doc-11.pdf')
      .expect(422);
    expect(more.body.error).toMatch(/at most 10 documents/);
    expect(exists('doc-11.pdf')).toBe(false);
    expect((await agent.get('/api/incomes').query({ taxYearId: yearId })).body).toHaveLength(1);
  });

  it('renames attached documents on edit, refusing bad or clashing names without changing anything', async () => {
    const yearId = await createYear();
    const exists = (name: string) => fs.existsSync(path.join(dataDir, 'uploads', name));
    const names = (t: { documents: { filename: string }[] }) => t.documents.map((d) => d.filename);
    const created = (
      await agent
        .post('/api/expenses')
        .field('data', JSON.stringify(expense(yearId)))
        .attach('documents', PDF, 'scan.pdf')
        .attach('documents', PDF, 'other.pdf')
        .expect(201)
    ).body;
    const [scan, other] = created.documents;
    const before = fs.readFileSync(path.join(dataDir, 'uploads', 'scan.pdf'));

    // Rename one, add one, in the same save.
    const edited = (
      await agent
        .put(`/api/expenses/${created.id}`)
        .field('data', JSON.stringify(expense(yearId, { renameDocuments: [{ id: scan.id, filename: 'Invoice 42.pdf' }] })))
        .attach('documents', PDF, 'new.pdf')
        .expect(200)
    ).body;
    expect(names(edited)).toEqual(['Invoice 42.pdf', 'other.pdf', 'new.pdf']);
    expect([exists('scan.pdf'), exists('Invoice 42.pdf')]).toEqual([false, true]);
    expect(fs.readFileSync(path.join(dataDir, 'uploads', 'Invoice 42.pdf'))).toEqual(before);
    await agent.get('/api/documents/Invoice%2042.pdf').expect(200);

    const refused = async (renameDocuments: unknown, status: number, extra: object = {}) => {
      await agent
        .put(`/api/expenses/${created.id}`)
        .send(expense(yearId, { renameDocuments, ...extra }))
        .expect(status);
      expect(names((await agent.get(`/api/expenses/${created.id}`)).body)).toEqual(['Invoice 42.pdf', 'other.pdf', 'new.pdf']);
    };
    // Taken by another of its documents, by another transaction's, or by another rename in the save.
    await refused([{ id: other.id, filename: 'new.pdf' }], 409);
    await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('documents', PDF, 'elsewhere.pdf').expect(201);
    await refused([{ id: other.id, filename: 'elsewhere.pdf' }], 409);
    await refused(
      [
        { id: scan.id, filename: 'twin.pdf' },
        { id: other.id, filename: 'twin.pdf' },
      ],
      409,
    );
    // Unsafe names and other extensions; another transaction's document; renamed and removed at once.
    await refused([{ id: other.id, filename: '../escape.pdf' }], 400);
    await refused([{ id: other.id, filename: 'other.exe' }], 400);
    const elsewhere = (await agent.get('/api/incomes').query({ taxYearId: yearId })).body[0].documents[0];
    await refused([{ id: elsewhere.id, filename: 'mine.pdf' }], 422);
    await refused([{ id: other.id, filename: 'gone.pdf' }], 422, { removeDocumentIds: [other.id] });
    expect(fs.readdirSync(path.join(dataDir, 'uploads')).sort()).toEqual(['Invoice 42.pdf', 'elsewhere.pdf', 'new.pdf', 'other.pdf']);

    // Its own name again is no change.
    await agent
      .put(`/api/expenses/${created.id}`)
      .send(expense(yearId, { renameDocuments: [{ id: other.id, filename: 'other.pdf' }] }))
      .expect(200);
    expect(exists('other.pdf')).toBe(true);
  });

  it('stores documents on expenses too', async () => {
    const yearId = await createYear();
    const created = (
      await agent
        .post('/api/expenses')
        .field('data', JSON.stringify(expense(yearId)))
        .attach('documents', PDF, 'invoice.pdf')
        .attach('documents', PDF, 'delivery note.pdf')
        .expect(201)
    ).body;
    expect(created.documents.map((d: { filename: string }) => d.filename)).toEqual(['invoice.pdf', 'delivery note.pdf']);
    const edited = (
      await agent.put(`/api/expenses/${created.id}`).send(expense(yearId, { removeDocumentIds: [created.documents[1].id] })).expect(200)
    ).body;
    expect(edited.documents.map((d: { filename: string }) => d.filename)).toEqual(['invoice.pdf']);
    await agent.delete(`/api/expenses/${created.id}`).expect(204);
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
  });

  it('filters and exports only the filtered rows to CSV', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    await agent
      .post('/api/incomes')
      .send(income(yearId, { description: 'Christmas fair', source: 'Oxford Town Hall', paymentMethod: 'cash', amountPence: 13800 }))
      .expect(201);

    const cash = await agent.get('/api/incomes').query({ taxYearId: yearId, paymentMethod: 'cash' }).expect(200);
    expect(cash.body.map((i: { description: string }) => i.description)).toEqual(['Christmas fair']);
    const search = await agent.get('/api/incomes').query({ taxYearId: yearId, search: 'abingdon' }).expect(200);
    expect(search.body).toHaveLength(1);
    const amount = await agent.get('/api/incomes').query({ taxYearId: yearId, minPence: 20000 }).expect(200);
    expect(amount.body).toHaveLength(1);

    const csv = await agent.get('/api/incomes/export.csv').query({ taxYearId: yearId, paymentMethod: 'cash' }).expect(200);
    expect(csv.headers['content-disposition']).toContain('income-2025-26.csv');
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Christmas fair');
    expect(lines[1]).toContain('138.00');
  });

  it('filters by a tax month, 6th to 5th inclusive, in the list and the CSV', async () => {
    const yearId = await createYear();
    for (const date of ['2025-05-05', '2025-05-06', '2025-06-05', '2025-06-06']) {
      await agent.post('/api/incomes').send(income(yearId, { date, description: date })).expect(201);
    }
    const month = { taxYearId: yearId, from: '2025-05-06', to: '2025-06-05' };

    const list = await agent.get('/api/incomes').query(month).expect(200);
    expect(list.body.map((i: { date: string }) => i.date).sort()).toEqual(['2025-05-06', '2025-06-05']);

    const csv = await agent.get('/api/incomes/export.csv').query(month).expect(200);
    expect(csv.text.trim().split('\r\n')).toHaveLength(3);
  });
});

describe('expenses', () => {
  it('works out the total from the line items, ignoring any total sent', async () => {
    const yearId = await createYear();
    const created = (await agent.post('/api/expenses').send(expense(yearId, { totalPence: 1 })).expect(201)).body;
    expect(created.totalPence).toBe(4550);
  });

  it('rejects an income category on a line item', async () => {
    const yearId = await createYear();
    const bad = expense(yearId);
    bad.lineItems[0].categoryId = cat('turnover');
    await agent.post('/api/expenses').send(bad).expect(422);
  });

  it('edits, removes and adds line items in one update', async () => {
    const yearId = await createYear();
    const created = (await agent.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    expect(created.lineItems).toHaveLength(3);
    expect(created.disallowablePence).toBe(1000);

    const [beads, postage] = created.lineItems;
    const updated = (
      await agent
        .put(`/api/expenses/${created.id}`)
        .send(
          expense(yearId, {
            lineItems: [
              { id: beads.id, description: 'Glass beads (large)', amountPence: 3200, categoryId: cat('costOfGoods') },
              { id: postage.id, description: 'Postage', amountPence: 550, categoryId: cat('adminCosts') },
              { description: 'Stall fee', amountPence: 450, categoryId: cat('premisesRunningCosts') },
            ],
          }),
        )
        .expect(200)
    ).body;
    expect(updated.lineItems.map((li: { description: string }) => li.description)).toEqual([
      'Glass beads (large)',
      'Postage',
      'Stall fee',
    ]);
    expect(updated.lineItems[0].id).toBe(beads.id);
    expect(updated.totalPence).toBe(4200);
    expect(updated.disallowablePence).toBe(0);
  });

  it('rejects line item ids from another transaction', async () => {
    const yearId = await createYear();
    const a = (await agent.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    const b = (await agent.post('/api/expenses').send(expense(yearId)).expect(201)).body;
    const payload = expense(yearId);
    (payload.lineItems[0] as { id?: number }).id = b.lineItems[0].id;
    await agent.put(`/api/expenses/${a.id}`).send(payload).expect(422);
  });

  it('exports transactions without line items', async () => {
    const yearId = await createYear();
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    const csv = await agent.get('/api/expenses/export.csv').query({ taxYearId: yearId }).expect(200);
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Payee');
    expect(lines[1]).toContain('45.50');
    expect(csv.text).not.toContain('Glass beads');
  });

  it('exports transactions to JSON with their line items, in pence', async () => {
    const yearId = await createYear();
    await agent.post('/api/expenses').send(expense(yearId, { orderNumber: 'PO-9' })).expect(201);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { date: '2025-06-01', payee: 'Glue Co', lineItems: [{ description: 'Glue', amountPence: 700, categoryId: cat('costOfGoods') }] }))
      .expect(201);
    const res = await agent.get('/api/expenses/export.json').query({ taxYearId: yearId }).expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('expenses-2025-26.json');
    const body = JSON.parse(res.text);
    expect(body.taxYear).toBe('2025-26');
    expect(body.expenses.map((e: { payee: string }) => e.payee)).toEqual(['Glue Co', 'Bead World']);
    const beads = body.expenses[1];
    expect(beads).toMatchObject({
      date: '2025-05-02',
      payee: 'Bead World',
      invoiceNumber: 'INV-100',
      orderNumber: 'PO-9',
      paymentMethod: 'card',
      totalPence: 4550,
      allowablePence: 3550,
      disallowablePence: 1000,
      documents: [],
      createdBy: NAME,
    });
    expect(beads.lineItems).toEqual([
      { description: 'Glass beads', category: expect.any(String), hmrcCode: 'costOfGoods', amountPence: 3000, disallowable: false },
      { description: 'Postage', category: expect.any(String), hmrcCode: 'adminCosts', amountPence: 550, disallowable: false },
      { description: 'Personal item', category: expect.any(String), hmrcCode: 'otherExpenses', amountPence: 1000, disallowable: true },
    ]);
    expect(body.expenses[0].lineItems).toHaveLength(1);

    // Same filters as the list and the CSV.
    const filtered = await agent.get('/api/expenses/export.json').query({ taxYearId: yearId, search: 'glue' }).expect(200);
    expect(JSON.parse(filtered.text).expenses).toHaveLength(1);
  });

  it('exports income to JSON in pence', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 12345 })).expect(201);
    const res = await agent.get('/api/incomes/export.json').query({ taxYearId: yearId }).expect(200);
    expect(res.headers['content-disposition']).toContain('income-2025-26.json');
    const body = JSON.parse(res.text);
    expect(body.taxYear).toBe('2025-26');
    expect(body.incomes).toHaveLength(1);
    expect(body.incomes[0]).toMatchObject({ amountPence: 12345, hmrcCode: 'turnover', category: expect.any(String), documents: [] });
    expect(body.incomes[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('imports its own JSON export, leaving out what the books already have', async () => {
    const yearId = await createYear();
    await agent.post('/api/expenses').send(expense(yearId, { orderNumber: 'PO-9', notes: 'For the spring fair' })).expect(201);
    const glue = await agent
      .post('/api/expenses')
      .send(expense(yearId, { date: '2025-06-01', payee: 'Glue Co', lineItems: [{ description: 'Glue', amountPence: 700, categoryId: cat('costOfGoods') }] }))
      .expect(201);
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    const sale = (await agent.post('/api/incomes').send(income(yearId, { date: '2025-07-01', amountPence: 1250 })).expect(201)).body;
    const expenses = JSON.parse((await agent.get('/api/expenses/export.json').query({ taxYearId: yearId })).text);
    const incomes = JSON.parse((await agent.get('/api/incomes/export.json').query({ taxYearId: yearId })).text);

    // Everything is already there.
    const same = (await agent.post('/api/expenses/import/preview').send(expenses).expect(200)).body;
    expect(same).toMatchObject({ inFile: 2, adding: 0, alreadyThere: 2, problems: [] });

    await agent.delete(`/api/expenses/${glue.body.id}`).expect(204);
    await agent.delete(`/api/incomes/${sale.id}`).expect(204);
    const preview = (await agent.post('/api/expenses/import/preview').send(expenses).expect(200)).body;
    expect(preview).toEqual({
      inFile: 2,
      adding: 1,
      addingPence: 700,
      alreadyThere: 1,
      documentsLeftOut: 0,
      years: [{ taxYearId: yearId, label: '2025-26', adding: 1, firstDate: '2025-06-01' }],
      problems: [],
    });
    // A preview changes nothing.
    expect((await agent.get('/api/expenses').query({ taxYearId: yearId })).body).toHaveLength(1);

    await agent.post('/api/expenses/import').send(expenses).expect(201);
    await agent.post('/api/incomes/import').send(incomes).expect(201);
    const again = JSON.parse((await agent.get('/api/expenses/export.json').query({ taxYearId: yearId })).text);
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ id: _id, ...rest }) => rest);
    expect(strip(again.expenses)).toEqual(strip(expenses.expenses));
    const incomesAgain = JSON.parse((await agent.get('/api/incomes/export.json').query({ taxYearId: yearId })).text);
    expect(strip(incomesAgain.incomes)).toEqual(strip(incomes.incomes));

    // Importing again adds nothing.
    expect((await agent.post('/api/incomes/import').send(incomes).expect(201)).body).toMatchObject({ adding: 0, alreadyThere: 2 });
    expect((await agent.get('/api/incomes').query({ taxYearId: yearId })).body).toHaveLength(2);
  });

  it('imports into the tax year of each date, finds categories by name or HMRC field, and counts repeats', async () => {
    const year1 = await createYear(2024);
    const year2 = await createYear(2025);
    await agent.post('/api/categories').send({ name: 'Stall fees', mapsToCategoryId: cat('premisesRunningCosts') }).expect(201);
    await agent.post('/api/incomes').send(income(year2, { date: '2025-06-14', description: 'Fair', amountPence: 500, paymentMethod: 'cash' })).expect(201);
    const fairSale = { date: '2025-06-14', description: 'fair ', paymentMethod: 'cash', amountPence: 500, category: 'Sales', hmrcCode: 'turnover' };
    const file = {
      incomes: [
        fairSale,
        fairSale,
        { ...fairSale, date: '2024-12-01', description: 'Christmas fair', category: 'From another install', documents: ['till-roll.pdf'] },
      ],
    };
    const preview = (await agent.post('/api/incomes/import/preview').send(file).expect(200)).body;
    expect(preview).toMatchObject({ inFile: 3, adding: 2, alreadyThere: 1, documentsLeftOut: 1, addingPence: 1000, problems: [] });
    expect(preview.years.map((y: { taxYearId: number; adding: number }) => [y.taxYearId, y.adding])).toEqual([
      [year1, 1],
      [year2, 1],
    ]);
    await agent.post('/api/incomes/import').send(file).expect(201);
    const christmas = (await agent.get('/api/incomes').query({ taxYearId: year1 })).body;
    expect(christmas).toMatchObject([{ description: 'Christmas fair', hmrcCode: 'turnover', createdBy: NAME, documents: [] }]);

    // A custom category by name; entertainment stays disallowable whatever the file says.
    const expenses = {
      expenses: [
        {
          date: '2025-05-01',
          payee: 'Town Hall',
          paymentMethod: 'card',
          lineItems: [
            { description: 'Pitch', category: 'stall FEES', amountPence: 3000 },
            { description: 'Lunch with buyer', hmrcCode: 'businessEntertainmentCosts', amountPence: 1500, disallowable: false },
          ],
        },
      ],
    };
    await agent.post('/api/expenses/import').send(expenses).expect(201);
    const [hall] = (await agent.get('/api/expenses').query({ taxYearId: year2 })).body;
    expect(hall.totalPence).toBe(4500);
    expect(hall.lineItems.map((l: { categoryName: string; disallowable: boolean }) => [l.categoryName, l.disallowable])).toEqual([
      ['Stall fees', false],
      [expect.any(String), true],
    ]);
  });

  it('imports nothing from a file with any problem, and says what they are', async () => {
    const yearId = await createYear();
    const good = { date: '2025-06-14', description: 'Sale', paymentMethod: 'card', amountPence: 500, category: 'Sales', hmrcCode: 'turnover' };
    const file = {
      incomes: [
        good,
        { ...good, date: '2023-05-01' },
        { ...good, category: 'Nope', hmrcCode: 'nope' },
        { ...good, amountPence: 1.5 },
        { ...good, category: 'Costs of goods bought for resale or goods used', hmrcCode: 'costOfGoods' },
      ],
    };
    const preview = (await agent.post('/api/incomes/import/preview').send(file).expect(200)).body;
    expect(preview.adding).toBe(0);
    expect(preview.problems).toEqual([
      "Income 2 · 1 May 2023 · Sale: there's no tax year for 1 May 2023. Add it in Settings → Tax Years first.",
      "Income 3 · 14 Jun 2025 · Sale: there's no income category “Nope”.",
      'Income 4 · 14 Jun 2025 · Sale: amountPence: Amount must be in whole pence',
      expect.stringMatching(/^Income 5 .*no income category/),
    ]);
    const res = await agent.post('/api/incomes/import').send(file).expect(422);
    expect(res.body.error).toMatch(/^Nothing was imported\. Income 2/);
    expect((await agent.get('/api/incomes').query({ taxYearId: yearId })).body).toHaveLength(0);

    const badTotal = {
      expenses: [{ date: '2025-06-14', payee: 'Shop', paymentMethod: 'cash', totalPence: 999, lineItems: [{ description: 'Card', amountPence: 100, hmrcCode: 'costOfGoods' }, { description: '', amountPence: 1, hmrcCode: 'costOfGoods' }] }],
    };
    expect((await agent.post('/api/expenses/import/preview').send(badTotal).expect(200)).body.problems).toEqual([
      'Expense 1 · 14 Jun 2025 · Shop: line 2, description: Line item description is required',
    ]);
    badTotal.expenses[0]!.lineItems.pop();
    expect((await agent.post('/api/expenses/import/preview').send(badTotal).expect(200)).body.problems).toEqual([
      "Expense 1 · 14 Jun 2025 · Shop: its total, £9.99, isn't the sum of its line items, £1.00.",
    ]);

    const wrongKind = await agent.post('/api/incomes/import/preview').send(badTotal).expect(422);
    expect(wrongKind.body.error).toBe('This is an expense export. Import it on the Expenses page.');
    await agent.post('/api/expenses/import/preview').send({ hello: 1 }).expect(422);
  });

  it('includes each transaction’s line items in the list', async () => {
    const yearId = await createYear();
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { lineItems: [{ description: 'Glue', amountPence: 700, categoryId: cat('costOfGoods') }] }))
      .expect(201);
    const { body } = await agent.get('/api/expenses').query({ taxYearId: yearId }).expect(200);
    const byTotal = Object.fromEntries(body.map((e: { totalPence: number; lineItems: unknown[] }) => [e.totalPence, e.lineItems]));
    expect(byTotal[4550].map((li: { description: string }) => li.description)).toEqual(['Glass beads', 'Postage', 'Personal item']);
    expect(byTotal[4550][2]).toMatchObject({ disallowable: true, hmrcCode: 'otherExpenses' });
    expect(byTotal[700]).toHaveLength(1);
  });

  it('stores, searches and exports the order number', async () => {
    const yearId = await createYear();
    const created = (await agent.post('/api/expenses').send(expense(yearId, { orderNumber: 'PO-77' })).expect(201)).body;
    expect(created.orderNumber).toBe('PO-77');
    const updated = (
      await agent.put(`/api/expenses/${created.id}`).send(expense(yearId, { orderNumber: 'PO-78' })).expect(200)
    ).body;
    expect(updated.orderNumber).toBe('PO-78');
    expect((await agent.get('/api/expenses').query({ taxYearId: yearId, search: 'po-78' })).body).toHaveLength(1);
    const csv = await agent.get('/api/expenses/export.csv').query({ taxYearId: yearId }).expect(200);
    expect(csv.text.split('\r\n')[0]).toContain('Order number');
    expect(csv.text).toContain('PO-78');
  });

  it('finds expenses by line item description and category', async () => {
    const yearId = await createYear();
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    await agent.post('/api/expenses').send(expense(yearId, {
      payee: 'Fuel Co',
      lineItems: [{ description: 'Diesel', amountPence: 2000, categoryId: cat('carVanTravelExpenses') }],
    })).expect(201);
    const byLine = await agent.get('/api/expenses').query({ taxYearId: yearId, search: 'glass', from: '2025-04-06' }).expect(200);
    expect(byLine.body.map((e: { payee: string }) => e.payee)).toEqual(['Bead World']);
    const byCat = await agent.get('/api/expenses').query({ taxYearId: yearId, categoryId: cat('carVanTravelExpenses') }).expect(200);
    expect(byCat.body.map((e: { payee: string }) => e.payee)).toEqual(['Fuel Co']);
  });
});

describe('mileage', () => {
  const trip = (taxYearId: number, overrides: Record<string, unknown> = {}) => ({
    taxYearId,
    date: '2025-06-14',
    description: 'Home to Abingdon Market and back',
    vehicle: 'car',
    distanceTenths: 300,
    ...overrides,
  });

  it('records trips, works out the claim, and refuses dates outside the tax year', async () => {
    const yearId = await createYear();
    const created = (await agent.post('/api/mileage').send(trip(yearId)).expect(201)).body;
    expect(created).toMatchObject({ distanceTenths: 300, claimPence: 1350, createdBy: NAME });
    await agent.post('/api/mileage').send(trip(yearId, { date: '2026-04-06' })).expect(422);
    await agent.post('/api/mileage').send(trip(yearId, { vehicle: 'boat' })).expect(400);

    const edited = (
      await agent.put(`/api/mileage/${created.id}`).send(trip(yearId, { distanceTenths: 400, expectedUpdatedAt: created.updatedAt })).expect(200)
    ).body;
    expect(edited.claimPence).toBe(1800);
    await agent.put(`/api/mileage/${created.id}`).send(trip(yearId, { expectedUpdatedAt: created.updatedAt })).expect(409);

    const { body } = await agent.get('/api/mileage').query({ taxYearId: yearId }).expect(200);
    expect(body.totals).toEqual({ distanceTenths: 400, claimPence: 1800, carDistanceTenths: 400 });
    const csv = (await agent.get('/api/mileage/export.csv').query({ taxYearId: yearId }).expect(200)).text;
    expect(csv).toContain('2025-06-14,Home to Abingdon Market and back,Car or van,40,18.00');
    const json = JSON.parse((await agent.get('/api/mileage/export.json').query({ taxYearId: yearId }).expect(200)).text);
    expect(json.trips).toEqual([
      expect.objectContaining({ date: '2025-06-14', journey: 'Home to Abingdon Market and back', vehicle: 'car', miles: 40, claimPence: 1800 }),
    ]);

    await agent.delete(`/api/mileage/${created.id}`).expect(204);
    expect((await agent.get('/api/mileage').query({ taxYearId: yearId })).body.trips).toHaveLength(0);
  });

  it('switches to 25p once the car passes 10,000 miles in the tax year', async () => {
    const yearId = await createYear();
    await agent.post('/api/mileage').send(trip(yearId, { date: '2025-05-01', distanceTenths: 99_000 })).expect(201);
    const later = (await agent.post('/api/mileage').send(trip(yearId, { date: '2025-07-01', distanceTenths: 2_000 })).expect(201)).body;
    expect(later.claimPence).toBe(100 * 45 + 100 * 25);
    // A trip dated earlier moves the threshold, so the later trip's claim changes.
    await agent.post('/api/mileage').send(trip(yearId, { date: '2025-06-01', distanceTenths: 1_000 })).expect(201);
    expect((await agent.get('/api/mileage').query({ taxYearId: yearId })).body.trips[0].claimPence).toBe(200 * 25);
  });

  it('claims at the rates for the tax year the trip belongs to', async () => {
    const rate = async (startYear: number) => {
      const yearId = await createYear(startYear);
      const trip10Miles = trip(yearId, { date: `${startYear}-05-01`, distanceTenths: 100 });
      return (await agent.post('/api/mileage').send(trip10Miles).expect(201)).body.claimPence;
    };
    expect(await rate(2025)).toBe(450);
    expect(await rate(2026)).toBe(550);
  });

  it('counts claims as car, van and travel expenses in every set of figures', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    await agent.post('/api/mileage').send(trip(yearId)).expect(201);

    const dashboard = (await agent.get('/api/dashboard').query({ taxYearId: yearId }).expect(200)).body;
    expect(dashboard.mtd.periodExpenses).toEqual({ carVanTravelExpenses: 1350 });
    expect(dashboard.totals.netProfitPence).toBe(38000 - 1350);
    expect(dashboard.mileagePence).toBe(1350);

    const quarters = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId }).expect(200)).body.quarters;
    expect(quarters[0].period.periodExpenses.carVanTravelExpenses).toBe(1350);

    const yearEnd = (await agent.get('/api/reports/year-end').query({ taxYearId: yearId }).expect(200)).body.summary;
    expect(yearEnd.expenseBoxes.find((b: { box: string }) => b.box === '12').amountPence).toBe(1350);

    const range = { from: '2025-04-06', to: '2026-04-05' };
    const breakdown = (await agent.get('/api/reports/breakdown').query(range).expect(200)).body;
    expect(breakdown.expenses.groups[0]).toMatchObject({
      hmrcCode: 'carVanTravelExpenses',
      totalPence: 1350,
      count: 1,
      standard: { totalPence: 0, count: 0 },
      flatRates: [{ kind: 'mileage', name: 'Mileage at HMRC rates', totalPence: 1350, count: 1 }],
    });
    const onlyMileage = (await agent.get('/api/reports/breakdown/items').query({ ...range, flatRate: 'mileage' }).expect(200)).body;
    expect(onlyMileage).toMatchObject([{ kind: 'mileage', amountPence: 1350 }]);
    // The standard category on its own is just the expenses recorded against it.
    expect(
      (await agent.get('/api/reports/breakdown/items').query({ ...range, categoryId: cat('carVanTravelExpenses'), group: '0' }).expect(200)).body,
    ).toEqual([]);
    await agent.get('/api/reports/breakdown/items').query({ ...range, flatRate: 'mileage', payee: 'Shell' }).expect(400);
    const items = (
      await agent.get('/api/reports/breakdown/items').query({ ...range, categoryId: cat('carVanTravelExpenses'), group: '1' }).expect(200)
    ).body;
    expect(items).toMatchObject([{ kind: 'mileage', amountPence: 1350, description: 'Home to Abingdon Market and back' }]);
  });

  it('warns when expenses in the same category may claim the car twice', async () => {
    const yearId = await createYear();
    const fuel = (disallowable = false) =>
      expense(yearId, {
        payee: 'Shell',
        lineItems: [{ description: 'Fuel', amountPence: 4000, categoryId: cat('carVanTravelExpenses'), disallowable }],
      });
    // Fuel alone is fine: no mileage, so the actual-costs method is being used.
    await agent.post('/api/expenses').send(fuel()).expect(201);
    await agent.post('/api/expenses').send(fuel(true)).expect(201);
    expect((await agent.get('/api/mileage').query({ taxYearId: yearId })).body.check).toBeNull();

    await agent.post('/api/mileage').send(trip(yearId)).expect(201);
    const check = { mileagePence: 1350, expensesPence: 4000, expenseCount: 1, categoryId: cat('carVanTravelExpenses') };
    expect((await agent.get('/api/mileage').query({ taxYearId: yearId })).body.check).toEqual(check);
    expect((await agent.get('/api/reports/year-end').query({ taxYearId: yearId })).body.mileageCheck).toEqual(check);
  });

  it('is deleted with its tax year', async () => {
    const yearId = await createYear();
    await agent.post('/api/mileage').send(trip(yearId)).expect(201);
    expect((await agent.get('/api/tax-years')).body.taxYears[0].mileageCount).toBe(1);
    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM mileage_trips').get()).toEqual({ n: 0 });
  });
});

describe('use of home', () => {
  const save = (taxYearId: number, months: { index: number; hours: number }[], expectedUpdatedAt?: string | null) =>
    agent.put('/api/use-of-home').send({ taxYearId, months, expectedUpdatedAt });

  it('stores hours for each tax month and works out the flat rate', async () => {
    const yearId = await createYear();
    let { body } = await agent.get('/api/use-of-home').query({ taxYearId: yearId }).expect(200);
    expect(body.months).toHaveLength(12);
    expect(body.months[0]).toMatchObject({ label: 'Apr 25', startDate: '2025-04-06', endDate: '2025-05-05', hours: 0, claimPence: 0 });
    expect(body.updatedAt).toBeNull();

    ({ body } = await save(yearId, [{ index: 0, hours: 30 }, { index: 1, hours: 60 }, { index: 2, hours: 120 }, { index: 3, hours: 10 }], null).expect(200));
    expect(body.months.slice(0, 4).map((m: { claimPence: number }) => m.claimPence)).toEqual([1000, 1800, 2600, 0]);
    expect(body.totals).toEqual({ hours: 220, claimPence: 5400, monthsClaimed: 3 });
    expect(body.updatedBy).toBe(NAME);

    await save(yearId, [{ index: 0, hours: 745 }]).expect(400);
    await save(yearId, [{ index: 12, hours: 30 }]).expect(400);
  });

  it('exports the months with hours to CSV', async () => {
    const yearId = await createYear();
    await save(yearId, [{ index: 0, hours: 30 }, { index: 11, hours: 10 }]).expect(200);
    const csv = await agent.get('/api/use-of-home/export.csv').query({ taxYearId: yearId }).expect(200);
    expect(csv.headers['content-disposition']).toContain('use-of-home-2025-26.csv');
    expect(csv.text.replace('\ufeff', '').trim().split('\r\n')).toEqual([
      'From,To,Hours,Claim (GBP)',
      '2025-04-06,2025-05-05,30,10.00',
      '2026-03-06,2026-04-05,10,0.00',
    ]);
    await agent.get('/api/use-of-home/export.csv').query({ taxYearId: 999 }).expect(404);
    const json = await agent.get('/api/use-of-home/export.json').query({ taxYearId: yearId }).expect(200);
    expect(json.headers['content-disposition']).toContain('use-of-home-2025-26.json');
    expect(JSON.parse(json.text).months).toEqual([
      { from: '2025-04-06', to: '2025-05-05', hours: 30, claimPence: 1000 },
      { from: '2026-03-06', to: '2026-04-05', hours: 10, claimPence: 0 },
    ]);
    await agent.get('/api/use-of-home/export.json').query({ taxYearId: 999 }).expect(404);
  });

  it('refuses a save made from out-of-date hours', async () => {
    const yearId = await createYear();
    const first = (await save(yearId, [{ index: 0, hours: 30 }], null).expect(200)).body;
    const jo = await addPerson('Jo');
    await jo.put('/api/use-of-home').send({ taxYearId: yearId, months: [{ index: 0, hours: 60 }], expectedUpdatedAt: first.updatedAt }).expect(200);
    const stale = await save(yearId, [{ index: 0, hours: 90 }], first.updatedAt).expect(409);
    expect(stale.body.error).toMatch(/^Jo changed these hours/);
  });

  it('counts claims as premises costs in every set of figures', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    await save(yearId, [{ index: 0, hours: 30 }, { index: 3, hours: 120 }]).expect(200);

    const dashboard = (await agent.get('/api/dashboard').query({ taxYearId: yearId }).expect(200)).body;
    expect(dashboard.mtd.periodExpenses).toEqual({ premisesRunningCosts: 3600 });
    expect(dashboard.useOfHomePence).toBe(3600);

    // April (ends 5 May) is in Q1; July (ends 5 August) is in Q2.
    const quarters = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId }).expect(200)).body.quarters;
    expect(quarters[0].period.periodExpenses.premisesRunningCosts).toBe(1000);
    expect(quarters[1].period.periodExpenses.premisesRunningCosts).toBe(2600);

    const yearEnd = (await agent.get('/api/reports/year-end').query({ taxYearId: yearId }).expect(200)).body.summary;
    expect(yearEnd.expenseBoxes.find((b: { box: string }) => b.box === '14').amountPence).toBe(3600);

    const range = { from: '2025-04-06', to: '2025-06-30' };
    const breakdown = (await agent.get('/api/reports/breakdown').query(range).expect(200)).body;
    expect(breakdown.expenses.groups[0]).toMatchObject({
      hmrcCode: 'premisesRunningCosts',
      totalPence: 1000,
      flatRates: [{ kind: 'home', totalPence: 1000, count: 1 }],
    });
    const items = (
      await agent.get('/api/reports/breakdown/items').query({ ...range, categoryId: cat('premisesRunningCosts'), group: '1' }).expect(200)
    ).body;
    expect(items).toMatchObject([{ kind: 'home', date: '2025-05-05', amountPence: 1000 }]);
  });

  it('is deleted with its tax year', async () => {
    const yearId = await createYear();
    await save(yearId, [{ index: 0, hours: 30 }]).expect(200);
    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM home_working_months').get()).toEqual({ n: 0 });
  });
});

describe('tax estimate', () => {
  it('estimates tax on the year-end profit, including other income', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 3_000_000 })).expect(201);
    const stock = [{ description: 'Stock', amountPence: 200_000, categoryId: cat('costOfGoods') }];
    await agent.post('/api/expenses').send(expense(yearId, { lineItems: stock })).expect(201);
    let { body } = await agent.get('/api/reports/tax-estimate').query({ taxYearId: yearId }).expect(200);
    // £28,000 profit: (28,000 − 12,570) at 20% Income Tax and 6% Class 4.
    expect(body.estimate).toMatchObject({ profitPence: 2_800_000, incomeTaxPence: 308_600, class4Pence: 92_580 });
    expect(body).toMatchObject({ usesTradingAllowance: false, recordedTo: '2025-06-14', dueDates: { balancing: '2027-01-31' } });

    await agent.put(`/api/tax-years/${yearId}/tax-settings`).send({ otherIncomePence: 2_000_000 }).expect(200);
    await agent.put(`/api/tax-years/${yearId}/tax-settings`).send({ otherIncomePence: -1 }).expect(400);
    ({ body } = await agent.get('/api/reports/tax-estimate').query({ taxYearId: yearId }).expect(200));
    expect(body.estimate.otherIncomePence).toBe(2_000_000);
    // Tax on £48,000 (£7,086) less tax on the £20,000 salary alone (£1,486).
    expect(body.estimate.incomeTaxPence).toBe(560_000);
    expect((await agent.get('/api/dashboard').query({ taxYearId: yearId })).body.taxEstimate.totalPence).toBe(body.estimate.totalPence);
  });

  it('uses the trading allowance when it gives a lower profit', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 1_500_000 })).expect(201);
    const { body } = await agent.get('/api/reports/tax-estimate').query({ taxYearId: yearId }).expect(200);
    expect(body.usesTradingAllowance).toBe(true);
    expect(body.estimate.profitPence).toBe(1_400_000);
  });
});

describe('dashboard', () => {
  it('summarises the tax year in MTD terms', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    await agent.post('/api/incomes').send(income(yearId, { paymentMethod: 'cash', amountPence: 13800, date: '2026-01-10' })).expect(201);
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);

    const { body } = await agent.get('/api/dashboard').query({ taxYearId: yearId }).expect(200);
    expect(body.totals).toEqual({
      incomePence: 51800,
      cardIncomePence: 38000,
      cashIncomePence: 13800,
      bankIncomePence: 0,
      expensesPence: 4550,
      disallowablePence: 1000,
      allowableExpensesPence: 3550,
      netProfitPence: 48250,
    });
    expect(body.monthly[2].incomePence).toBe(38000);
    expect(body.monthly[9].incomePence).toBe(13800);
    expect(body.monthly[0].expensesPence).toBe(3550);
    expect(body.mtd.periodDisallowableExpenses).toEqual({ otherExpensesDisallowable: 1000 });
  });
});

describe('MTD quarters', () => {
  it('gives quarterly and year-to-date figures for each update period', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-14', amountPence: 38000 })).expect(201);
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-07-06', amountPence: 13800 })).expect(201);
    await agent.post('/api/expenses').send(expense(yearId, { date: '2025-07-05' })).expect(201);

    const { body } = await agent.get('/api/mtd/quarters').query({ taxYearId: yearId }).expect(200);
    const [q1, q2, q3] = body.quarters;
    expect(q1.period.periodIncome).toEqual({ turnover: 38000 });
    expect(q1.period.periodExpenses).toEqual({ costOfGoods: 3000, adminCosts: 550, otherExpenses: 1000 });
    expect(q1.period.periodDisallowableExpenses).toEqual({ otherExpensesDisallowable: 1000 });
    expect(q2.period.periodIncome).toEqual({ turnover: 13800 });
    expect(q2.period.periodExpenses).toEqual({});
    expect(q2.cumulative.periodIncome).toEqual({ turnover: 51800 });
    expect(q2.cumulative.totals.netProfitPence).toBe(51800 - 3550);
    expect(q3.cumulative.totals).toEqual(q2.cumulative.totals);
    expect(q1.submission).toBeNull();
  });

  it('exports a quarter as a CSV of field names and values, with the same columns every time', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-14', amountPence: 38000 })).expect(201);
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-07-06', amountPence: 13805 })).expect(201);
    await agent.post('/api/expenses').send(expense(yearId, { date: '2025-07-06' })).expect(201);

    const url = `/api/mtd/quarters/${yearId}/2/export.csv`;
    const cumulative = await agent.get(url).query({ basis: 'cumulative' }).expect(200);
    expect(cumulative.headers['content-disposition']).toContain('crafty-mtd-2025-26-Q2-year-to-date.csv');
    const figures = (text: string) => {
      const [fields, values, ...rest] = text.trim().split('\r\n').map((line) => line.split(','));
      expect(rest).toEqual([]);
      expect(values).toHaveLength(fields.length);
      return Object.fromEntries(fields.map((field, i) => [field, values[i]]));
    };
    expect(cumulative.text.startsWith('periodStartDate,')).toBe(true);
    const year = figures(cumulative.text);
    expect(Object.keys(year)).toHaveLength(2 + 2 + 15 + 15);
    expect(Object.keys(year).slice(0, 3)).toEqual(['periodStartDate', 'periodEndDate', 'turnover']);
    expect(year).toMatchObject({
      periodStartDate: '2025-04-06',
      periodEndDate: '2025-10-05',
      turnover: '518.05',
      other: '0.00',
      otherExpenses: '10.00',
      otherExpensesDisallowable: '10.00',
      advertisingCostsDisallowable: '0.00',
    });

    const period = await agent.get(url).query({ basis: 'period' }).expect(200);
    expect(period.headers['content-disposition']).toContain('crafty-mtd-2025-26-Q2-quarter-only.csv');
    expect(figures(period.text)).toMatchObject({ periodStartDate: '2025-07-06', periodEndDate: '2025-10-05', turnover: '138.05' });

    await agent.get(url).expect(400);
    await agent.get(`/api/mtd/quarters/${yearId}/5/export.csv`).query({ basis: 'period' }).expect(404);

    const json = await agent.get(`/api/mtd/quarters/${yearId}/2/export.json`).query({ basis: 'cumulative' }).expect(200);
    expect(json.headers['content-disposition']).toContain('crafty-mtd-2025-26-Q2-year-to-date.json');
    const exported = JSON.parse(json.text);
    expect(exported).toMatchObject({ taxYear: '2025-26', quarter: 2, basis: 'cumulative', amountsIn: 'GBP' });
    expect(exported.payload.periodDates).toEqual({ periodStartDate: '2025-04-06', periodEndDate: '2025-10-05' });
    expect(exported.payload.periodIncome.turnover).toBe(518.05);
    expect(exported.payload.periodExpenses.otherExpenses).toBe(10);
    expect(exported.payload.periodDisallowableExpenses.otherExpensesDisallowable).toBe(10);
    await agent.get(`/api/mtd/quarters/${yearId}/2/export.json`).expect(400);
  });

  it('always saves entertainment and depreciation as disallowable', async () => {
    const yearId = await createYear(2026, 'mtd');
    const lines = [
      { description: 'Client lunch', amountPence: 2000, categoryId: cat('businessEntertainmentCosts') },
      { description: 'Old depreciation', amountPence: 500, categoryId: cat('depreciation') },
      { description: 'Stamps', amountPence: 300, categoryId: cat('adminCosts') },
    ];
    const created = await agent
      .post('/api/expenses')
      .send(expense(yearId, { date: '2026-05-02', lineItems: lines }))
      .expect(201);
    expect(created.body.lineItems.map((l: { disallowable: boolean }) => l.disallowable)).toEqual([true, true, false]);
    expect(created.body.disallowablePence).toBe(2500);

    const q1 = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId })).body.quarters[0].cumulative;
    expect(mtdPayload(q1, '2026-04-06', '2026-07-05', 'itemised').periodDisallowableExpenses).toEqual({
      businessEntertainmentCostsDisallowable: 20,
      depreciationDisallowable: 5,
    });
    expect(q1.totals.netProfitPence).toBe(-300);

    // Editing can't undo it.
    const edited = await agent
      .put(`/api/expenses/${created.body.id}`)
      .send(
        expense(yearId, {
          date: '2026-05-02',
          lineItems: created.body.lineItems.map((l: { id: number; description: string; amountPence: number; categoryId: number }) => ({
            id: l.id,
            description: l.description,
            amountPence: l.amountPence,
            categoryId: l.categoryId,
            disallowable: false,
          })),
        }),
      )
      .expect(200);
    expect(edited.body.disallowablePence).toBe(2500);
  });

  it('marks entertainment and depreciation as disallowable in an older backup', async () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 14)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    old.prepare("INSERT INTO tax_years (label, start_date, end_date) VALUES ('2025-26', '2025-04-06', '2026-04-05')").run();
    old.prepare("INSERT INTO expenses (tax_year_id, date, payee, payment_method, total_pence) VALUES (1, '2025-05-02', 'Cafe', 'card', 2300)").run();
    const line = old.prepare(
      `INSERT INTO expense_line_items (expense_id, description, amount_pence, category_id)
       VALUES (1, ?, ?, (SELECT id FROM categories WHERE hmrc_code = ? AND is_custom = 0))`,
    );
    line.run('Client lunch', 2000, 'businessEntertainmentCosts');
    line.run('Stamps', 300, 'adminCosts');
    const dump = dumpSql(old);
    old.close();

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    const { body } = await agent.get('/api/expenses/1').expect(200);
    expect(body.lineItems.map((l: { disallowable: boolean }) => l.disallowable)).toEqual([true, false]);
  });

  it('moves expense descriptions to the notes in an older backup', async () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 15)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    old.prepare("INSERT INTO tax_years (label, start_date, end_date) VALUES ('2025-26', '2025-04-06', '2026-04-05')").run();
    const row = old.prepare(
      "INSERT INTO expenses (tax_year_id, date, payee, payment_method, total_pence, description, notes) VALUES (1, '2025-05-02', 'Cafe', 'card', 300, ?, ?)",
    );
    row.run('Described', null);
    row.run('Described', 'Noted');
    row.run(null, 'Noted');
    row.run(null, null);
    row.run('D'.repeat(100), 'N'.repeat(1950));
    const dump = dumpSql(old);
    old.close();

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    const notes = async (id: number) => (await agent.get(`/api/expenses/${id}`).expect(200)).body;
    expect((await notes(1)).notes).toBe('Described');
    expect((await notes(2)).notes).toBe('Noted\nDescribed');
    expect((await notes(3)).notes).toBe('Noted');
    expect((await notes(4)).notes).toBeNull();
    expect((await notes(5)).notes).toHaveLength(2000);
    expect(await notes(1)).not.toHaveProperty('description');
  });

  it('exports just the income and one expenses total when the year sends one total', async () => {
    const yearId = await createYear(2025, 'mtd');
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-14', amountPence: 38000 })).expect(201);
    await agent.post('/api/expenses').send(expense(yearId, { date: '2025-06-20' })).expect(201);
    await agent.put(`/api/tax-years/${yearId}/mtd-expenses`).send({ mtdExpenses: 'consolidated' }).expect(200);

    const { text } = await agent.get(`/api/mtd/quarters/${yearId}/1/export.csv`).query({ basis: 'cumulative' }).expect(200);
    expect(text.trim().split('\r\n')).toEqual([
      'periodStartDate,periodEndDate,turnover,other,consolidatedExpenses',
      '2025-04-06,2025-07-05,380.00,0.00,35.50',
    ]);
  });

  it('records, updates and clears a submission, and deletes it with the tax year', async () => {
    const yearId = await createYear(2025, 'mtd');
    await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-01', reference: 'ABC123' }).expect(200);
    await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-02' }).expect(200);
    let { body } = await agent.get('/api/mtd/quarters').query({ taxYearId: yearId });
    expect(body.quarters[0].submission).toMatchObject({ submittedOn: '2025-08-02', reference: null, sent: null });

    await agent.put(`/api/mtd/quarters/${yearId}/5/submission`).send({ submittedOn: '2025-08-02' }).expect(404);
    // Q2 ends 5 Oct, so HMRC takes it from 25 Sep at the earliest.
    const early = await agent.put(`/api/mtd/quarters/${yearId}/2/submission`).send({ submittedOn: '2025-09-24' }).expect(400);
    expect(early.body.error).toMatch(/25 Sep 2025/);
    await agent.delete(`/api/mtd/quarters/${yearId}/1/submission`).expect(204);
    ({ body } = await agent.get('/api/mtd/quarters').query({ taxYearId: yearId }));
    expect(body.quarters[0].submission).toBeNull();

    await agent.put(`/api/mtd/quarters/${yearId}/2/submission`).send({ submittedOn: '2025-11-01' }).expect(200);
    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM mtd_submissions').get() as { n: number }).n).toBe(0);
  });

  it('only records quarterly updates for Making Tax Digital years', async () => {
    const yearId = await createYear();
    expect((await agent.get('/api/tax-years')).body.taxYears[0]).toMatchObject({
      submissionMethod: 'self_assessment',
      mtdUpdates: { recorded: 0, sent: 0 },
    });
    const refused = await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-01' }).expect(409);
    expect(refused.body.error).toMatch(/Settings → Tax Years/);

    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'mtd' }).expect(200);
    await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-01' }).expect(200);
    const { body } = await agent.get('/api/tax-years');
    expect(body.taxYears[0]).toMatchObject({ submissionMethod: 'mtd', mtdUpdates: { recorded: 1, sent: 0 } });
  });

  it('only goes back to Self Assessment while a year has no quarterly updates', async () => {
    const yearId = await createYear(2025, 'mtd');
    await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-01' }).expect(200);
    const back = () => agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'self_assessment' });
    expect((await back().expect(409)).body.error).toMatch(/2025\/26 has quarterly updates, so it stays Making Tax Digital/);

    // One recorded by mistake can be removed, and then the year can go back.
    await agent.delete(`/api/mtd/quarters/${yearId}/1/submission`).expect(204);
    expect((await back().expect(200)).body.taxYears[0].submissionMethod).toBe('self_assessment');
    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'other' }).expect(400);
  });

  it('saves the figures when a quarter is recorded by hand, until a new date records them again', async () => {
    const yearId = await createYear(2025, 'mtd');
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-14', amountPence: 10000 })).expect(201);
    const recorded = async () => (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId })).body.quarters[0].submission;
    const put = (send: object) => agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send(send).expect(200);

    await put({ submittedOn: '2025-08-01' });
    expect((await recorded()).recordedPayload.periodIncome.turnover).toBe(100);

    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-15', amountPence: 5000 })).expect(201);
    await put({ submittedOn: '2025-08-01', reference: 'ABC' });
    expect((await recorded()).recordedPayload.periodIncome.turnover).toBe(100);

    await put({ submittedOn: '2025-08-02', reference: 'ABC' });
    expect((await recorded()).recordedPayload.periodIncome.turnover).toBe(150);
  });

  it('upgrades a backup made before figures were saved with records', async () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 16)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    old.prepare("INSERT INTO tax_years (label, start_date, end_date, submission_method) VALUES ('2025-26', '2025-04-06', '2026-04-05', 'mtd')").run();
    old.prepare("INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on) VALUES (1, 1, '2025-08-01')").run();
    const dump = dumpSql(old);
    old.close();

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/tax-years')).body.taxYears[0].saFiledOn).toBeNull();
    const { body } = await agent.get('/api/mtd/quarters').query({ taxYearId: 1 });
    expect(body.quarters[0].submission.recordedPayload).toBeNull();
    expect((await agent.get('/api/reports/year-end').query({ taxYearId: 1 })).body.filedFiguresChanged).toBe(false);
  });
});

describe('filing a Self Assessment return', () => {
  const filed = (yearId: number, filedOn: string) => agent.put(`/api/tax-years/${yearId}/self-assessment-filed`).send({ filedOn });
  const changed = async (yearId: number) => (await agent.get('/api/reports/year-end').query({ taxYearId: yearId })).body.filedFiguresChanged;

  it('notices when the figures change after filing, until it is filed again', async () => {
    const yearId = await createYear(2025);
    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-14', amountPence: 10000 })).expect(201);
    expect(await changed(yearId)).toBe(false);

    const { body } = await filed(yearId, '2026-06-01').expect(200);
    expect(body.taxYears[0].saFiledOn).toBe('2026-06-01');
    expect(await changed(yearId)).toBe(false);

    await agent.post('/api/incomes').send(income(yearId, { date: '2025-06-15', amountPence: 5000 })).expect(201);
    expect(await changed(yearId)).toBe(true);

    // The same date is no new filing; a new one is the amended return.
    await filed(yearId, '2026-06-01').expect(200);
    expect(await changed(yearId)).toBe(true);
    await filed(yearId, '2026-07-01').expect(200);
    expect(await changed(yearId)).toBe(false);

    const cleared = await agent.delete(`/api/tax-years/${yearId}/self-assessment-filed`).expect(200);
    expect(cleared.body.taxYears[0].saFiledOn).toBeNull();
  });

  it('refuses a return before the year ends, or for an MTD year', async () => {
    const yearId = await createYear(2025);
    expect((await filed(yearId, '2026-04-05').expect(400)).body.error).toMatch(/runs until 5 Apr 2026/);
    const mtdYear = await createYear(2026, 'mtd');
    expect((await filed(mtdYear, '2027-06-01').expect(409)).body.error).toMatch(/set to Making Tax Digital/);
  });

  it('keeps a year with a filed return on Self Assessment', async () => {
    const yearId = await createYear(2025);
    await filed(yearId, '2026-06-01').expect(200);
    const to = () => agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'mtd' });
    expect((await to().expect(409)).body.error).toMatch(/recorded as filed/);
    await agent.delete(`/api/tax-years/${yearId}/self-assessment-filed`).expect(200);
    await to().expect(200);
  });

  it('is refused for a read-only person', async () => {
    const yearId = await createYear(2025);
    await agent.post('/api/users').send({ name: 'Viewer', password: 'viewer-password', role: 'viewer' }).expect(201);
    const viewer = request.agent(createApp(ctx));
    await viewer.post('/api/auth/login').send({ name: 'Viewer', password: 'viewer-password' }).expect(200);
    await viewer.put(`/api/tax-years/${yearId}/self-assessment-filed`).send({ filedOn: '2026-06-01' }).expect(403);
  });
});

describe('automatic backups', () => {
  const backups = () => fs.readdirSync(path.join(dataDir, 'backups')).filter((n) => n.endsWith('.zip')).sort();
  const at = (iso: string) => new Date(iso);

  it('works out when a backup is due and when the next one runs', () => {
    const s = { enabled: true, time: '02:00', keep: 30 };
    expect(isAutoBackupDue(s, at('2026-10-27T01:59:00'), null)).toBe(false);
    expect(isAutoBackupDue(s, at('2026-10-27T02:00:00'), null)).toBe(true);
    expect(isAutoBackupDue(s, at('2026-10-27T09:00:00'), '2026-10-26')).toBe(true);
    expect(isAutoBackupDue(s, at('2026-10-27T09:00:00'), '2026-10-27')).toBe(false);
    expect(isAutoBackupDue({ ...s, enabled: false }, at('2026-10-27T09:00:00'), null)).toBe(false);
    expect(new Date(nextAutoBackup(s, at('2026-10-27T01:00:00'), null)!).getHours()).toBe(2);
    expect(new Date(nextAutoBackup(s, at('2026-10-27T09:00:00'), '2026-10-27')!).getDate()).toBe(28);
    expect(nextAutoBackup({ ...s, enabled: false }, at('2026-10-27T09:00:00'), null)).toBeNull();
  });

  it('writes a zip, skips when nothing changed, and keeps only the newest', async () => {
    const yearId = await createYear();
    await agent.put('/api/backup/auto').send({ enabled: true, time: '02:00', keep: 2 }).expect(200);

    expect((await runAutoBackup(ctx, { now: at('2026-10-25T02:00:00') })).status).toBe('created');
    expect((await runAutoBackup(ctx, { now: at('2026-10-26T02:00:00') })).status).toBe('skipped');
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    expect((await runAutoBackup(ctx, { now: at('2026-10-27T02:00:00') })).status).toBe('created');
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    expect((await runAutoBackup(ctx, { now: at('2026-10-28T02:00:00') })).status).toBe('created');

    expect(backups()).toEqual(['crafty-accounting-auto-2026-10-27-0200.zip', 'crafty-accounting-auto-2026-10-28-0200.zip']);
    const { body } = await agent.get('/api/backup/auto').expect(200);
    expect(body).toMatchObject({ enabled: true, time: '02:00', keep: 2, folderWritable: true });
    expect(body.lastRun).toMatchObject({ status: 'created', file: 'crafty-accounting-auto-2026-10-28-0200.zip' });
    expect(body.backups).toHaveLength(2);
    // The test's backup folder is inside its data folder.
    expect(body.storage.sameDisk).toBe(true);
    expect(body.storage.data.totalBytes).toBeGreaterThan(0);
    expect(body.storage.data.freeBytes).toBeGreaterThan(0);
    expect(body.storage.data.freeBytes).toBeLessThanOrEqual(body.storage.data.totalBytes);
  });

  it('backs up on demand, downloads files and restores from them', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    const { body } = await agent.post('/api/backup/auto/run').expect(200);
    const name = body.backups[0].name;
    const zip = await agent
      .get(`/api/backup/auto/files/${name}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    await agent.get('/api/backup/auto/files/..%2Fcrafty.db').expect(404);
    await agent.get('/api/backup/auto/files/other.zip').expect(404);

    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    await agent.post('/api/restore').attach('file', zip.body as Buffer, name).expect(200);
    expect((await agent.get('/api/tax-years')).body.taxYears).toHaveLength(1);
  });

  it('restores a saved backup in place, keeping the later ones', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    const first = (await agent.post('/api/backup/auto/run').expect(200)).body.backups[0].name;
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    await agent.post('/api/backup/auto/run').expect(200);

    await agent.post(`/api/backup/auto/files/${first}/restore`).expect(200);
    const [year] = (await agent.get('/api/tax-years')).body.taxYears;
    expect((await agent.get('/api/incomes').query({ taxYearId: year.id })).body).toHaveLength(1);
    const { backups } = (await agent.get('/api/backup/auto')).body;
    expect(backups).toHaveLength(2);
    // The second backup that minute is named -2 and comes first.
    expect(backups[1].name).toBe(first);
    expect(fs.readdirSync(ctx.paths.tmpDir).filter((f) => f.startsWith('restore-'))).toEqual([]);

    await agent.post('/api/backup/auto/files/..%2Fcrafty.db/restore').expect(404);
    await agent.post('/api/backup/auto/files/crafty-accounting-auto-2020-01-01-0200.zip/restore').expect(404);
  });

  it('deletes a saved backup, and backs up again next time if it was the newest', async () => {
    const yearId = await createYear();
    const first = (await agent.post('/api/backup/auto/run').expect(200)).body.backups[0].name;
    await agent.post('/api/incomes').send(income(yearId)).expect(201);
    const second = (await agent.post('/api/backup/auto/run').expect(200)).body.backups[0].name;

    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await viewer.delete(`/api/backup/auto/files/${first}`).expect(403);

    const afterOlder = (await agent.delete(`/api/backup/auto/files/${first}`).expect(200)).body;
    expect(afterOlder.backups.map((b: { name: string }) => b.name)).toEqual([second]);
    expect(fs.existsSync(path.join(ctx.paths.backupDir, first))).toBe(false);
    // The data hasn't changed since the newest backup, so a scheduled run still skips.
    expect((await runAutoBackup(ctx)).status).toBe('skipped');

    expect((await agent.delete(`/api/backup/auto/files/${second}`).expect(200)).body.backups).toEqual([]);
    expect((await runAutoBackup(ctx)).status).toBe('created');

    await agent.delete(`/api/backup/auto/files/${second}`).expect(404);
    await agent.delete('/api/backup/auto/files/..%2Fcrafty.db').expect(404);
    expect(fs.existsSync(ctx.paths.dbFile)).toBe(true);
  });

  it('validates settings and keeps them through a reset and a restore', async () => {
    await agent.put('/api/backup/auto').send({ enabled: true, time: '25:00', keep: 30 }).expect(400);
    await agent.put('/api/backup/auto').send({ enabled: true, time: '02:00', keep: 0 }).expect(400);
    await agent.put('/api/backup/auto').send({ enabled: false, time: '23:30', keep: 7 }).expect(200);
    const dump = (await agent.get('/api/backup.sql')).text;
    await agent.put('/api/backup/auto').send({ enabled: true, time: '04:15', keep: 14 }).expect(200);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/backup/auto')).body).toMatchObject({ enabled: true, time: '04:15', keep: 14 });
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/backup/auto')).body).toMatchObject({ enabled: true, time: '04:15', keep: 14 });
  });

  it('records a failure when the folder cannot be written', async () => {
    ctx.paths.backupDir = path.join(dataDir, 'not-a-folder.txt', 'backups');
    fs.writeFileSync(path.join(dataDir, 'not-a-folder.txt'), 'x');
    const result = await runAutoBackup(ctx, { force: true });
    expect(result.status).toBe('failed');
    const { body } = await agent.get('/api/backup/auto').expect(200);
    expect(body.folderWritable).toBe(false);
    expect(body.lastRun.status).toBe('failed');
    await agent.post('/api/backup/auto/run').expect(500);
  });
});

describe('breakdown report', () => {
  async function seedBreakdown() {
    const y1 = await createYear(2025);
    const y2 = await createYear(2026);
    const packaging = (await agent.post('/api/categories').send({ name: 'Packaging', mapsToCategoryId: cat('costOfGoods') })).body;
    const etsy = (await agent.post('/api/categories').send({ name: 'Etsy sales', mapsToCategoryId: cat('turnover') })).body;
    const line = (description: string, amountPence: number, categoryId: number, disallowable = false) => ({
      description,
      amountPence,
      categoryId,
      disallowable,
    });
    const exp = (taxYearId: number, date: string, payee: string, lines: ReturnType<typeof line>[]) =>
      agent
        .post('/api/expenses')
        .send(expense(taxYearId, { date, payee, lineItems: lines }))
        .expect(201);
    await exp(y1, '2026-03-10', 'Bead World', [line('Beads', 3000, cat('costOfGoods')), line('Boxes', 500, packaging.id)]);
    await exp(y1, '2026-03-20', 'bead world', [line('Gift bags', 700, packaging.id), line('Lunch', 900, cat('otherExpenses'), true)]);
    await exp(y2, '2026-04-10', 'Packaging Co', [line('Tissue paper', 1200, packaging.id)]);
    await exp(y1, '2026-02-01', 'Old Supplier', [line('Old boxes', 999, packaging.id)]);
    await agent.post('/api/incomes').send(income(y1, { date: '2026-03-15', amountPence: 20000 })).expect(201);
    await agent.post('/api/incomes').send(income(y2, { date: '2026-04-15', amountPence: 5000, categoryId: etsy.id })).expect(201);
    return { packaging, etsy };
  }

  it('totals a date range across tax years, grouping custom categories under their MTD category', async () => {
    const { packaging } = await seedBreakdown();
    const { body } = await agent.get('/api/reports/breakdown').query({ from: '2026-03-01', to: '2026-04-30' }).expect(200);

    expect(body.income.totalPence).toBe(25000);
    expect(body.income.groups).toHaveLength(1);
    expect(body.income.groups[0].custom.map((c: { name: string; totalPence: number }) => [c.name, c.totalPence])).toEqual([
      ['Etsy sales', 5000],
    ]);

    expect(body.expenses.totalPence).toBe(3000 + 500 + 700 + 900 + 1200);
    expect(body.expenses.disallowablePence).toBe(900);
    const cog = body.expenses.groups.find((g: { hmrcCode: string }) => g.hmrcCode === 'costOfGoods');
    expect(cog.standard.totalPence).toBe(3000);
    expect(cog.custom).toEqual([expect.objectContaining({ categoryId: packaging.id, totalPence: 2400, count: 3 })]);
    expect(cog.totalPence).toBe(5400);
    expect(body.expenses.groups[0].hmrcCode).toBe('costOfGoods');

    expect(body.payees).toEqual([
      { payee: 'Bead World', totalPence: 5100, count: 2 },
      { payee: 'Packaging Co', totalPence: 1200, count: 1 },
    ]);
  });

  it('lists the items behind a category, a category group or a payee', async () => {
    const { packaging, etsy } = await seedBreakdown();
    const range = { from: '2026-03-01', to: '2026-04-30' };
    const items = async (q: Record<string, string | number>) =>
      (await agent.get('/api/reports/breakdown/items').query({ ...range, ...q }).expect(200)).body as {
        description: string;
        amountPence: number;
        kind: string;
      }[];

    expect((await items({ categoryId: packaging.id })).map((i) => i.description)).toEqual(['Boxes', 'Gift bags', 'Tissue paper']);
    expect((await items({ categoryId: cat('costOfGoods') })).map((i) => i.description)).toEqual(['Beads']);
    expect(await items({ categoryId: cat('costOfGoods'), group: '1' })).toHaveLength(4);
    expect((await items({ payee: 'BEAD WORLD' })).map((i) => i.description)).toEqual(['Beads', 'Boxes', 'Gift bags', 'Lunch']);
    const incomes = await items({ categoryId: cat('turnover'), group: '1' });
    expect(incomes.map((i) => [i.kind, i.amountPence])).toEqual([
      ['income', 20000],
      ['income', 5000],
    ]);
    expect(await items({ categoryId: etsy.id })).toHaveLength(1);
  });

  it('validates the range and the drill-down', async () => {
    await agent.get('/api/reports/breakdown').query({ from: '2026-05-01', to: '2026-04-01' }).expect(400);
    await agent.get('/api/reports/breakdown').query({ from: '2026-05-01' }).expect(400);
    await agent.get('/api/reports/breakdown/items').query({ from: '2026-04-01', to: '2026-05-01' }).expect(400);
    await agent.get('/api/reports/breakdown/items').query({ from: '2026-04-01', to: '2026-05-01', categoryId: 9999 }).expect(404);
  });
});

describe('years before Making Tax Digital', () => {
  it('can only go on a Self Assessment return', async () => {
    await agent.post('/api/tax-years').send({ startYear: 2024, submissionMethod: 'mtd' }).expect(400);
    const yearId = await createYear(2024);
    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'mtd' }).expect(400);
    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'self_assessment' }).expect(200);
    await agent.post('/api/tax-years').send({ startYear: 2025, submissionMethod: 'mtd' }).expect(201);
  });

  it('can move back to Self Assessment if one is already in MTD', async () => {
    const yearId = await createYear(2024);
    ctx.db.prepare("UPDATE tax_years SET submission_method = 'mtd' WHERE id = ?").run(yearId);
    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'mtd' }).expect(200);
    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'self_assessment' }).expect(200);
    await agent.put(`/api/tax-years/${yearId}/submission-method`).send({ submissionMethod: 'mtd' }).expect(400);
  });
});

describe('year-end summary', () => {
  it('gives SA103S figures that agree with the MTD totals, including custom categories', async () => {
    const yearId = await createYear();
    const filament = (await agent.post('/api/categories').send({ name: 'Filament', mapsToCategoryId: cat('costOfGoods') })).body;
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 120000 })).expect(201);
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 5000, categoryId: cat('other'), date: '2026-01-10' })).expect(201);
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
      .expect(201);

    const { body } = await agent.get('/api/reports/year-end').query({ taxYearId: yearId }).expect(200);
    expect(body.filingDeadline).toBe('2027-01-31');
    expect(body.summary.form).toMatchObject({ label: '2025-26', assumed: false, netProfit: { box: '21' } });
    const boxes = Object.fromEntries(
      [...body.summary.incomeBoxes, ...body.summary.expenseBoxes].map((b: { box: string; amountPence: number }) => [b.box, b.amountPence]),
    );
    expect(boxes).toMatchObject({ '9': 120000, '10': 5000, '11': 5500, '18': 550, '19': 0 });
    expect(body.summary.totalAllowableExpensesPence).toBe(6050);
    expect(body.summary.disallowable).toEqual([{ hmrcCode: 'otherExpenses', amountPence: 1000 }]);

    const quarters = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId })).body.quarters;
    expect(body.summary.netProfitPence).toBe(quarters[3].cumulative.totals.netProfitPence);
  });

  it('says when a year uses a form that has not been checked', async () => {
    const yearId = await createYear(2099);
    const { body } = await agent.get('/api/reports/year-end').query({ taxYearId: yearId }).expect(200);
    expect(body.summary.form).toMatchObject({ label: '2025-26', assumed: true });
  });
});

describe('backup and restore', () => {
  async function seed() {
    const yearId = await createYear();
    await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId, { notes: "Line one\nIt's line two" })))
      .attach('documents', PDF, 'payout.pdf')
      .expect(201);
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    return yearId;
  }

  const snapshot = () => ({
    incomes: ctx.db.prepare('SELECT * FROM incomes').all(),
    expenses: ctx.db.prepare('SELECT * FROM expenses').all(),
    lines: ctx.db.prepare('SELECT * FROM expense_line_items').all(),
    years: ctx.db.prepare('SELECT * FROM tax_years').all(),
  });

  it('round-trips an SQL dump', async () => {
    const yearId = await seed();
    const before = snapshot();
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump.split('\n').filter((l) => l.startsWith('INSERT INTO "incomes"'))).toHaveLength(1);

    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect(snapshot()).toEqual(before);
  });

  it('round-trips a zip backup including documents', async () => {
    const yearId = await seed();
    const before = snapshot();
    const zip = await agent
      .get('/api/backup.zip')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'payout.pdf'))).toBe(false);

    await agent.post('/api/restore').attach('file', zip.body as Buffer, 'backup.zip').expect(200);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(path.join(dataDir, 'uploads', 'payout.pdf'))).toEqual(PDF);
  });

  it('resets to an empty database, keeping copies of the old data', async () => {
    await seed();
    await agent.post('/api/categories').send({ name: 'Printer filament', mapsToCategoryId: cat('costOfGoods') }).expect(201);
    await agent.post('/api/reset').send({ confirm: 'reset' }).expect(400);
    expect((await agent.get('/api/tax-years')).body.taxYears).toHaveLength(1);

    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    const count = (table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    for (const table of ['tax_years', 'incomes', 'expenses', 'expense_line_items', 'mtd_submissions', 'settings']) {
      expect(count(table)).toBe(0);
    }
    const categories = (await agent.get('/api/categories').expect(200)).body;
    expect(categories).toHaveLength(17);
    expect(categories.every((c: { isCustom: boolean }) => !c.isCustom)).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, 'uploads.pre-reset', 'payout.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'crafty.pre-reset.db'))).toBe(true);

    expect(await createYear()).toBe(1);
  });

  it('keeps custom categories through a reset when asked, emptying everything else', async () => {
    await seed();
    const filament = (
      await agent.post('/api/categories').send({ name: 'Printer filament', mapsToCategoryId: cat('costOfGoods') }).expect(201)
    ).body;
    const before = ctx.db.prepare('SELECT * FROM categories ORDER BY id').all();
    await agent.post('/api/reset').send({ confirm: 'RESET', keepCustomCategories: 'yes' }).expect(400);

    await agent.post('/api/reset').send({ confirm: 'RESET', keepCustomCategories: true }).expect(200);
    const count = (table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    for (const table of ['tax_years', 'incomes', 'expenses', 'expense_line_items', 'mtd_submissions', 'scans', 'documents', 'settings']) {
      expect(count(table)).toBe(0);
    }
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toHaveLength(0);
    // Same rows, ids, names and mappings.
    expect(ctx.db.prepare('SELECT * FROM categories ORDER BY id').all()).toEqual(before);
    const categories = (await agent.get('/api/categories').expect(200)).body as { id: number; isCustom: boolean }[];
    expect(categories.find((c) => c.id === filament.id)).toMatchObject({ name: 'Printer filament', isCustom: true });

    // The kept category can be used in the new books.
    const yearId = await createYear();
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { lineItems: [{ description: 'PLA', amountPence: 2000, categoryId: filament.id }] }))
      .expect(201);

    // Without the flag (false, too) they go.
    await agent.post('/api/reset').send({ confirm: 'RESET', keepCustomCategories: false }).expect(200);
    expect(count('categories WHERE is_custom = 1')).toBe(0);
  });

  it('refuses files that are not backups or contain other statements', async () => {
    await createYear();
    await agent.post('/api/restore').attach('file', Buffer.from('hello'), 'backup.sql').expect(400);
    const dump = (await agent.get('/api/backup.sql')).text;
    const tampered = `${dump}ATTACH DATABASE '/tmp/x.db' AS x;\n`;
    const res = await agent.post('/api/restore').attach('file', Buffer.from(tampered), 'backup.sql').expect(400);
    expect(res.body.error).toMatch(/unexpected statement/);
    const smuggled = dump.replace(/(INSERT INTO "tax_years"[^\n]*;)/, "$1 ATTACH DATABASE '/tmp/x.db' AS x;");
    await agent.post('/api/restore').attach('file', Buffer.from(smuggled), 'backup.sql').expect(400);
    expect((await agent.get('/api/tax-years')).body.taxYears).toHaveLength(1);
  });

  it('keeps everyone signed in through a restore and a reset, without putting passwords in backups', async () => {
    await seed();
    const jo = await addPerson('Jo');
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).not.toMatch(/INSERT INTO "users"/);
    expect(dump).not.toMatch(/scrypt\$/);

    await agent.post('/api/users').send({ name: 'Sam', password: 'added-after', role: 'viewer' }).expect(201);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await jo.get('/api/users').expect(200)).body.map((u: { name: string; role: string }) => `${u.name} ${u.role}`)).toEqual([
      'Admin editor',
      'Jo editor',
      'Sam viewer',
    ]);
    expect((await agent.get('/api/incomes').query({ taxYearId: 1 })).body[0].createdBy).toBe(NAME);

    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    await jo.get('/api/tax-years').expect(200);
    expect((await agent.post('/api/users').send({ name: 'Alex', password: 'one-more-person' }).expect(201)).body.id).toBe(4);
  });

  it('upgrades a backup made before sign-ins', async () => {
    // Build a version 1 database the way the first release did.
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    old.exec(MIGRATIONS[0].sql);
    old.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
    seedCategories(old);
    old.prepare("INSERT INTO tax_years (label, start_date, end_date) VALUES ('2025-26', '2025-04-06', '2026-04-05')").run();
    old.prepare("INSERT INTO settings (key, value) VALUES ('active_tax_year_id', '1')").run();
    old
      .prepare(
        `INSERT INTO incomes (tax_year_id, date, description, payment_method, amount_pence, category_id, document_filename)
         VALUES (1, '2025-06-14', 'Market sales', 'cash', 1500, ?, 'old receipt.pdf')`,
      )
      .run(cat('turnover'));
    const dump = dumpSql(old);
    old.close();
    expect(dump).toMatch(/schema_version: 1/);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/incomes').query({ taxYearId: 1 }).expect(200)).body).toMatchObject([
      { description: 'Market sales', createdBy: null, updatedBy: null, documents: [{ filename: 'old receipt.pdf' }] },
    ]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM incomes WHERE document_filename IS NOT NULL').get()).toEqual({ n: 0 });
    expect((await agent.get('/api/tax-years')).body).toMatchObject({ activeTaxYearId: 1, taxYears: [{ otherIncomePence: 0, mileageCount: 0 }] });
    expect((await agent.get('/api/mileage').query({ taxYearId: 1 }).expect(200)).body.trips).toEqual([]);
    expect((await agent.get('/api/use-of-home').query({ taxYearId: 1 }).expect(200)).body.totals.claimPence).toBe(0);
    expect(ctx.db.prepare("SELECT 1 FROM settings WHERE key = 'active_tax_year_id'").get()).toBeUndefined();
    expect((await agent.get('/api/users')).body.map((u: { name: string }) => u.name)).toEqual([NAME]);
    expect((await agent.get('/api/notifications').expect(200)).body).toEqual({ notifications: [] });
  });
});

describe('HMRC connection', () => {
  const TOKEN_URL = 'https://test-api.service.hmrc.gov.uk/oauth/token';
  let tokenRequests: URLSearchParams[];
  let tokenReply: () => { status: number; body: unknown };
  let issued: number;
  /** Calls to HMRC's APIs (anything but the token endpoint), and their answers by path. */
  let apiRequests: { url: URL; method: string; headers: Record<string, string>; body: unknown }[];
  let apiReplies: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>;

  beforeEach(() => {
    ctx.config.hmrc = { environment: 'sandbox', clientId: 'test-client', clientSecret: 'test-secret', redirectUri: null };
    tokenRequests = [];
    issued = 0;
    tokenReply = () => {
      issued += 1;
      return { status: 200, body: { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 14400, scope: 'read:self-assessment write:self-assessment' } };
    };
    apiRequests = [];
    apiReplies = {};
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    ctx.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === TOKEN_URL) {
        const fields = new URLSearchParams(String(init?.body));
        if (fields.get('grant_type') === 'client_credentials') return json(200, { access_token: 'app-token', expires_in: 14400 });
        tokenRequests.push(fields);
        const { status, body } = tokenReply();
        return json(status, body);
      }
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://test-api.service.hmrc.gov.uk');
      apiRequests.push({
        url: parsed,
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const reply = apiReplies[parsed.pathname];
      if (!reply) throw new Error(`Unexpected HMRC call to ${parsed.pathname}`);
      if (reply.status === 204) return new Response(null, { status: 204, headers: reply.headers });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json', ...reply.headers } });
    }) as typeof fetch;
  });

  /** Starts a sign-in and comes back from HMRC with a code, as the browser would. */
  async function connect(as = agent) {
    const { url } = (await as.post('/api/hmrc/connect').expect(200)).body;
    const state = new URL(url).searchParams.get('state')!;
    return as.get('/api/hmrc/callback').query({ code: 'the-code', state }).expect(302);
  }

  it('offers nothing but its status until the credentials are set', async () => {
    ctx.config.hmrc = { environment: 'sandbox', clientId: null, clientSecret: null, redirectUri: null };
    const status = (await agent.get('/api/hmrc').expect(200)).body;
    expect(status).toEqual({ environment: 'sandbox', configured: false, redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/hmrc\/callback$/), nino: null, business: null, connection: null });
    await agent.post('/api/hmrc/connect').expect(404);
    await agent.get('/api/hmrc/callback').expect(404);
    await agent.put('/api/hmrc/nino').send({ nino: 'AB123456C' }).expect(404);
    await agent.get('/api/hmrc/obligations').expect(404);
    await agent.get('/api/hmrc/fraud-headers/check').expect(404);
    await agent.delete('/api/hmrc/connection').expect(404);

    ctx.config.hmrc.redirectUri = 'https://books.example.com/api/hmrc/callback';
    expect((await agent.get('/api/hmrc')).body.redirectUri).toBe('https://books.example.com/api/hmrc/callback');
  });

  it('keeps a saved connection for when the credentials come back', async () => {
    await agent.put('/api/hmrc/nino').send({ nino: 'AB123456C' }).expect(200);
    await connect();
    const credentials = ctx.config.hmrc;

    ctx.config.hmrc = { ...credentials, clientId: null, clientSecret: null };
    expect((await agent.get('/api/hmrc')).body).toMatchObject({ configured: false, nino: null, business: null, connection: null });

    ctx.config.hmrc = credentials;
    const status = (await agent.get('/api/hmrc')).body;
    expect(status).toMatchObject({ configured: true, nino: 'AB123456C' });
    expect(status.connection).not.toBeNull();
  });

  it('checks and tidies the National Insurance number', async () => {
    expect((await agent.put('/api/hmrc/nino').send({ nino: 'qq 12 34 56 c' }).expect(400)).body.error).toMatch(/National Insurance/);
    expect((await agent.put('/api/hmrc/nino').send({ nino: 'AB123456E' }).expect(400)).body.error).toMatch(/National Insurance/);
    await agent.put('/api/hmrc/nino').send({ nino: 'ab 12 34 56 c' }).expect(200);
    expect((await agent.get('/api/hmrc')).body.nino).toBe('AB123456C');
    await agent.put('/api/hmrc/nino').send({ nino: null }).expect(200);
    expect((await agent.get('/api/hmrc')).body.nino).toBeNull();
  });

  it('signs in to HMRC with PKCE and stores the tokens', async () => {
    const { url } = (await agent.post('/api/hmrc/connect').expect(200)).body;
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe('https://test-www.tax.service.gov.uk/oauth/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'test-client',
      scope: 'read:self-assessment write:self-assessment',
      code_challenge_method: 'S256',
      redirect_uri: expect.stringMatching(/\/api\/hmrc\/callback$/),
    });

    // A made-up state is refused without asking HMRC for tokens, and ends the attempt.
    const forged = await agent.get('/api/hmrc/callback').query({ code: 'x', state: 'forged' }).expect(302);
    expect(decodeURIComponent(forged.headers.location)).toMatch(/^\/settings\/hmrc\?error=.*expired/);
    expect(tokenRequests).toHaveLength(0);

    const res = await connect();
    expect(res.headers.location).toBe('/settings/hmrc?connected=1');
    const sent = Object.fromEntries(tokenRequests[0]);
    expect(sent).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'test-client', client_secret: 'test-secret' });

    const status = (await agent.get('/api/hmrc').expect(200)).body;
    expect(status.connection).toMatchObject({ connectedBy: NAME });
    const months = (Date.parse(status.connection.expiresAt) - Date.parse(status.connection.connectedAt)) / (30.4 * 24 * 3600 * 1000);
    expect(Math.round(months)).toBe(18);
    expect(JSON.stringify(status)).not.toMatch(/access-|refresh-/);
    await expect(hmrcAccessToken(ctx)).resolves.toBe('access-1');

    await agent.delete('/api/hmrc/connection').expect(204);
    expect((await agent.get('/api/hmrc')).body.connection).toBeNull();
    await expect(hmrcAccessToken(ctx)).rejects.toThrow(/Connect to HMRC first/);
  });

  it('sends the PKCE verifier that matches the challenge', async () => {
    const { url } = (await agent.post('/api/hmrc/connect').expect(200)).body;
    const params = new URL(url).searchParams;
    await agent.get('/api/hmrc/callback').query({ code: 'c', state: params.get('state') }).expect(302);
    const verifier = tokenRequests[0].get('code_verifier')!;
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(params.get('code_challenge'));
  });

  it('reports a refused or cancelled sign-in on the settings page', async () => {
    await agent.post('/api/hmrc/connect').expect(200);
    const cancelled = await agent.get('/api/hmrc/callback').query({ error: 'access_denied' }).expect(302);
    expect(new URL(cancelled.headers.location, 'http://x').searchParams.get('error')).toMatch(/didn’t give the app authority/);

    tokenReply = () => ({ status: 400, body: { error: 'invalid_client' } });
    const refused = await connect();
    expect(new URL(refused.headers.location, 'http://x').searchParams.get('error')).toMatch(/HMRC_CLIENT_ID/);
    expect((await agent.get('/api/hmrc')).body.connection).toBeNull();
  });

  it('only lets editors connect', async () => {
    const viewer = await addPerson('Viewer', 'viewer-password', 'viewer');
    await viewer.post('/api/hmrc/connect').expect(403);
    await viewer.put('/api/hmrc/nino').send({ nino: 'AB123456C' }).expect(403);
    await viewer.delete('/api/hmrc/connection').expect(403);
    const res = await viewer.get('/api/hmrc/callback').query({ code: 'c', state: 's' }).expect(302);
    expect(new URL(res.headers.location, 'http://x').searchParams.get('error')).toMatch(/Only editors/);
    expect((await viewer.get('/api/hmrc').expect(200)).body.configured).toBe(true);
  });

  it('refreshes an expired access token once, however many calls want it', async () => {
    await connect();
    const later = new Date(Date.now() + 4 * 3600 * 1000);
    const tokens = await Promise.all([hmrcAccessToken(ctx, later), hmrcAccessToken(ctx, later), hmrcAccessToken(ctx, later)]);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(tokenRequests.map((r) => r.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    expect(tokenRequests[1].get('refresh_token')).toBe('refresh-1');
    await expect(hmrcAccessToken(ctx, later)).resolves.toBe('access-2');

    // When HMRC refuses the refresh token, the connection is forgotten.
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });
    await expect(hmrcAccessToken(ctx, new Date(later.getTime() + 5 * 3600 * 1000))).rejects.toThrow(/Connect to HMRC again/);
    expect((await agent.get('/api/hmrc')).body.connection).toBeNull();
  });

  it('keeps tokens out of backups and keeps the connection through a restore and a reset', async () => {
    await agent.put('/api/hmrc/nino').send({ nino: 'AB123456C' }).expect(200);
    await connect();
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).not.toMatch(/INSERT INTO "hmrc_connections"/);
    expect(dump).not.toMatch(/access-1|refresh-1/);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/hmrc')).body).toMatchObject({ nino: 'AB123456C', connection: { connectedBy: NAME } });
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/hmrc')).body).toMatchObject({ nino: 'AB123456C', connection: { connectedBy: NAME } });
    await expect(hmrcAccessToken(ctx)).resolves.toBe('access-1');
  });

  const BROWSER =
    'device-id=beec798b-b366-47fa-b1f8-92cede14a1ce&user-agent=Mozilla%2F5.0+Test&' +
    'screens=width%3D1920%26height%3D1080%26scaling-factor%3D2%26colour-depth%3D24&window-size=width%3D1256%26height%3D803&timezone=UTC%2B01%3A00';
  const NINO_PATH = '/individuals/business/details/AB123456C/list';
  const OBLIGATIONS_PATH = '/obligations/details/AB123456C/income-and-expenditure';

  async function connectWithBusiness() {
    await agent.put('/api/hmrc/nino').send({ nino: 'AB123456C' }).expect(200);
    await connect();
    apiReplies[NINO_PATH] = {
      status: 200,
      body: {
        listOfBusinesses: [
          { typeOfBusiness: 'self-employment', businessId: 'XAIS12345678910', tradingName: 'Bead Things' },
          { typeOfBusiness: 'foreign-property', businessId: 'XAIS23456789101' },
        ],
      },
    };
    await agent.post('/api/hmrc/businesses/find').set('X-Fraud-Prevention', BROWSER).expect(200);
  }

  it('builds the fraud prevention headers without guessing', () => {
    expect(publicIp('192.168.1.20')).toBeNull();
    expect(publicIp('::ffff:10.0.0.4')).toBeNull();
    expect(publicIp('100.70.1.1')).toBeNull();
    expect(publicIp('::1')).toBeNull();
    expect(publicIp('::ffff:81.2.69.160')).toBe('81.2.69.160');
    expect(publicIp('2a00:1450:4009::1')).toBe('2a00:1450:4009::1');

    const browser = parseBrowserData(BROWSER);
    expect(browser).toEqual({
      deviceId: 'beec798b-b366-47fa-b1f8-92cede14a1ce',
      userAgent: 'Mozilla/5.0 Test',
      screens: 'width=1920&height=1080&scaling-factor=2&colour-depth=24',
      windowSize: 'width=1256&height=803',
      timezone: 'UTC+01:00',
    });
    expect(parseBrowserData('device-id=nope&timezone=BST&screens=width%3Dx')).toEqual({
      deviceId: null,
      userAgent: null,
      screens: null,
      windowSize: null,
      timezone: null,
    });

    const receivedAt = new Date('2026-10-29T10:00:00.123Z');
    const common = { browser, clientPort: 51234, receivedAt, userName: 'Jo Bloggs' };
    const online = fraudPreventionHeaders({ ...common, clientIp: '81.2.69.160', vendorIp: '203.0.113.6' });
    expect(online).toMatchObject({
      'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER',
      'Gov-Client-Device-ID': 'beec798b-b366-47fa-b1f8-92cede14a1ce',
      'Gov-Client-Timezone': 'UTC+01:00',
      'Gov-Client-User-IDs': 'crafty-accounting=Jo%20Bloggs',
      'Gov-Client-Public-IP': '81.2.69.160',
      'Gov-Client-Public-IP-Timestamp': '2026-10-29T10:00:00.123Z',
      'Gov-Client-Public-Port': '51234',
      'Gov-Vendor-Public-IP': '203.0.113.6',
      'Gov-Vendor-Forwarded': 'by=203.0.113.6&for=81.2.69.160',
      'Gov-Vendor-Product-Name': 'Crafty%20Accounting',
      'Gov-Vendor-Version': expect.stringMatching(/^crafty-accounting=\d+\.\d+\.\d+$/),
    });
    expect(online).not.toHaveProperty('Gov-Client-Multi-Factor');

    // On a home network nothing public is known, so nothing is made up.
    const home = fraudPreventionHeaders({ ...common, clientIp: '192.168.1.20', vendorIp: null });
    for (const header of ['Gov-Client-Public-IP', 'Gov-Client-Public-IP-Timestamp', 'Gov-Client-Public-Port', 'Gov-Vendor-Public-IP', 'Gov-Vendor-Forwarded']) {
      expect(home).not.toHaveProperty(header);
    }
    expect(home['Gov-Client-Screens']).toBe('width=1920&height=1080&scaling-factor=2&colour-depth=24');
  });

  it('finds the self-employment business at HMRC, with fraud prevention headers', async () => {
    await agent.post('/api/hmrc/businesses/find').expect(400);
    await connectWithBusiness();
    expect((await agent.get('/api/hmrc')).body.business).toEqual({ businessId: 'XAIS12345678910', tradingName: 'Bead Things' });

    const call = apiRequests[0];
    expect(call.url.pathname).toBe(NINO_PATH);
    expect(call.headers).toMatchObject({
      Accept: 'application/vnd.hmrc.2.0+json',
      Authorization: 'Bearer access-1',
      'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER',
      'Gov-Client-Device-ID': 'beec798b-b366-47fa-b1f8-92cede14a1ce',
      'Gov-Client-Browser-JS-User-Agent': 'Mozilla/5.0 Test',
      'Gov-Client-User-IDs': 'crafty-accounting=Admin',
    });
    // Tests connect from 127.0.0.1, which isn't a public address.
    expect(call.headers).not.toHaveProperty('Gov-Client-Public-IP');

    // Several businesses: none is picked, and one can be chosen.
    apiReplies[NINO_PATH] = {
      status: 200,
      body: {
        listOfBusinesses: [
          { typeOfBusiness: 'self-employment', businessId: 'XAIS00000000001', tradingName: 'Beads' },
          { typeOfBusiness: 'self-employment', businessId: 'XAIS00000000002' },
        ],
      },
    };
    await agent.put('/api/hmrc/nino').send({ nino: 'AB123456C' }).expect(200);
    expect((await agent.get('/api/hmrc')).body.business).toMatchObject({ businessId: 'XAIS12345678910' });
    expect((await agent.post('/api/hmrc/businesses/find').expect(200)).body.businesses).toHaveLength(2);
    expect((await agent.get('/api/hmrc')).body.business).toMatchObject({ businessId: 'XAIS12345678910' });
    await agent.put('/api/hmrc/business').send({ businessId: 'nonsense', tradingName: null }).expect(400);
    await agent.put('/api/hmrc/business').send({ businessId: 'XAIS00000000002', tradingName: null }).expect(200);
    expect((await agent.get('/api/hmrc')).body.business).toEqual({ businessId: 'XAIS00000000002', tradingName: null });

    // A different taxpayer forgets the business.
    await agent.put('/api/hmrc/nino').send({ nino: 'CE123456D' }).expect(200);
    expect((await agent.get('/api/hmrc')).body.business).toBeNull();

    // No businesses at all.
    apiReplies['/individuals/business/details/CE123456D/list'] = { status: 404, body: { code: 'MATCHING_RESOURCE_NOT_FOUND', message: 'Matching resource not found' } };
    expect((await agent.post('/api/hmrc/businesses/find').expect(200)).body.businesses).toEqual([]);
  });

  it('reads HMRC’s obligations for the tax year', async () => {
    const taxYearId = await createYear(2026);
    await agent.get('/api/hmrc/obligations').query({ taxYearId }).expect(400);
    await connectWithBusiness();
    apiReplies[OBLIGATIONS_PATH] = {
      status: 200,
      body: {
        obligations: [
          {
            typeOfBusiness: 'self-employment',
            businessId: 'XAIS12345678910',
            obligationDetails: [
              { periodStartDate: '2026-04-06', periodEndDate: '2026-10-05', dueDate: '2026-11-07', status: 'open' },
              { periodStartDate: '2026-04-06', periodEndDate: '2026-07-05', dueDate: '2026-08-07', receivedDate: '2026-08-01', status: 'fulfilled' },
            ],
          },
          { typeOfBusiness: 'self-employment', businessId: 'XAIS99999999999', obligationDetails: [{ periodStartDate: '2026-04-06', periodEndDate: '2026-07-05', dueDate: '2026-08-07', status: 'open' }] },
        ],
      },
    };
    const res = await agent.get('/api/hmrc/obligations').query({ taxYearId }).set('X-Fraud-Prevention', BROWSER).expect(200);
    expect(res.body).toEqual([
      { periodStartDate: '2026-04-06', periodEndDate: '2026-07-05', dueDate: '2026-08-07', status: 'fulfilled', receivedDate: '2026-08-01' },
      { periodStartDate: '2026-04-06', periodEndDate: '2026-10-05', dueDate: '2026-11-07', status: 'open', receivedDate: null },
    ]);
    const call = apiRequests.at(-1)!;
    expect(call.headers.Accept).toBe('application/vnd.hmrc.3.0+json');
    expect(call.headers['Gov-Test-Scenario']).toBe('DYNAMIC');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      typeOfBusiness: 'self-employment',
      businessId: 'XAIS12345678910',
      fromDate: '2026-04-06',
      toDate: '2027-04-05',
    });

    // Read-only people can look too.
    const viewer = await addPerson('Viewer', 'viewer-password', 'viewer');
    await viewer.get('/api/hmrc/obligations').query({ taxYearId }).expect(200);

    apiReplies[OBLIGATIONS_PATH] = { status: 404, body: { code: 'NO_OBLIGATIONS_FOUND', message: 'No obligations found' } };
    expect((await agent.get('/api/hmrc/obligations').query({ taxYearId }).expect(200)).body).toEqual([]);

    apiReplies[OBLIGATIONS_PATH] = { status: 422, body: { code: 'RULE_INSOLVENT_TRADER', message: 'The remote endpoint has indicated that the Trader is insolvent' } };
    expect((await agent.get('/api/hmrc/obligations').query({ taxYearId }).expect(502)).body.error).toBe(
      'HMRC: The remote endpoint has indicated that the Trader is insolvent',
    );

    apiReplies[OBLIGATIONS_PATH] = { status: 403, body: { code: 'CLIENT_OR_AGENT_NOT_AUTHORISED', message: 'nope' } };
    expect((await agent.get('/api/hmrc/obligations').query({ taxYearId }).expect(403)).body.error).toMatch(/can’t act for this National Insurance number/);

    // A revoked sign-in is forgotten, without signing the person out of the app.
    apiReplies[OBLIGATIONS_PATH] = { status: 401, body: { code: 'INVALID_CREDENTIALS', message: 'Invalid Authentication information provided' } };
    expect((await agent.get('/api/hmrc/obligations').query({ taxYearId }).expect(400)).body.error).toMatch(/Connect to HMRC again/);
    expect((await agent.get('/api/hmrc').expect(200)).body.connection).toBeNull();
  });

  it('never sends test scenarios to the live service', async () => {
    const taxYearId = await createYear(2026);
    await connectWithBusiness();
    ctx.config.hmrc.environment = 'production';
    ctx.db.prepare("UPDATE hmrc_connections SET environment = 'production'").run();
    ctx.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      apiRequests.push({ url: new URL(String(url)), method: 'GET', headers: init?.headers as Record<string, string>, body: undefined });
      return new Response(JSON.stringify({ obligations: [] }), { status: 200 });
    }) as typeof fetch;
    await agent.get('/api/hmrc/obligations').query({ taxYearId }).expect(200);
    expect(apiRequests.at(-1)!.url.origin).toBe('https://api.service.hmrc.gov.uk');
    expect(apiRequests.at(-1)!.headers).not.toHaveProperty('Gov-Test-Scenario');
  });

  describe('sending quarterly updates', () => {
    const SEND_PATH = '/individuals/business/self-employment/AB123456C/XAIS12345678910/cumulative/2026-27';

    beforeEach(() => {
      // HMRC takes an update from 10 days before its quarter ends: Q2 of 2026/27 can go, Q3 can't yet.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    /** The year-to-date figures as the MTD page shows them, which the person confirms. */
    async function preview(taxYearId: number, quarter: number) {
      const { quarters, taxYear, mtdExpenses } = (await agent.get('/api/mtd/quarters').query({ taxYearId }).expect(200)).body;
      const q = quarters.find((x: { quarter: number }) => x.quarter === quarter);
      return mtdPayload(q.cumulative, taxYear.startDate, q.endDate, mtdExpenses);
    }

    it('sends the year-to-date figures and keeps HMRC’s receipt', async () => {
      const taxYearId = await createYear(2026, 'mtd');
      await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-06-14', amountPence: 38000 })).expect(201);
      await agent.post('/api/expenses').send(expense(taxYearId, { date: '2026-08-02' })).expect(201);
      await connectWithBusiness();
      apiReplies[SEND_PATH] = { status: 204, headers: { 'X-CorrelationId': 'c-123' } };

      const payload = await preview(taxYearId, 2);
      const res = await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).set('X-Fraud-Prevention', BROWSER).send({ payload }).expect(200);
      expect(res.body).toMatchObject({ submittedOn: '2026-10-29', sent: { by: NAME, environment: 'sandbox', correlationId: 'c-123', payload } });

      const call = apiRequests.at(-1)!;
      expect(call).toMatchObject({ method: 'PUT', url: expect.objectContaining({ pathname: SEND_PATH }) });
      expect(call.headers).toMatchObject({ Accept: 'application/vnd.hmrc.5.0+json', 'Content-Type': 'application/json', 'Gov-Client-Timezone': 'UTC+01:00' });
      expect(call.body).toMatchObject({
        periodDates: { periodStartDate: '2026-04-06', periodEndDate: '2026-10-05' },
        periodIncome: { turnover: 380, other: 0 },
        periodExpenses: { costOfGoods: 30, adminCosts: 5.5, otherExpenses: 10, depreciation: 0 },
        periodDisallowableExpenses: { otherExpensesDisallowable: 10 },
      });

      const q2 = (await agent.get('/api/mtd/quarters').query({ taxYearId })).body.quarters[1];
      expect(q2.submission.sent).toMatchObject({ correlationId: 'c-123', payload });

      // The record of what went to HMRC can't be changed or removed by hand.
      await agent.put(`/api/mtd/quarters/${taxYearId}/2/submission`).send({ submittedOn: '2026-10-01', reference: 'x' }).expect(409);
      await agent.delete(`/api/mtd/quarters/${taxYearId}/2/submission`).expect(409);
      // Nor can the year go back to Self Assessment.
      const back = await agent.put(`/api/tax-years/${taxYearId}/submission-method`).send({ submissionMethod: 'self_assessment' }).expect(409);
      expect(back.body.error).toMatch(/stays Making Tax Digital/);

      // It goes into backups with the books.
      expect((await agent.get('/api/backup.sql').expect(200)).text).toMatch(/c-123/);
    });

    it('sends expenses as one total when the year is set to', async () => {
      const taxYearId = await createYear(2026, 'mtd');
      await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-06-14', amountPence: 38000 })).expect(201);
      await agent.post('/api/expenses').send(expense(taxYearId, { date: '2026-08-02' })).expect(201);
      await connectWithBusiness();
      apiReplies[SEND_PATH] = { status: 204, headers: { 'X-CorrelationId': 'c-123' } };

      await agent.put(`/api/tax-years/${taxYearId}/mtd-expenses`).send({ mtdExpenses: 'sometimes' }).expect(400);
      const { body } = await agent.put(`/api/tax-years/${taxYearId}/mtd-expenses`).send({ mtdExpenses: 'consolidated' }).expect(200);
      expect(body.taxYears[0].mtdExpenses).toBe('consolidated');

      // Figures from before the change no longer match what would go.
      const itemised = mtdPayload(
        (await agent.get('/api/mtd/quarters').query({ taxYearId })).body.quarters[1].cumulative,
        '2026-04-06',
        '2026-10-05',
        'itemised',
      );
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).set('X-Fraud-Prevention', BROWSER).send({ payload: itemised }).expect(409);

      const payload = await preview(taxYearId, 2);
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).set('X-Fraud-Prevention', BROWSER).send({ payload }).expect(200);
      expect(apiRequests.at(-1)!.body).toEqual({
        periodDates: { periodStartDate: '2026-04-06', periodEndDate: '2026-10-05' },
        periodIncome: { turnover: 380, other: 0 },
        // Allowable only: the disallowable £10 isn't in it, and HMRC refuses disallowable amounts alongside it.
        periodExpenses: { consolidatedExpenses: 35.5 },
      });
    });

    it('goes by category for the whole year once turnover reaches the threshold', async () => {
      const taxYearId = await createYear(2026, 'mtd');
      const { body: below } = await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-06-14', amountPence: 8_999_999 })).expect(201);
      await agent.post('/api/expenses').send(expense(taxYearId, { date: '2026-05-02' })).expect(201);
      await connectWithBusiness();
      apiReplies[SEND_PATH] = { status: 204, headers: { 'X-CorrelationId': 'c-123' } };
      await agent.put(`/api/tax-years/${taxYearId}/mtd-expenses`).send({ mtdExpenses: 'consolidated' }).expect(200);

      // A penny below, one total goes.
      const belowPayload = await preview(taxYearId, 2);
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).set('X-Fraud-Prevention', BROWSER).send({ payload: belowPayload }).expect(200);
      expect(apiRequests.at(-1)!.body).toMatchObject({ periodExpenses: { consolidatedExpenses: 35.5 } });

      await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-08-14', amountPence: 1 })).expect(201);
      const { body: years } = await agent.get('/api/tax-years').expect(200);
      expect(years.taxYears[0]).toMatchObject({ mtdExpenses: 'consolidated', mtdExpensesSent: 'itemised' });

      // Refused if the person saw the one total, then goes by category from the start of the year.
      const oneTotal = (await agent.get(`/api/mtd/quarters`).query({ taxYearId })).body.quarters[1].cumulative;
      await agent
        .post(`/api/hmrc/quarters/${taxYearId}/2/send`)
        .set('X-Fraud-Prevention', BROWSER)
        .send({ payload: mtdPayload(oneTotal, '2026-04-06', '2026-10-05', 'consolidated') })
        .expect(409);
      const overPayload = await preview(taxYearId, 2);
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).set('X-Fraud-Prevention', BROWSER).send({ payload: overPayload }).expect(200);
      expect(apiRequests.at(-1)!.body).toMatchObject({
        periodExpenses: { costOfGoods: 30, adminCosts: 5.5, otherExpenses: 10 },
        periodDisallowableExpenses: { otherExpensesDisallowable: 10 },
      });
      expect(apiRequests.at(-1)!.body).not.toHaveProperty('periodExpenses.consolidatedExpenses');
      const csv = (await agent.get(`/api/mtd/quarters/${taxYearId}/1/export.csv`).query({ basis: 'period' }).expect(200)).text;
      expect(csv).toContain('costOfGoods');
      expect(csv).not.toContain('consolidatedExpenses');

      // A correction back below the threshold returns to the setting.
      await agent.delete(`/api/incomes/${below.id}`).expect(204);
      expect((await agent.get('/api/mtd/quarters').query({ taxYearId })).body.mtdExpenses).toBe('consolidated');
    });

    it('only sends figures the person has seen, at the right time, to the right place', async () => {
      const old = await createYear(2024);
      const taxYearId = await createYear(2026, 'mtd');
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload: {} }).expect(400); // not connected
      await connectWithBusiness();
      apiReplies[SEND_PATH] = { status: 204 };

      expect((await agent.post(`/api/hmrc/quarters/${old}/4/send`).send({ payload: {} }).expect(400)).body.error).toMatch(/2025\/26/);
      const selfAssessment = await createYear(2025);
      expect((await agent.post(`/api/hmrc/quarters/${selfAssessment}/4/send`).send({ payload: {} }).expect(409)).body.error).toMatch(
        /Self Assessment return/,
      );
      const tooEarly = await preview(taxYearId, 3);
      expect((await agent.post(`/api/hmrc/quarters/${taxYearId}/3/send`).send({ payload: tooEarly }).expect(400)).body.error).toMatch(
        /until 2026-12-26/,
      );

      const payload = await preview(taxYearId, 2);
      await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-09-01' })).expect(201);
      expect((await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload }).expect(409)).body.error).toMatch(/changed/);
      expect(apiRequests.filter((r) => r.method === 'PUT')).toHaveLength(0);

      const viewer = await addPerson('Viewer', 'viewer-password', 'viewer');
      const viewerPayload = await preview(taxYearId, 2);
      await viewer.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload: viewerPayload }).expect(403);

      // HMRC's refusal is passed on, and nothing is recorded.
      apiReplies[SEND_PATH] = {
        status: 400,
        body: { code: 'RULE_SUBMISSION_END_DATE_CANNOT_MOVE_BACKWARDS', message: 'Submission end date cannot be earlier than the existing submission' },
      };
      const refused = await preview(taxYearId, 2);
      expect((await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload: refused }).expect(502)).body.error).toMatch(
        /cannot be earlier/,
      );
      expect((await agent.get('/api/mtd/quarters').query({ taxYearId })).body.quarters[1].submission).toBeNull();
    });

    it('treats an update sent to the sandbox as a test once the app uses the live service', async () => {
      const taxYearId = await createYear(2026, 'mtd');
      await connectWithBusiness();
      apiReplies[SEND_PATH] = { status: 204, headers: { 'X-CorrelationId': 'sandbox-1' } };
      const payload = await preview(taxYearId, 2);
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload }).expect(200);

      ctx.config.hmrc.environment = 'production';
      const q2 = (await agent.get('/api/mtd/quarters').query({ taxYearId })).body.quarters[1];
      expect(q2.submission).toBeNull();
      expect(q2.otherServiceSend).toMatchObject({ environment: 'sandbox', by: NAME });

      // Not a live record, so it can be replaced by hand.
      const res = await agent.put(`/api/mtd/quarters/${taxYearId}/2/submission`).send({ submittedOn: '2026-11-01' }).expect(200);
      expect(res.body).toMatchObject({ submittedOn: '2026-11-01', reference: null, sent: null });
      const after = (await agent.get('/api/mtd/quarters').query({ taxYearId })).body.quarters[1];
      expect(after.otherServiceSend).toBeNull();

      ctx.config.hmrc.environment = 'sandbox';
      expect((await agent.get('/api/mtd/quarters').query({ taxYearId })).body.quarters[1].submission.sent).toBeNull();
    });

    it('sends again to replace what HMRC has', async () => {
      const taxYearId = await createYear(2026, 'mtd');
      await connectWithBusiness();
      await agent.put(`/api/mtd/quarters/${taxYearId}/2/submission`).send({ submittedOn: '2026-10-20', reference: 'by hand' }).expect(200);
      apiReplies[SEND_PATH] = { status: 204, headers: { 'X-CorrelationId': 'first' } };
      const first = await preview(taxYearId, 2);
      await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload: first }).expect(200);
      await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-09-01', amountPence: 1234 })).expect(201);
      apiReplies[SEND_PATH] = { status: 204, headers: { 'X-CorrelationId': 'second' } };
      const payload = await preview(taxYearId, 2);
      const res = await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload }).expect(200);
      expect(res.body).toMatchObject({ reference: 'by hand', sent: { correlationId: 'second', payload: { periodIncome: { turnover: 12.34 } } } });
    });
  });

  describe('HMRC’s tax calculation', () => {
    const BASE = '/individuals/calculations/AB123456C/self-assessment/2026-27';
    const CALC_ID = 'f2fb30e5-4ab6-4a29-b3c1-c7264259ff1c';
    const calculationBody = {
      metadata: { calculationId: CALC_ID, calculationTimestamp: '2026-10-29T10:00:00.000Z', calculationType: 'in-year', requestedBy: 'customer' },
      calculation: {
        incomeSummaryTotals: { totalSelfEmploymentProfit: 4152 },
        taxCalculation: {
          incomeTax: { totalIncomeReceivedFromAllSources: 4152, totalAllowancesAndDeductions: 12570, totalTaxableIncome: 0, totalIncomeTaxDue: 0 },
          nics: { class4Nics: { totalAmount: 0, nic4Bands: [{ name: 'ZRT', rate: 0, income: 4152, amount: 0 }, { name: 'BRT', rate: 6, income: 0, amount: 0 }] } },
          totalIncomeTaxAndNicsDue: 0,
        },
        endOfYearEstimate: { incomeTaxNicAmount: 1234.56 },
      },
      messages: { info: [{ id: 'C22203', text: 'Class 2 National Insurance has not been charged.' }] },
    };

    it('asks HMRC to calculate, then reads the result once it’s ready', async () => {
      const taxYearId = await createYear(2026);
      await agent.post(`/api/hmrc/calculations/${taxYearId}`).expect(400); // no NINO
      await connectWithBusiness();
      apiReplies[`${BASE}/trigger/in-year`] = { status: 202, body: { calculationId: CALC_ID } };
      const triggered = await agent.post(`/api/hmrc/calculations/${taxYearId}`).set('X-Fraud-Prevention', BROWSER).expect(202);
      expect(triggered.body).toEqual({ calculationId: CALC_ID });
      expect(apiRequests.at(-1)).toMatchObject({ method: 'POST', headers: { Accept: 'application/vnd.hmrc.8.0+json' } });

      // Not ready yet: HMRC answers 404.
      apiReplies[`${BASE}/${CALC_ID}`] = { status: 404, body: { code: 'MATCHING_RESOURCE_NOT_FOUND', message: 'Not found' } };
      expect((await agent.get(`/api/hmrc/calculations/${taxYearId}`).query({ calculationId: CALC_ID }).expect(200)).body).toEqual({
        state: 'pending',
        calculationId: CALC_ID,
      });

      apiReplies[`${BASE}/${CALC_ID}`] = { status: 200, body: calculationBody };
      const ready = (await agent.get(`/api/hmrc/calculations/${taxYearId}`).query({ calculationId: CALC_ID }).expect(200)).body;
      expect(ready).toEqual({
        state: 'ready',
        calculation: {
          calculationId: CALC_ID,
          calculatedAt: '2026-10-29T10:00:00.000Z',
          type: 'in-year',
          requestedBy: 'customer',
          figures: {
            selfEmploymentProfitPence: 415200,
            totalIncomePence: 415200,
            allowancesPence: 1257000,
            taxableIncomePence: 0,
            incomeTaxPence: 0,
            class2Pence: 0,
            class4Pence: 0,
            totalDuePence: 0,
          },
          // Bands with nothing in them are left out.
          bands: [{ kind: 'class4', name: 'ZRT', ratePercent: 0, incomePence: 415200, taxPence: 0 }],
          endOfYearTotalPence: 123456,
          messages: { errors: [], warnings: [], info: [{ id: 'C22203', text: 'Class 2 National Insurance has not been charged.' }] },
        },
      });
      // The sandbox is asked for a worked example rather than placeholder values.
      expect(apiRequests.at(-1)!.headers['Gov-Test-Scenario']).toBe('UK_SE_SAVINGS_EXAMPLE');
    });

    it('finds the latest calculation for the year', async () => {
      const taxYearId = await createYear(2026);
      await connectWithBusiness();
      apiReplies[BASE] = { status: 404, body: { code: 'MATCHING_RESOURCE_NOT_FOUND', message: 'Not found' } };
      expect((await agent.get(`/api/hmrc/calculations/${taxYearId}`).expect(200)).body).toEqual({ state: 'none' });

      apiReplies[BASE] = {
        status: 200,
        body: {
          calculations: [
            { calculationId: '00000000-0000-0000-0000-000000000001', calculationTimestamp: '2026-08-01T10:00:00.000Z' },
            { calculationId: CALC_ID, calculationTimestamp: '2026-10-29T10:00:00.000Z' },
          ],
        },
      };
      apiReplies[`${BASE}/${CALC_ID}`] = { status: 200, body: { ...calculationBody, calculation: undefined, messages: { errors: [{ id: 'C1', text: 'No updates' }] } } };
      const res = (await agent.get(`/api/hmrc/calculations/${taxYearId}`).expect(200)).body;
      expect(res.calculation).toMatchObject({ calculationId: CALC_ID, figures: null, messages: { errors: [{ id: 'C1', text: 'No updates' }] } });

      // Read-only people can look, but not ask HMRC to calculate.
      const viewer = await addPerson('Viewer', 'viewer-password', 'viewer');
      await viewer.get(`/api/hmrc/calculations/${taxYearId}`).expect(200);
      await viewer.post(`/api/hmrc/calculations/${taxYearId}`).expect(403);

      // HMRC refuses an API the application isn't subscribed to; say which one.
      apiReplies[BASE] = { status: 403, body: { code: 'RESOURCE_FORBIDDEN', message: 'The application is not subscribed to the API which it is attempting to invoke' } };
      expect((await agent.get(`/api/hmrc/calculations/${taxYearId}`).expect(502)).body.error).toBe(
        'The app isn’t subscribed to HMRC’s Individual Calculations (MTD) API, version 8.0. Subscribe your application to it on HMRC’s Developer Hub, then try again.',
      );

      await agent.get(`/api/hmrc/calculations/${taxYearId}`).query({ calculationId: 'nope' }).expect(400);
      const old = await createYear(2024);
      expect((await agent.get(`/api/hmrc/calculations/${old}`).expect(400)).body.error).toMatch(/2025\/26/);
    });
  });

  describe('final declaration', () => {
    const BASE = '/individuals/calculations/AB123456C/self-assessment/2025-26';
    const CALC_ID = '5a2c7c1e-9f43-4f6a-a7f5-0d1e2f3a4b5c';
    const finalCalculation = (total: number, errors: { id: string; text: string }[] = []) => ({
      metadata: { calculationId: CALC_ID, calculationTimestamp: '2026-10-29T10:00:00.000Z', calculationType: 'intent-to-finalise' },
      calculation: {
        incomeSummaryTotals: { totalSelfEmploymentProfit: 20000 },
        taxCalculation: {
          incomeTax: {
            totalIncomeReceivedFromAllSources: 20000,
            totalAllowancesAndDeductions: 12570,
            totalTaxableIncome: 7430,
            totalIncomeTaxDue: 1486,
            payPensionsProfit: { taxBands: [{ name: 'BRT', rate: 20, income: 7430, taxAmount: 1486 }] },
          },
          nics: { class4Nics: { totalAmount: 445.8, nic4Bands: [{ name: 'BRT', rate: 6, income: 7430, amount: 445.8 }] } },
          totalIncomeTaxAndNicsDue: total,
        },
      },
      messages: errors.length ? { errors } : undefined,
    });

    beforeEach(() => {
      // 2025/26 has ended; HMRC takes its final declaration until 31 January 2027.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    /** A 2025/26 MTD year with every quarterly update recorded as submitted. */
    async function yearWithUpdates(quarters = [1, 2, 3, 4]) {
      const taxYearId = await createYear(2025, 'mtd');
      const on = ['2025-08-01', '2025-11-01', '2026-02-01', '2026-05-01'];
      for (const q of quarters) await agent.put(`/api/mtd/quarters/${taxYearId}/${q}/submission`).send({ submittedOn: on[q - 1] }).expect(200);
      return taxYearId;
    }

    it('asks HMRC for the final calculation, then declares the one agreed to', async () => {
      const taxYearId = await yearWithUpdates();
      await connectWithBusiness();
      apiReplies[`${BASE}/trigger/intent-to-finalise`] = { status: 202, body: { calculationId: CALC_ID } };
      const triggered = await agent.post(`/api/hmrc/final-declaration/${taxYearId}/calculation`).set('X-Fraud-Prevention', BROWSER).expect(202);
      expect(triggered.body).toEqual({ calculationId: CALC_ID });
      expect(apiRequests.at(-1)).toMatchObject({ method: 'POST', headers: { Accept: 'application/vnd.hmrc.8.0+json' } });

      apiReplies[`${BASE}/${CALC_ID}`] = { status: 200, body: finalCalculation(1931.8) };
      const shown = (await agent.get(`/api/hmrc/calculations/${taxYearId}`).query({ calculationId: CALC_ID }).expect(200)).body;
      expect(shown.calculation).toMatchObject({ type: 'intent-to-finalise', figures: { totalDuePence: 193180 } });
      expect(shown.calculation.bands).toEqual([
        { kind: 'income', name: 'BRT', ratePercent: 20, incomePence: 743000, taxPence: 148600 },
        { kind: 'class4', name: 'BRT', ratePercent: 6, incomePence: 743000, taxPence: 44580 },
      ]);

      // HMRC's figures changed since they were shown: refuse.
      const declare = (totalDuePence: number) =>
        agent.post(`/api/hmrc/final-declaration/${taxYearId}`).set('X-Fraud-Prevention', BROWSER).send({ calculationId: CALC_ID, totalDuePence });
      expect((await declare(100).expect(409)).body.error).toMatch(/changed/);

      apiReplies[`${BASE}/${CALC_ID}/final-declaration`] = { status: 204, headers: { 'X-CorrelationId': 'fd-123' } };
      const res = await declare(193180).expect(200);
      expect(res.body).toEqual({
        calculationId: CALC_ID,
        totalDuePence: 193180,
        by: NAME,
        at: '2026-10-29T12:00:00.000Z',
        environment: 'sandbox',
        correlationId: 'fd-123',
      });
      expect(apiRequests.at(-1)).toMatchObject({ method: 'POST', url: expect.objectContaining({ pathname: `${BASE}/${CALC_ID}/final-declaration` }) });
      expect((await agent.get('/api/mtd/quarters').query({ taxYearId }).expect(200)).body.finalDeclaration).toEqual(res.body);

      // Once declared, there's no declaring again, and only the whole year's figures (Q4) can be sent, to amend it.
      expect((await declare(193180).expect(409)).body.error).toMatch(/already been made/);
      await agent.post(`/api/hmrc/final-declaration/${taxYearId}/calculation`).expect(409);
      expect((await agent.post(`/api/hmrc/quarters/${taxYearId}/2/send`).send({ payload: {} }).expect(409)).body.error).toMatch(/Q4/);

      // It belongs to the HMRC service it was made to.
      ctx.config.hmrc.environment = 'production';
      expect((await agent.get('/api/mtd/quarters').query({ taxYearId }).expect(200)).body.finalDeclaration).toBeNull();
    });

    it('waits for the year to end and every quarterly update', async () => {
      await connectWithBusiness();
      const unfinished = await yearWithUpdates([1, 2]);
      expect((await agent.post(`/api/hmrc/final-declaration/${unfinished}/calculation`).expect(409)).body.error).toBe(
        'Send the quarterly updates for Q3, Q4 first.',
      );
      const current = await createYear(2026, 'mtd');
      expect((await agent.post(`/api/hmrc/final-declaration/${current}/calculation`).expect(400)).body.error).toMatch(/from 6 Apr(il)? 2027/);
      const selfAssessment = await createYear(2027);
      await agent.post(`/api/hmrc/final-declaration/${selfAssessment}/calculation`).expect(409);
      expect(apiRequests.filter((r) => r.url.pathname.startsWith('/individuals/calculations'))).toEqual([]);
    });

    it('amends a declared year: corrected figures, then HMRC’s amended calculation', async () => {
      const taxYearId = await yearWithUpdates();
      await connectWithBusiness();
      const amend = (totalDuePence: number) =>
        agent.post(`/api/hmrc/final-declaration/${taxYearId}/amendment`).set('X-Fraud-Prevention', BROWSER).send({ calculationId: CALC_ID, totalDuePence });
      expect((await agent.post(`/api/hmrc/final-declaration/${taxYearId}/amendment/calculation`).expect(409)).body.error).toMatch(
        /Make the final declaration/,
      );
      ctx.db
        .prepare(
          `INSERT INTO mtd_final_declarations (tax_year_id, environment, calculation_id, total_due_pence, declared_by, declared_at)
           VALUES (?, 'sandbox', '00000000-0000-0000-0000-000000000001', 150000, ?, '2026-06-01T09:00:00.000Z')`,
        )
        .run(taxYearId, NAME);

      // The corrected figures go as the whole year's update.
      await agent.post('/api/incomes').send(income(taxYearId, { date: '2026-03-14', amountPence: 38000 })).expect(201);
      const { quarters, taxYear } = (await agent.get('/api/mtd/quarters').query({ taxYearId }).expect(200)).body;
      const payload = mtdPayload(quarters[3].cumulative, taxYear.startDate, quarters[3].endDate, 'itemised');
      const sendPath = '/individuals/business/self-employment/AB123456C/XAIS12345678910/cumulative/2025-26';
      apiReplies[sendPath] = { status: 204, headers: { 'X-CorrelationId': 'c-q4' } };
      await agent.post(`/api/hmrc/quarters/${taxYearId}/4/send`).set('X-Fraud-Prevention', BROWSER).send({ payload }).expect(200);
      expect(apiRequests.at(-1)).toMatchObject({ method: 'PUT', url: expect.objectContaining({ pathname: sendPath }) });

      apiReplies[`${BASE}/trigger/intent-to-amend`] = { status: 202, body: { calculationId: CALC_ID } };
      expect((await agent.post(`/api/hmrc/final-declaration/${taxYearId}/amendment/calculation`).expect(202)).body).toEqual({
        calculationId: CALC_ID,
      });
      apiReplies[`${BASE}/${CALC_ID}`] = { status: 200, body: finalCalculation(1931.8) };
      expect((await amend(100).expect(409)).body.error).toMatch(/changed/);
      apiReplies[`${BASE}/${CALC_ID}/confirm-amendment`] = { status: 204, headers: { 'X-CorrelationId': 'am-1' } };
      const res = await amend(193180).expect(200);
      expect(res.body).toEqual({
        calculationId: CALC_ID,
        totalDuePence: 193180,
        by: NAME,
        at: '2026-10-29T12:00:00.000Z',
        environment: 'sandbox',
        correlationId: 'am-1',
      });
      expect(apiRequests.at(-1)).toMatchObject({ method: 'POST', url: expect.objectContaining({ pathname: `${BASE}/${CALC_ID}/confirm-amendment` }) });
      const after = (await agent.get('/api/mtd/quarters').query({ taxYearId }).expect(200)).body;
      expect(after.amendments).toEqual([res.body]);
      expect(after.finalDeclaration.totalDuePence).toBe(150000);

      // HMRC takes amendments for 12 months after the 31 January deadline.
      vi.setSystemTime(new Date('2028-02-01T12:00:00Z'));
      await agent.post('/api/auth/login').send({ name: NAME, password: PASSWORD }).expect(200); // the session expired meanwhile
      expect((await agent.post(`/api/hmrc/final-declaration/${taxYearId}/amendment/calculation`).expect(409)).body.error).toMatch(
        /until 31 Jan(uary)? 2028/,
      );
      await agent.post(`/api/hmrc/quarters/${taxYearId}/4/send`).send({ payload }).expect(409);
    });

    it('won’t agree to a calculation with errors, and only editors can declare', async () => {
      const taxYearId = await yearWithUpdates();
      await connectWithBusiness();
      apiReplies[`${BASE}/${CALC_ID}`] = { status: 200, body: finalCalculation(0, [{ id: 'C55001', text: 'Quarterly updates are missing.' }]) };
      const declare = (as = agent) => as.post(`/api/hmrc/final-declaration/${taxYearId}`).send({ calculationId: CALC_ID, totalDuePence: 0 });
      expect((await declare().expect(409)).body.error).toMatch(/errors/);

      // Not ready yet: HMRC answers 404.
      apiReplies[`${BASE}/${CALC_ID}`] = { status: 404, body: { code: 'MATCHING_RESOURCE_NOT_FOUND', message: 'Not found' } };
      expect((await declare().expect(409)).body.error).toMatch(/hasn’t finished/);

      const viewer = await addPerson('Viewer', 'viewer-password', 'viewer');
      await declare(viewer).expect(403);
      await agent.post(`/api/hmrc/final-declaration/${taxYearId}`).send({ calculationId: 'nope', totalDuePence: 0 }).expect(400);
      expect(apiRequests.some((r) => r.url.pathname.endsWith('/final-declaration'))).toBe(false);
    });
  });

  it('checks the fraud prevention headers with HMRC’s sandbox test API', async () => {
    apiReplies['/test/fraud-prevention-headers/validate'] = {
      status: 200,
      body: {
        specVersion: '3.1',
        code: 'INVALID_HEADERS',
        message: 'At least 1 header is invalid',
        errors: [{ code: 'MISSING_HEADER', message: 'Header required', headers: ['gov-client-public-ip'] }],
      },
    };
    const res = await agent.get('/api/hmrc/fraud-headers/check').set('X-Fraud-Prevention', BROWSER).expect(200);
    expect(res.body).toEqual({
      code: 'INVALID_HEADERS',
      message: 'At least 1 header is invalid',
      errors: [{ code: 'MISSING_HEADER', message: 'Header required', headers: ['gov-client-public-ip'] }],
      warnings: [],
    });
    expect(apiRequests[0].headers).toMatchObject({ Authorization: 'Bearer app-token', 'Gov-Client-Timezone': 'UTC+01:00' });

    ctx.config.hmrc.environment = 'production';
    await agent.get('/api/hmrc/fraud-headers/check').expect(400);
  });

  it('upgrades a backup made before the HMRC connection', async () => {
    await connect();
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 6)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    old.prepare("INSERT INTO tax_years (label, start_date, end_date) VALUES ('2025-26', '2025-04-06', '2026-04-05')").run();
    old.prepare("INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on, reference) VALUES (1, 1, '2025-08-01', 'ABC')").run();
    const dump = dumpSql(old);
    old.close();
    expect(dump).toMatch(/schema_version: 6/);
    expect(dump).not.toMatch(/hmrc_connections/);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/tax-years')).body.taxYears).toEqual([
      expect.objectContaining({ submissionMethod: 'mtd', mtdExpenses: 'itemised', mtdUpdates: { recorded: 1, sent: 0 } }),
    ]);
    expect((await agent.get('/api/hmrc')).body.connection).toMatchObject({ connectedBy: NAME });
    const quarters = (await agent.get('/api/mtd/quarters').query({ taxYearId: 1 })).body;
    expect(quarters.quarters[0].submission).toEqual({ submittedOn: '2025-08-01', reference: 'ABC', sent: null, recordedPayload: null });
    expect(quarters.finalDeclaration).toBeNull();
    expect(quarters.amendments).toEqual([]);
  });
});

describe('comparing tax years', () => {
  async function twoYears() {
    const earlier = await createYear(2024);
    const later = await createYear(2025);
    await agent.post('/api/incomes').send(income(earlier, { date: '2024-06-14', amountPence: 10000 })).expect(201);
    await agent.post('/api/incomes').send(income(earlier, { date: '2025-03-01', amountPence: 90000 })).expect(201);
    await agent.post('/api/expenses').send(expense(earlier, { date: '2024-05-02' })).expect(201);
    await agent.post('/api/expenses').send(expense(earlier, { date: '2025-03-02', invoiceNumber: 'INV-101' })).expect(201);
    await agent.post('/api/incomes').send(income(later, { date: '2025-06-14', amountPence: 20000 })).expect(201);
    await agent.post('/api/expenses').send(expense(later, { date: '2025-07-20', invoiceNumber: 'INV-102' })).expect(201);
    return { earlier, later };
  }
  const compare = (taxYearId: number, compareToId: number, period: string) => agent.get('/api/reports/year-comparison').query({ taxYearId, compareToId, period });

  it('compares the same stretch of each year, up to the last date recorded in the later one', async () => {
    const { earlier, later } = await twoYears();
    const { period, years } = (await compare(later, earlier, 'same').expect(200)).body;
    expect(period).toBe('same');
    expect(years[0]).toMatchObject({ from: '2025-04-06', to: '2025-07-20', tax: null });
    expect(years[1]).toMatchObject({ from: '2024-04-06', to: '2024-07-20', tax: null });
    expect(years[0].totals).toEqual({ incomePence: 20000, allowableExpensesPence: 3550, disallowablePence: 1000, profitPence: 16450 });
    // The March sale and expense in the earlier year fall after the cut-off.
    expect(years[1].totals).toEqual({ incomePence: 10000, allowableExpensesPence: 3550, disallowablePence: 1000, profitPence: 6450 });
    expect(years[1].income.totalPence).toBe(10000);
    expect(years[1].monthly.map((m: { label: string }) => m.label)).toEqual(['Apr 24', 'May 24', 'Jun 24', 'Jul 24']);
    expect(years[1].monthly[2]).toMatchObject({ incomePence: 10000, expensesPence: 0, profitPence: 10000 });
    expect(years[1].monthly[0]).toMatchObject({ incomePence: 0, expensesPence: 3550, profitPence: -3550 });
  });

  it('uses the later year for the cut-off whichever way round they are chosen', async () => {
    const { earlier, later } = await twoYears();
    const { years } = (await compare(earlier, later, 'same').expect(200)).body;
    expect(years[0].to).toBe('2024-07-20');
    expect(years[1].to).toBe('2025-07-20');
  });

  it('matches the Year-end summary and tax estimate for full years', async () => {
    const { earlier, later } = await twoYears();
    const { years } = (await compare(later, earlier, 'full').expect(200)).body;
    expect(years[1]).toMatchObject({ to: '2025-04-05' });
    expect(years[1].monthly).toHaveLength(12);
    const yearEnd = (await agent.get('/api/reports/year-end').query({ taxYearId: earlier }).expect(200)).body.summary;
    expect(years[1].totals.profitPence).toBe(yearEnd.netProfitPence);
    expect(years[1].totals.incomePence).toBe(100000);
    const estimate = (await agent.get('/api/reports/tax-estimate').query({ taxYearId: earlier }).expect(200)).body;
    expect(years[1].tax).toEqual(estimate);
  });

  it('includes flat-rate claims in totals and categories', async () => {
    const { earlier, later } = await twoYears();
    await agent
      .post('/api/mileage')
      .send({ taxYearId: later, date: '2025-06-01', description: 'Fair', vehicle: 'car', distanceTenths: 300 })
      .expect(201);
    const { years } = (await compare(later, earlier, 'same').expect(200)).body;
    expect(years[0].totals.allowableExpensesPence).toBe(3550 + 1350);
    const travel = years[0].expenses.groups.find((g: { hmrcCode: string }) => g.hmrcCode === 'carVanTravelExpenses');
    expect(travel.flatRates).toMatchObject([{ kind: 'mileage', totalPence: 1350 }]);
  });

  it('refuses the same year twice and unknown years, and lets viewers read it', async () => {
    const { earlier, later } = await twoYears();
    await compare(later, later, 'same').expect(400);
    await compare(later, earlier, 'sideways').expect(400);
    await compare(later, 9999, 'same').expect(404);

    await agent.post('/api/users').send({ name: 'Vera', password: 'viewer-password', role: 'viewer' }).expect(201);
    const viewer = request.agent(createApp(ctx));
    await viewer.post('/api/auth/login').send({ name: 'Vera', password: 'viewer-password' }).expect(200);
    await viewer.get('/api/reports/year-comparison').query({ taxYearId: later, compareToId: earlier, period: 'full' }).expect(200);
  });
});

describe('business details', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('test logo')]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('test logo')]);
  const save = (body: Record<string, unknown>, logo?: Buffer) => {
    const req = agent.put('/api/business');
    return logo ? req.field('data', JSON.stringify(body)).attach('logo', logo, 'logo.png') : req.send(body);
  };
  const clearBusiness = () => ctx.db.prepare('DELETE FROM business_details').run();

  it('must be set up before anything else changes, though the books can still be read', async () => {
    clearBusiness();
    expect((await agent.get('/api/business').expect(200)).body).toEqual({ details: null, logo: null, isSample: false, updatedAt: null, updatedBy: null });
    expect((await agent.post('/api/tax-years').send({ startYear: 2025 }).expect(403)).body.error).toMatch(/business details first/);
    await agent.post('/api/categories').send({ name: 'Beads', mapsToCategoryId: cat('costOfGoods') }).expect(403);
    await agent.get('/api/tax-years').expect(200);
    // People can still be looked after.
    await addPerson('Helper');

    const { body } = await save({
      details: { ...BUSINESS, postcode: 'ox10  8ba', utr: '12345 67890', website: 'jomakes.co.uk', startDate: '2024-09-01' },
    }).expect(200);
    expect(body.details).toMatchObject({ ownerName: 'Jo Maker', postcode: 'OX10 8BA', utr: '1234567890', town: null, startDate: '2024-09-01' });
    expect(body).toMatchObject({ isSample: false, updatedBy: NAME, logo: null });
    await createYear();
  });

  it('asks for a sign-in before anything else, even with no business set up yet', async () => {
    clearBusiness();
    const anon = request(createApp(ctx));
    // Nothing about the install or the business is given out before signing in.
    expect((await anon.get('/api/auth/me').expect(200)).body).toEqual({ authenticated: false });
    await anon.get('/api/health').expect(200);
    for (const path of ['/api/business', '/api/business/logo', '/api/tax-years', '/api/tls', '/api/updates', '/api/notifications', '/api/events', '/api/backup.sql']) {
      await anon.get(path).expect(401);
    }
    await anon.put('/api/business').send({ details: BUSINESS }).expect(401);
    await anon.post('/api/sample-data').send({}).expect(401);
    await anon.post('/api/restore').attach('file', Buffer.from('-- nothing'), 'backup.sql').expect(401);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM business_details').get()).toEqual({ n: 0 });

    // A first install: signing in with the default password, then choosing one, comes before the business.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
    const first = createContext(loadConfig({ DATA_DIR: fresh, CLIENT_DIST: path.join(fresh, 'none') }));
    try {
      const browser = request.agent(createApp(first));
      await browser.get('/api/business').expect(401);
      const { body } = await browser.post('/api/auth/login').send({ name: 'Admin', password: 'admin' }).expect(200);
      expect(body.mustChangePassword).toBe(true);
      expect((await browser.get('/api/business').expect(403)).body.error).toMatch(/password/i);
    } finally {
      first.db.close();
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('checks what it is given', async () => {
    const problem = async (details: Record<string, unknown>) => (await save({ details: { ...BUSINESS, ...details } }).expect(400)).body.error;
    expect(await problem({ ownerName: ' ' })).toMatch(/full name/);
    expect(await problem({ description: '' })).toMatch(/what the business does/);
    expect(await problem({ postcode: '' })).toMatch(/postcode/);
    expect(await problem({ postcode: '12345' })).toMatch(/UK postcode/);
    expect(await problem({ utr: '123' })).toMatch(/10 digits/);
    expect(await problem({ email: 'jo@' })).toMatch(/email/);
    expect(await problem({ startDate: '2025-05-01', endDate: '2025-04-01' })).toMatch(/stop before it started/);
    expect(await problem({ startDate: '2025-02-30' })).toMatch(/valid date/);
  });

  it('refuses a change made over someone else’s, and changes from viewers', async () => {
    const { updatedAt } = (await agent.get('/api/business')).body;
    await save({ details: BUSINESS, expectedUpdatedAt: updatedAt }).expect(200);
    expect((await save({ details: BUSINESS, expectedUpdatedAt: updatedAt }).expect(409)).body.error).toMatch(/changed the business details/);
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    expect((await viewer.get('/api/business').expect(200)).body.details.ownerName).toBe('Jo Maker');
    await viewer.put('/api/business').send({ details: BUSINESS }).expect(403);
  });

  it('keeps a PNG or JPEG logo, replaces and removes it, and refuses anything else', async () => {
    const { body } = await save({ details: BUSINESS }, PNG).expect(200);
    expect(body.logo).toMatchObject({ type: 'image/png', bytes: PNG.length });
    const logo = await agent.get(body.logo.url).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['cache-control']).toMatch(/immutable/);
    expect(Buffer.from(logo.body)).toEqual(PNG);

    // Saving without a logo keeps it; a new one replaces it.
    expect((await save({ details: BUSINESS }).expect(200)).body.logo.type).toBe('image/png');
    const replaced = (await save({ details: BUSINESS }, JPEG).expect(200)).body;
    expect(replaced.logo.type).toBe('image/jpeg');
    expect(replaced.logo.url).not.toBe(body.logo.url);

    expect((await save({ details: BUSINESS }, Buffer.from('<svg></svg>')).expect(400)).body.error).toMatch(/PNG or JPEG/);
    await save({ details: BUSINESS }, Buffer.concat([PNG, Buffer.alloc(600 * 1024)])).expect(413);
    expect((await agent.get('/api/business')).body.logo.type).toBe('image/jpeg');

    expect((await save({ details: BUSINESS, removeLogo: true }).expect(200)).body.logo).toBeNull();
    await agent.get('/api/business/logo').expect(404);
  });

  it('goes in backups, and a reset keeps it', async () => {
    await save({ details: { ...BUSINESS, utr: '1234567890' } }, PNG).expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).toMatch(/INSERT INTO "business_details"/);

    await save({ details: { ...BUSINESS, ownerName: 'Someone Else' }, removeLogo: true }).expect(200);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    const restored = (await agent.get('/api/business')).body;
    expect(restored.details).toMatchObject({ ownerName: 'Jo Maker', utr: '1234567890' });
    expect(Buffer.from((await agent.get('/api/business/logo').expect(200)).body)).toEqual(PNG);

    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/business')).body.details.ownerName).toBe('Jo Maker');
    await agent.get('/api/business/logo').expect(200);
    await createYear();
  });

  it('is replaced by the sample business, which a reset clears unless it was edited', async () => {
    await save({ details: BUSINESS }, PNG).expect(200);
    await agent.post('/api/sample-data').expect(201);
    const sample = (await agent.get('/api/business')).body;
    expect(sample).toMatchObject({ isSample: true, details: { tradingName: 'Hedgerow Crafts' }, logo: { type: 'image/png' } });
    expect(Buffer.from((await agent.get('/api/business/logo').expect(200)).body)).not.toEqual(PNG);

    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/business')).body.details).toBeNull();

    // Loaded from the setup screen, then made their own: a reset keeps it.
    await agent.post('/api/sample-data').expect(201);
    const edited = (await save({ details: { ...sample.details, ownerName: 'Jo Maker' } }).expect(200)).body;
    expect(edited).toMatchObject({ isSample: false, logo: { type: 'image/png' } });
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/business')).body.details.ownerName).toBe('Jo Maker');
  });

  it('can be restored from a backup before being set up, though a backup without one leaves the app asking', async () => {
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    clearBusiness();
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/business')).body.details.ownerName).toBe('Jo Maker');

    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 24)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    const oldDump = dumpSql(old);
    old.close();
    await agent.post('/api/restore').attach('file', Buffer.from(oldDump), 'backup.sql').expect(200);
    expect((await agent.get('/api/business')).body.details).toBeNull();
    await agent.post('/api/tax-years').send({ startYear: 2025 }).expect(403);
  });
});

describe('sample data', () => {
  const uploads = () => path.join(dataDir, 'uploads');

  it('gives the current year disallowable items, up to today', () => {
    const descriptions = (today: string) => {
      generateSampleData(ctx.db, uploads(), today);
      const rows = ctx.db
        .prepare(
          `SELECT l.description FROM expense_line_items l
           JOIN expenses e ON e.id = l.expense_id JOIN tax_years t ON t.id = e.tax_year_id
           WHERE l.disallowable = 1 AND t.label = '2026-27' ORDER BY e.date`,
        )
        .all() as { description: string }[];
      clearData(ctx.db, uploads());
      return rows.map((r) => r.description);
    };
    expect(descriptions('2026-10-26')).toEqual(
      expect.arrayContaining(['Phone bill – personal use', 'Personal craft kit', 'Lunch with a stockist', 'Drill for home use']),
    );
    expect(descriptions('2026-06-01')).not.toContain('Lunch with a stockist');
  });

  it('generates consistent data that the API and backups accept', async () => {
    const result = generateSampleData(ctx.db, uploads(), '2026-10-26');
    expect(result.taxYears).toBe(5);
    expect(result.incomes).toBeGreaterThan(40);
    expect(result.expenses).toBeGreaterThan(40);
    expect(result.documents).toBeGreaterThan(5);
    expect(result.submissions).toBe(1);
    expect(result.trips).toBeGreaterThan(20);

    const mismatched = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM expenses e
         WHERE e.total_pence != (SELECT SUM(amount_pence) FROM expense_line_items WHERE expense_id = e.id)`,
      )
      .get() as { n: number };
    expect(mismatched.n).toBe(0);
    const outOfYear = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT date, tax_year_id FROM incomes UNION ALL SELECT date, tax_year_id FROM expenses
         ) t JOIN tax_years y ON y.id = t.tax_year_id
         WHERE t.date < y.start_date OR t.date > y.end_date OR t.date > '2026-10-26'`,
      )
      .get() as { n: number };
    expect(outOfYear.n).toBe(0);
    const docs = ctx.db
      .prepare(
        'SELECT filename AS name FROM documents',
      )
      .all() as { name: string }[];
    expect(docs).toHaveLength(result.documents);
    const withSeveral = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM documents GROUP BY income_id, expense_id HAVING COUNT(*) > 1)')
      .get() as { n: number };
    expect(withSeveral.n).toBeGreaterThan(3);
    for (const { name } of docs) expect(fs.existsSync(path.join(uploads(), name))).toBe(true);

    const customs = (await agent.get('/api/categories')).body.filter((c: { isCustom: boolean }) => c.isCustom);
    expect(customs.map((c: { name: string }) => c.name).sort()).toEqual(['Beads', 'Etsy sales', 'Printer filament', 'Stall fees']);
    for (const c of customs) expect(c.usageCount).toBeGreaterThan(0);

    const { body } = await agent.get('/api/tax-years').expect(200);
    expect(body.taxYears.map((y: { label: string }) => y.label)).toEqual(['2026-27', '2025-26', '2024-25', '2023-24', '2022-23']);
    // This year is MTD with Q1 recorded; past years were Self Assessment returns.
    expect(body.taxYears.map((y: { submissionMethod: string; mtdUpdates: object }) => [y.submissionMethod, y.mtdUpdates])).toEqual([
      ['mtd', { recorded: 1, sent: 0 }],
      ...Array(4).fill(['self_assessment', { recorded: 0, sent: 0 }]),
    ]);
    // The business grows, so comparing years has a trend to show, and every year has its own tax rates.
    const yearIds = [...body.taxYears].reverse().map((y: { id: number }) => y.id);
    const { years } = (await agent.get('/api/reports/year-comparison').query({ taxYearId: yearIds[3], compareToId: yearIds[0], period: 'full' }).expect(200)).body;
    expect(years[0].totals.incomePence).toBeGreaterThan(years[1].totals.incomePence);
    expect(years[1].tax.estimate.ratesAssumed).toBe(false);
    await agent.get('/api/dashboard').query({ taxYearId: body.activeTaxYearId }).expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
  });

  it('can be loaded from the app into an empty install, and is flagged until cleared', async () => {
    expect((await agent.get('/api/sample-data').expect(200)).body).toEqual({ loaded: false, canLoad: true });
    const { body } = await agent.post('/api/sample-data').expect(201);
    expect(body.taxYears).toBe(5);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM incomes WHERE created_by IS NOT 'Sample data' OR updated_by IS NOT 'Sample data'").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE created_by IS NOT 'Sample data' OR updated_by IS NOT 'Sample data'").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM mileage_trips WHERE created_by IS NOT 'Sample data'").get()).toEqual({ n: 0 });
    expect((await agent.get('/api/sample-data')).body).toEqual({ loaded: true, canLoad: false });
    await agent.post('/api/sample-data').expect(409);

    // Deleting every tax year clears the flag; a reset does too.
    for (const y of (await agent.get('/api/tax-years')).body.taxYears) await agent.delete(`/api/tax-years/${y.id}`).expect(200);
    expect((await agent.get('/api/sample-data')).body).toEqual({ loaded: false, canLoad: true });
    await agent.post('/api/sample-data').expect(201);
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    // The sample business went with the sample data, so the app asks for real details first.
    expect((await agent.get('/api/business')).body.details).toBeNull();
    await agent.post('/api/tax-years').send({ startYear: 2025 }).expect(403);
    setUpBusiness(ctx.db);
    await createYear();
    expect((await agent.get('/api/sample-data')).body).toEqual({ loaded: false, canLoad: false });
  });

  it('replaces custom categories left from earlier with the sample ones', async () => {
    await agent.post('/api/categories').send({ name: 'Beads', mapsToCategoryId: cat('adminCosts') }).expect(201);
    await agent.post('/api/categories').send({ name: 'Glitter', mapsToCategoryId: cat('costOfGoods') }).expect(201);
    await agent.post('/api/sample-data').expect(201);
    const custom = (ctx.db.prepare('SELECT name, hmrc_code FROM categories WHERE is_custom = 1 ORDER BY name').all() as { name: string; hmrc_code: string }[]);
    expect(custom).toEqual([
      { name: 'Beads', hmrc_code: 'costOfGoods' },
      { name: 'Etsy sales', hmrc_code: 'turnover' },
      { name: 'Printer filament', hmrc_code: 'costOfGoods' },
      { name: 'Stall fees', hmrc_code: 'premisesRunningCosts' },
    ]);
  });

  it('refuses to overwrite existing data, and clears it on request', () => {
    generateSampleData(ctx.db, uploads(), '2026-10-26');
    expect(() => generateSampleData(ctx.db, uploads(), '2026-10-26')).toThrow(/already has data/);
    clearData(ctx.db, uploads());
    expect(fs.readdirSync(uploads())).toHaveLength(0);
    expect(generateSampleData(ctx.db, uploads(), '2026-10-26').taxYears).toBe(5);
  });
});

describe('document names', () => {
  it('flags unsafe names', () => {
    expect(documentNameProblem('receipt.pdf')).toBeNull();
    expect(documentNameProblem('../etc/passwd.pdf')).not.toBeNull();
    expect(documentNameProblem('a/b.pdf')).not.toBeNull();
    expect(documentNameProblem('.hidden.pdf')).not.toBeNull();
    expect(documentNameProblem('file.svg')).not.toBeNull();
    expect(documentNameProblem('bad\u0000.pdf')).not.toBeNull();
  });
});

describe('updates', () => {
  const [major, minor, patch] = APP_VERSION.split('.').map(Number);
  const newer = `${major}.${minor}.${patch + 1}`;
  const githubRequests: string[] = [];

  function github({ tags = [`v${APP_VERSION}`, `v${newer}`, 'v0.9.0', 'nightly'], tagsStatus = 200 }: { tags?: string[]; tagsStatus?: number } = {}) {
    githubRequests.length = 0;
    ctx.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      githubRequests.push(u);
      if (u.includes('/tags')) return new Response(JSON.stringify(tags.map((name) => ({ name }))), { status: tagsStatus });
      if (u.includes('/compare/')) {
        const messages = ['Add the Updates page\n\nLonger description', `Version ${newer}`, 'Fix the sidebar notice'];
        return Response.json({ commits: messages.map((message) => ({ commit: { message } })) });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  }

  it('picks the newest release tag and summarises the changes', () => {
    expect(newestTag(['v1.9.2', 'v1.10.0', 'v1.9.10', 'main', '2.0.0', 'v2.0.0-beta'])).toBe('v1.10.0');
    expect(newestTag(['latest'])).toBeNull();
    expect(changeSummaries(['First\n\nbody', 'Version 1.2.3', "Merge branch 'x'", 'Second'])).toEqual(['Second', 'First']);
  });

  it('checks soon after starting, sooner just after an update, and refreshes open pages even when nothing is new', async () => {
    github({ tags: [`v${APP_VERSION}`] });
    const events: string[] = [];
    const publish = ctx.liveUpdates.publish.bind(ctx.liveUpdates);
    ctx.liveUpdates.publish = (event, from) => {
      events.push(event.area);
      publish(event, from);
    };
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-install-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      ctx.config.updates = { ...ctx.config.updates, autoCheck: true, install: 'native', installDir };
      // An ordinary start: a minute.
      let stop = startUpdateChecker(ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(githubRequests).toEqual([]);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(githubRequests).toHaveLength(1);
      expect(ctx.updates.status()).toMatchObject({ available: null, checkError: null });
      expect(ctx.updates.status().checkedAt).not.toBeNull();
      // Nothing new, but the page still needs to show it was checked.
      expect(events).toEqual(['updates']);
      stop();

      // Started by an update from the app (its log is fresh): a few seconds.
      fs.mkdirSync(path.join(installDir, 'logs'));
      fs.writeFileSync(path.join(installDir, 'logs', 'update.log'), 'done');
      githubRequests.length = 0;
      stop = startUpdateChecker(ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(githubRequests).toHaveLength(1);
      stop();
    } finally {
      vi.useRealTimers();
      fs.rmSync(installDir, { recursive: true, force: true });
    }
  });

  it('reports nothing until checked, then a newer release with its changes', async () => {
    const before = (await agent.get('/api/updates').expect(200)).body;
    expect(before).toMatchObject({ currentVersion: APP_VERSION, install: 'manual', checkedAt: null, available: null, applying: null });

    github();
    const checked = (await agent.post('/api/updates/check').expect(200)).body;
    expect(checked.checkError).toBeNull();
    expect(checked.checkedAt).toEqual(expect.any(String));
    expect(checked.available).toEqual({
      version: newer,
      url: `https://github.com/koder-guy/crafty-accounting/releases/tag/v${newer}`,
      changes: ['Fix the sidebar notice', 'Add the Updates page'],
    });
    expect(githubRequests).toEqual([
      'https://api.github.com/repos/koder-guy/crafty-accounting/tags?per_page=100',
      `https://api.github.com/repos/koder-guy/crafty-accounting/compare/v${APP_VERSION}...v${newer}`,
    ]);
    expect((await agent.get('/api/updates').expect(200)).body.available.version).toBe(newer);
  });

  it('says when this is the newest version, and when GitHub could not be asked', async () => {
    github({ tags: [`v${APP_VERSION}`, 'v0.1.0'] });
    const latest = (await agent.post('/api/updates/check').expect(200)).body;
    expect(latest.available).toBeNull();
    expect(latest.checkError).toBeNull();

    github({ tagsStatus: 403 });
    const failed = (await agent.post('/api/updates/check').expect(200)).body;
    expect(failed.available).toBeNull();
    expect(failed.checkError).toMatch(/limiting/);
  });

  it("doesn't update a copy the installer didn't make, or let read-only people check or update", async () => {
    github();
    await agent.post('/api/updates/check').expect(200);
    const res = await agent.post('/api/updates/apply').send({ version: newer }).expect(409);
    expect(res.body.error).toMatch(/can't update itself/);

    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    expect((await viewer.get('/api/updates').expect(200)).body.available.version).toBe(newer);
    await viewer.post('/api/updates/check').expect(403);
    await viewer.post('/api/updates/apply').send({ version: newer }).expect(403);
  });

  it('backs up and runs the installer for the confirmed version, and reports a failed update', async () => {
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-install-'));
    ctx.config.updates = { ...ctx.config.updates, install: 'native', installDir };
    let finish!: (code: number) => void;
    const runs: { dir: string; tag: string; log: string }[] = [];
    ctx.updates.runUpdater = (dir, tag, log) => {
      runs.push({ dir, tag, log });
      fs.writeFileSync(log, '\x1b[1m==> Downloading the app\x1b[0m\nError: the build failed\n');
      return new Promise((resolve) => (finish = resolve));
    };
    try {
      github();
      await agent.post('/api/updates/apply').send({ version: newer }).expect(409); // not checked yet
      await agent.post('/api/updates/check').expect(200);
      await agent.post('/api/updates/apply').send({ version: '9.9.9' }).expect(409);

      const started = (await agent.post('/api/updates/apply').send({ version: newer }).expect(202)).body;
      expect(started.applying).toMatchObject({ version: newer });
      expect(runs).toEqual([{ dir: installDir, tag: `v${newer}`, log: path.join(installDir, 'logs', 'update.log') }]);
      expect(fs.readdirSync(ctx.paths.backupDir).filter((n) => n.endsWith('.zip'))).toHaveLength(1);
      await agent.post('/api/updates/apply').send({ version: newer }).expect(409); // already running

      finish(1);
      await new Promise((resolve) => setImmediate(resolve));
      const after = (await agent.get('/api/updates').expect(200)).body;
      expect(after.applying).toBeNull();
      expect(after.failed).toMatchObject({ version: newer, log: '==> Downloading the app\nError: the build failed' });
    } finally {
      fs.rmSync(installDir, { recursive: true, force: true });
    }
  });
});

describe('notifications', () => {
  const [major, minor, patch] = APP_VERSION.split('.').map(Number);
  const newer = `${major}.${minor}.${patch + 1}`;
  const newest = `${major}.${minor + 1}.0`;
  const GB = 1024 ** 3;

  const unread = async (who = agent) => (await who.get('/api/notifications').expect(200)).body.notifications as { id: number; kind: string; title: string; link: string | null }[];

  function github(tags: string[]) {
    ctx.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/tags') ? Response.json(tags.map((name) => ({ name }))) : Response.json({ commits: [] }),
    ) as typeof fetch;
  }

  it('tells editors about a new version until it is installed or replaced, once each', async () => {
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    const events: string[] = [];
    const publish = ctx.liveUpdates.publish.bind(ctx.liveUpdates);
    ctx.liveUpdates.publish = (event, from) => {
      events.push(event.area);
      publish(event, from);
    };

    github([`v${APP_VERSION}`, `v${newer}`]);
    await agent.post('/api/updates/check').expect(200);
    await agent.post('/api/updates/check').expect(200);
    expect(await unread()).toMatchObject([{ kind: 'update', title: `Version ${newer} is available`, link: '/settings/updates' }]);
    expect(events.filter((a) => a === 'notifications')).toHaveLength(1);
    expect(await unread(viewer)).toEqual([]);

    // A newer release replaces it; GitHub failing leaves it be.
    github([`v${newest}`, `v${newer}`]);
    await agent.post('/api/updates/check').expect(200);
    expect((await unread()).map((n) => n.title)).toEqual([`Version ${newest} is available`]);
    ctx.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    await agent.post('/api/updates/check').expect(200);
    expect(await unread()).toHaveLength(1);

    // Once that's the running version (here: GitHub has nothing newer), it goes.
    github([`v${APP_VERSION}`]);
    await agent.post('/api/updates/check').expect(200);
    expect(await unread()).toEqual([]);

    // Just after starting, before checking, only versions already installed are cleared.
    raiseNotification(ctx, { key: `update:${APP_VERSION}`, kind: 'update', title: 'old', message: '', audience: 'editors' });
    raiseNotification(ctx, { key: `update:${newer}`, kind: 'update', title: 'new', message: '', audience: 'editors' });
    syncUpdateNotification(ctx, null, false);
    expect((await unread()).map((n) => n.title)).toEqual(['new']);
  });

  it('is marked read by each person for themselves, viewers included', async () => {
    const jo = await addPerson('Jo');
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    raiseNotification(ctx, { key: 'a', kind: 'update', title: 'First', message: 'one', audience: 'all' });
    raiseNotification(ctx, { key: 'b', kind: 'update', title: 'Second', message: 'two', audience: 'all' });
    raiseNotification(ctx, { key: 'c', kind: 'low-space', title: 'Editors only', message: 'three', audience: 'editors' });

    const mine = await unread();
    expect(mine.map((n) => n.title).sort()).toEqual(['Editors only', 'First', 'Second']);
    const first = mine.find((n) => n.title === 'First')!.id;
    const after = (await agent.post(`/api/notifications/${first}/read`).expect(200)).body.notifications;
    expect(after.map((n: { title: string }) => n.title).sort()).toEqual(['Editors only', 'Second']);
    await agent.post(`/api/notifications/${first}/read`).expect(200); // again is fine
    await agent.post('/api/notifications/999/read').expect(200);
    await agent.post('/api/notifications/abc/read').expect(404);

    expect(await unread(jo)).toHaveLength(3);
    expect((await unread(viewer)).map((n) => n.title).sort()).toEqual(['First', 'Second']);
    expect((await viewer.post('/api/notifications/read-all').expect(200)).body.notifications).toEqual([]);
    expect(await unread(jo)).toHaveLength(3);

    // Raising the same condition again doesn't make it unread.
    raiseNotification(ctx, { key: 'a', kind: 'update', title: 'First', message: 'reworded', audience: 'all' });
    expect((await unread()).map((n) => n.title)).not.toContain('First');
  });

  it('warns when the data disk runs low, and clears once there is room again', async () => {
    let free = 500 * 1024 ** 2;
    const space = () => ({ freeBytes: free, totalBytes: 100 * GB });

    checkDiskSpace(ctx, space);
    checkDiskSpace(ctx, space);
    const [low] = await unread();
    expect(low).toMatchObject({ kind: 'low-space', title: 'Disk space is running low', link: '/settings/backup' });
    expect((await agent.get('/api/notifications')).body.notifications[0].message).toMatch(/^The disk holding your books and documents has 500 MB free of 100\.0 GB/);
    await agent.post(`/api/notifications/${low.id}/read`).expect(200);

    // Only just over the limit: still counts as low, so it isn't raised afresh.
    free = 1.1 * GB;
    checkDiskSpace(ctx, space);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 });

    free = 2 * GB;
    checkDiskSpace(ctx, space);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });

    // Running low again is news again.
    free = 100 * 1024 ** 2;
    checkDiskSpace(ctx, space);
    expect(await unread()).toHaveLength(1);

    // Unreadable disks are left as they were.
    checkDiskSpace(ctx, () => null);
    expect(await unread()).toHaveLength(1);
  });

  it('belongs to the install: left out of backups and kept through a restore and a reset', async () => {
    raiseNotification(ctx, { key: 'a', kind: 'update', title: 'Read', message: '', audience: 'all' });
    raiseNotification(ctx, { key: 'b', kind: 'update', title: 'Unread', message: '', audience: 'all' });
    const read = (await unread()).find((n) => n.title === 'Read')!.id;
    await agent.post(`/api/notifications/${read}/read`).expect(200);

    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).not.toMatch(/INSERT INTO "notification/);

    ctx.db.prepare('DELETE FROM notifications').run();
    raiseNotification(ctx, { key: 'a', kind: 'update', title: 'Read', message: '', audience: 'all' });
    raiseNotification(ctx, { key: 'b', kind: 'update', title: 'Unread', message: '', audience: 'all' });
    const readAgain = (await unread()).find((n) => n.title === 'Read')!.id;
    await agent.post(`/api/notifications/${readAgain}/read`).expect(200);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await unread()).map((n) => n.title)).toEqual(['Unread']);
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await unread()).map((n) => n.title)).toEqual(['Unread']);
    raiseNotification(ctx, { key: 'c', kind: 'update', title: 'After reset', message: '', audience: 'all' });
    expect(await unread()).toHaveLength(2);
  });
});

describe('reading invoices', () => {
  const reply = (overrides: Record<string, unknown> = {}) => ({
    date: '2025-05-02',
    payee: 'Bead World',
    invoiceNumber: 'INV-7',
    orderNumber: '',
    paymentMethod: 'card',
    lineItems: [
      { description: 'Glass beads', amount: '30.00', categoryId: String(cat('costOfGoods')) },
      { description: 'Postage', amount: '5.50', categoryId: String(cat('adminCosts')) },
    ],
    total: '35.50',
    ...overrides,
  });

  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ';
  let checked: { apiKey: string; model: string }[];
  let read: { apiKey: string; model: string; input: InvoiceInput }[];

  beforeEach(() => {
    checked = [];
    read = [];
    ctx.readers.claude = {
      async checkKey(apiKey, model) {
        checked.push({ apiKey, model });
        if (apiKey === 'sk-bad') throw new HttpError(422, "Anthropic didn't accept that key.");
      },
      async readInvoice(apiKey, model, input) {
        read.push({ apiKey, model, input });
        return toInvoiceReading(reply(), input.categories);
      },
    };
  });

  it('is off until a key is saved', async () => {
    const off = { configured: false, keyHint: null, keyAddedBy: null, keyAddedAt: null };
    expect((await agent.get('/api/ai').expect(200)).body).toEqual({
      provider: 'claude',
      configured: false,
      providers: { claude: { ...off, model: 'claude-haiku-5-5' }, gemini: { ...off, model: 'gemini-3.8-flash' } },
      filenamePattern: '{date}_{payee}_{invoice}_£{amount}',
    });
    await agent.post('/api/scans').attach('document', PDF, 'invoice.pdf').expect(404);
    expect(read).toEqual([]);
  });

  it('checks a key before saving it, and never sends it back', async () => {
    await agent.put('/api/ai/claude').send({ apiKey: 'sk-bad' }).expect(422);
    expect((await agent.get('/api/ai')).body.configured).toBe(false);
    await agent.put('/api/ai/claude').send({ apiKey: 'has a space' }).expect(400);
    await agent.put('/api/ai/claude').send({}).expect(400);
    await agent.put('/api/ai/claude').send({ model: 'gpt-9' }).expect(400);

    const res = await agent.put('/api/ai/claude').send({ apiKey: `  ${KEY} `, model: 'claude-sonnet-5-5' }).expect(200);
    expect(checked.at(-1)).toEqual({ apiKey: KEY, model: 'claude-sonnet-5-5' });
    expect(res.body).toMatchObject({ configured: true, providers: { claude: { configured: true, keyHint: 'sk-ant-api…WXYZ', keyAddedBy: NAME, model: 'claude-sonnet-5-5' } } });
    expect(JSON.stringify((await agent.get('/api/ai')).body)).not.toContain('abcdefghij');

    // Changing only the model keeps the key, without checking it again.
    const before = checked.length;
    expect((await agent.put('/api/ai/claude').send({ model: 'claude-haiku-5-5' }).expect(200)).body).toMatchObject({ configured: true, providers: { claude: { model: 'claude-haiku-5-5' } } });
    expect(checked).toHaveLength(before);

    expect((await agent.delete('/api/ai/claude/key').expect(200)).body).toMatchObject({ configured: false, providers: { claude: { configured: false, keyHint: null, model: 'claude-haiku-5-5' } } });
    await agent.post('/api/scans').attach('document', PDF, 'invoice.pdf').expect(404);
  });

  it('saves the document name pattern, checking it first', async () => {
    await agent.put('/api/ai').send({ filenamePattern: '{date}/{payee}' }).expect(400);
    await agent.put('/api/ai').send({ filenamePattern: '{total}' }).expect(400);
    const res = await agent.put('/api/ai').send({ filenamePattern: '{year}-{month} {payee} £{amount}' }).expect(200);
    expect(res.body).toMatchObject({ configured: false, filenamePattern: '{year}-{month} {payee} £{amount}' });
    expect(checked).toEqual([]);
    // The default is stored as NULL, so it follows any later change to the default.
    await agent.put('/api/ai').send({ filenamePattern: '{date}_{payee}_{invoice}_£{amount}' }).expect(200);
    expect(ctx.db.prepare('SELECT filename_pattern FROM ai_settings').get()).toEqual({ filename_pattern: null });

    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await viewer.put('/api/ai').send({ filenamePattern: '{payee}' }).expect(403);
  });

  it('keeps Opus for an install that saved a key before Haiku became the default', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    const run = (m: (typeof MIGRATIONS)[number]) => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    };
    MIGRATIONS.filter((m) => m.version <= 20).forEach(run);
    db.prepare("INSERT INTO claude_settings (id, api_key) VALUES (1, 'sk-old')").run();
    MIGRATIONS.filter((m) => m.version > 20).forEach(run);
    expect(getAiSettings(db as Db).providers.claude.model).toBe('claude-opus-5-5');
    db.close();
  });

  it('lets only editors change it', async () => {
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await viewer.put('/api/ai/claude').send({ apiKey: KEY }).expect(403);
    await agent.put('/api/ai/claude').send({ apiKey: KEY }).expect(200);
    await viewer.delete('/api/ai/claude/key').expect(403);
    expect((await viewer.get('/api/ai').expect(200)).body).toMatchObject({ configured: true, providers: { claude: { keyHint: 'sk-ant-api…WXYZ' } } });
    await viewer.post('/api/scans').attach('document', PDF, 'invoice.pdf').expect(403);
  });

  it('keeps the key out of backups and through a restore and a reset', async () => {
    await agent.put('/api/ai/claude').send({ apiKey: KEY, model: 'claude-sonnet-5-5' }).expect(200);
    await agent.put('/api/ai').send({ filenamePattern: '{payee} {date}' }).expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).not.toMatch(/INSERT INTO "ai_settings"/);
    expect(dump).not.toContain(KEY);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/ai')).body).toMatchObject({ configured: true, providers: { claude: { model: 'claude-sonnet-5-5' } } });
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/ai')).body).toMatchObject({ configured: true, providers: { claude: { model: 'claude-sonnet-5-5' } }, filenamePattern: '{payee} {date}' });
  });

  it('upgrades a backup made before the Claude integration, keeping the saved key', async () => {
    await agent.put('/api/ai/claude').send({ apiKey: KEY, model: 'claude-haiku-5-5' }).expect(200);
    await agent.put('/api/ai').send({ filenamePattern: '{payee} {date}' }).expect(200);
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 18)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    const dump = dumpSql(old);
    old.close();
    expect(dump).toMatch(/schema_version: 18/);
    expect(dump).not.toMatch(/claude_settings|ai_settings/);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/ai')).body).toMatchObject({ configured: true, providers: { claude: { keyHint: 'sk-ant-api…WXYZ', model: 'claude-haiku-5-5' } }, filenamePattern: '{payee} {date}' });
  });

  it('reads an invoice with the saved key and model, without saving anything', async () => {
    await agent.put('/api/ai/claude').send({ apiKey: KEY, model: 'claude-sonnet-5-5' }).expect(200);
    const { id } = (await agent.post('/api/scans').attach('document', PDF, 'invoice.pdf').expect(201)).body;
    await ctx.scans.idle();
    expect((await agent.get(`/api/scans/${id}`).expect(200)).body.reading).toMatchObject({
      date: '2025-05-02',
      payee: 'Bead World',
      paymentMethod: 'card',
      totalPence: 3550,
      lineItems: [
        { description: 'Glass beads', amountPence: 3000, categoryId: cat('costOfGoods') },
        { description: 'Postage', amountPence: 550, categoryId: cat('adminCosts') },
      ],
      warnings: [],
    });
    const { apiKey, model, input } = read[0]!;
    expect({ apiKey, model }).toEqual({ apiKey: KEY, model: 'claude-sonnet-5-5' });
    expect(input.mediaType).toBe('application/pdf');
    expect(input.data.equals(PDF)).toBe(true);
    // Depreciation isn't offered on the cash basis.
    expect(input.categories.some((c) => c.hmrcCode === 'depreciation')).toBe(false);
    expect(input.categories.every((c) => categories.find((k) => k.id === c.id)?.type === 'EXPENSE')).toBe(true);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 0 });
  });

  it('keeps files Claude cannot read without sending them, to fill in by hand', async () => {
    await agent.put('/api/ai/claude').send({ apiKey: KEY }).expect(200);
    const heic = (await agent.post('/api/scans').attach('document', Buffer.from('heic'), 'photo.heic').expect(201)).body;
    expect(heic).toMatchObject({ status: 'failed', error: expect.stringMatching(/PDF, JPG, PNG and WebP/) });
    const big = (await agent.post('/api/scans').attach('document', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.jpg').expect(201)).body;
    expect(big).toMatchObject({ status: 'failed', error: expect.stringMatching(/too large for Claude to read/) });
    await agent.post('/api/scans').expect(400);
    await ctx.scans.idle();
    expect(read).toEqual([]);
  });

  describe('with Gemini', () => {
    const GEMINI_KEY = 'AIzaSyA-abcdefghijklmnopqrstuvwxyz0123';
    let geminiRead: { apiKey: string; model: string; input: InvoiceInput }[];
    let geminiChecked: { apiKey: string; model: string }[];

    beforeEach(() => {
      geminiRead = [];
      geminiChecked = [];
      ctx.readers.gemini = {
        async checkKey(apiKey, model) {
          geminiChecked.push({ apiKey, model });
          if (apiKey === 'AIza-bad') throw new HttpError(422, "Google didn't accept that key.");
        },
        async readInvoice(apiKey, model, input) {
          geminiRead.push({ apiKey, model, input });
          return toInvoiceReading(reply(), input.categories, 'gemini');
        },
      };
    });

    it('keeps each provider\'s key, and reads with the one chosen', async () => {
      await agent.put('/api/ai/claude').send({ apiKey: KEY }).expect(200);
      await agent.put('/api/ai/gemini').send({ apiKey: 'AIza-bad' }).expect(422);
      await agent.put('/api/ai/gemini').send({ model: 'claude-haiku-5-5' }).expect(400);
      await agent.put('/api/ai/openai').send({ apiKey: KEY }).expect(404);
      await agent.put('/api/ai').send({ provider: 'openai' }).expect(400);

      // Choosing Gemini before it has a key: documents wait.
      expect((await agent.put('/api/ai').send({ provider: 'gemini' }).expect(200)).body).toMatchObject({ provider: 'gemini', configured: false });
      expect((await agent.get('/api/scans').expect(200)).body).toMatchObject({ aiConfigured: false, aiProvider: 'gemini' });
      await agent.post('/api/scans').attach('document', PDF, 'invoice.pdf').expect(404);

      const res = await agent.put('/api/ai/gemini').send({ apiKey: GEMINI_KEY, model: 'gemini-3.5-flash-lite' }).expect(200);
      expect(geminiChecked.at(-1)).toEqual({ apiKey: GEMINI_KEY, model: 'gemini-3.5-flash-lite' });
      expect(res.body).toMatchObject({
        provider: 'gemini',
        configured: true,
        providers: { claude: { configured: true, keyHint: 'sk-ant-api…WXYZ' }, gemini: { configured: true, keyHint: 'AIzaSyA-ab…0123', keyAddedBy: NAME, model: 'gemini-3.5-flash-lite' } },
      });
      expect(JSON.stringify(res.body)).not.toContain('abcdefghij');

      const { id } = (await agent.post('/api/scans').attach('document', PDF, 'invoice.pdf').expect(201)).body;
      await ctx.scans.idle();
      expect((await agent.get(`/api/scans/${id}`).expect(200)).body).toMatchObject({ status: 'ready', reading: { payee: 'Bead World', totalPence: 3550 } });
      expect(geminiRead.map(({ apiKey, model }) => ({ apiKey, model }))).toEqual([{ apiKey: GEMINI_KEY, model: 'gemini-3.5-flash-lite' }]);
      expect(read).toEqual([]);

      // Back to Claude, whose key was kept.
      expect((await agent.put('/api/ai').send({ provider: 'claude' }).expect(200)).body).toMatchObject({ provider: 'claude', configured: true });
      await agent.delete('/api/ai/gemini/key').expect(200);
      expect((await agent.get('/api/ai')).body).toMatchObject({ configured: true, providers: { gemini: { configured: false } } });
      const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
      await viewer.put('/api/ai').send({ provider: 'gemini' }).expect(403);
    });

    it('reads iPhone photos (HEIC), which Claude can\'t', async () => {
      await agent.put('/api/ai/gemini').send({ apiKey: GEMINI_KEY }).expect(200);
      await agent.put('/api/ai').send({ provider: 'gemini' }).expect(200);
      const heic = (await agent.post('/api/scans').attach('document', Buffer.from('heic'), 'photo.heic').expect(201)).body;
      expect(heic.status).not.toBe('failed');
      await ctx.scans.idle();
      expect(geminiRead[0]!.input.mediaType).toBe('image/heic');
      const big = (await agent.post('/api/scans').attach('document', Buffer.alloc(14 * 1024 * 1024 + 1), 'big.pdf').expect(201)).body;
      expect(big).toMatchObject({ status: 'failed', error: expect.stringMatching(/too large for Gemini to read/) });

      // A HEIC that failed under Claude can be read again once Gemini is chosen.
      await agent.put('/api/ai/claude').send({ apiKey: KEY }).expect(200);
      await agent.put('/api/ai').send({ provider: 'claude' }).expect(200);
      const failed = (await agent.post('/api/scans').attach('document', Buffer.from('heic'), 'other.heic').expect(201)).body;
      expect(failed.status).toBe('failed');
      await agent.post(`/api/scans/${failed.id}/retry`).expect(422);
      await agent.put('/api/ai').send({ provider: 'gemini' }).expect(200);
      await agent.post(`/api/scans/${failed.id}/retry`).expect(200);
      await ctx.scans.idle();
      expect((await agent.get(`/api/scans/${failed.id}`).expect(200)).body.status).toBe('ready');
    });

    it('sends the document, prompt and schema to the Gemini API, and reads its JSON reply', async () => {
      const expenseCats = categories.filter((c) => c.type === 'EXPENSE').map(({ id, name, hmrcCode, isCustom }) => ({ id, name, hmrcCode, isCustom }));
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return answer({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reply()) }] }, finishReason: 'STOP' }] });
      });
      try {
        const reading = await geminiReader.readInvoice(GEMINI_KEY, 'gemini-3.8-flash', { data: PDF, mediaType: 'application/pdf', categories: expenseCats });
        expect(reading).toMatchObject({ payee: 'Bead World', totalPence: 3550, warnings: [] });
        const { url, body } = calls[0]!;
        expect(url).toContain('models/gemini-3.8-flash:generateContent');
        const json = JSON.stringify(body);
        expect(json).toContain(PDF.toString('base64'));
        expect(json).toContain('application/pdf');
        expect(json).toContain('ledger');
        expect(body).toMatchObject({ generationConfig: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } } });

        vi.stubGlobal('fetch', async () => answer({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }));
        await expect(geminiReader.readInvoice(GEMINI_KEY, 'gemini-3.8-flash', { data: PDF, mediaType: 'application/pdf', categories: expenseCats })).rejects.toMatchObject({ status: 422 });
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }), { status: 400 }));
        await expect(geminiReader.checkKey('AIza-bad', 'gemini-3.8-flash')).rejects.toMatchObject({ status: 422 });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('tells the AI which standard category each of the owner\'s own comes under', async () => {
    await agent.post('/api/categories').send({ name: 'Beads and findings', mapsToCategoryId: cat('costOfGoods') }).expect(201);
    const all = (await agent.get('/api/categories').expect(200)).body as Category[];
    const text = categoryListText(all.filter((c) => c.type === 'EXPENSE').map(({ id, name, hmrcCode, isCustom }) => ({ id, name, hmrcCode, isCustom })));
    const own = all.find((c) => c.name === 'Beads and findings')!;
    const standard = all.find((c) => c.hmrcCode === 'costOfGoods' && !c.isCustom)!;
    expect(text).toContain(`${own.id}: Beads and findings (owner's own, under ${standard.name})`);
    expect(text).toContain(`${standard.id}: ${standard.name}\n`);
  });

  it('upgrades the Claude settings to AI document scanning, keeping the key, model and pattern', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    const run = (m: (typeof MIGRATIONS)[number]) => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    };
    MIGRATIONS.filter((m) => m.version <= 26).forEach(run);
    db.prepare("INSERT INTO claude_settings (id, api_key, key_added_by, key_added_at, model, filename_pattern) VALUES (1, 'sk-old', 'Jo', '2026-10-01T09:00:00.000Z', 'claude-sonnet-5-5', '{payee} {date}')").run();
    MIGRATIONS.filter((m) => m.version > 26).forEach(run);
    const s = getAiSettings(db as Db);
    expect(s.provider).toBe('claude');
    expect(s.providers.claude).toEqual({ apiKey: 'sk-old', model: 'claude-sonnet-5-5', keyAddedBy: 'Jo', keyAddedAt: '2026-10-01T09:00:00.000Z' });
    expect(s.providers.gemini).toEqual({ apiKey: null, model: 'gemini-3.8-flash', keyAddedBy: null, keyAddedAt: null });
    expect(s.filenamePattern).toBe('{payee} {date}');
    db.close();
  });

  it('puts every Temu order under Whaleco UK Limited (Temu), paid by card', () => {
    const expenseCats = categories.filter((c) => c.type === 'EXPENSE');
    expect(toInvoiceReading(reply({ payee: 'Whaleco UK Limited', temuOrder: true, paymentMethod: null }), expenseCats)).toMatchObject({
      payee: 'Whaleco UK Limited (Temu)',
      paymentMethod: 'card',
      warnings: [],
    });
    expect(toInvoiceReading(reply({ payee: 'Temu', temuOrder: true }), expenseCats).payee).toBe('Whaleco UK Limited (Temu)');
    expect(toInvoiceReading(reply({ payee: 'Bead World', temuOrder: false }), expenseCats).payee).toBe('Bead World');
  });

  it('puts every Amazon order under Amazon, paid by card, whichever seller the invoice names', () => {
    const expenseCats = categories.filter((c) => c.type === 'EXPENSE');
    const amazon = toInvoiceReading(reply({ payee: 'SUNNYCLUE Crafts Ltd', amazonOrder: true, paymentMethod: null }), expenseCats);
    expect(amazon).toMatchObject({ payee: 'Amazon', paymentMethod: 'card', warnings: [] });
    const other = toInvoiceReading(reply({ payee: 'Bead World', amazonOrder: false, paymentMethod: null }), expenseCats);
    expect(other.payee).toBe('Bead World');
    expect(other.paymentMethod).toBeNull();
    expect(other.warnings).toEqual([expect.stringMatching(/how it was paid/)]);
  });

  it('keeps only what fits the form and says what to check', () => {
    const expenseCats = categories.filter((c) => c.type === 'EXPENSE');
    const reading = toInvoiceReading(
      reply({
        date: '02/05/2025',
        paymentMethod: null,
        lineItems: [
          { description: 'Glass beads', amount: '£1,030.00', categoryId: '99999' },
          { description: 'Discount', amount: '-5.00', categoryId: null },
        ],
        total: '1025.00',
      }),
      expenseCats,
    );
    expect(reading.date).toBeNull();
    expect(reading.lineItems).toEqual([{ description: 'Glass beads', amountPence: 103000, categoryId: null }]);
    expect(reading.warnings).toHaveLength(5);
    expect(() => toInvoiceReading({ payee: 'x' }, expenseCats)).toThrow(/couldn't be understood/);
  });
});

describe('scanning documents in bulk', () => {
  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ';
  let read: string[];
  let failNext: HttpError | null;
  const files = () => fs.readdirSync(ctx.paths.uploadsDir);

  beforeEach(async () => {
    read = [];
    failNext = null;
    ctx.readers.claude = {
      async checkKey() {},
      async readInvoice(_apiKey, _model, input) {
        read.push(input.data.toString());
        if (failNext) {
          const err = failNext;
          failNext = null;
          throw err;
        }
        return toInvoiceReading(
          {
            date: '2025-05-02',
            payee: 'Bead World',
            invoiceNumber: 'INV-7',
            orderNumber: '',
            paymentMethod: 'card',
            lineItems: [{ description: 'Glass beads', amount: '30.00', categoryId: String(cat('costOfGoods')) }],
            total: '30.00',
          },
          input.categories,
        );
      },
    };
    await agent.put('/api/ai/claude').send({ apiKey: KEY }).expect(200);
  });

  const scan = (body: string, name = 'invoice.pdf', who = agent) => who.post('/api/scans').attach('document', Buffer.from(body), name);

  it('reads each document in the background and lists what was read', async () => {
    const first = (await scan('%PDF first').expect(201)).body;
    await scan('%PDF second', 'second.pdf').expect(201);
    expect(first).toMatchObject({ originalName: 'invoice.pdf', uploadedBy: NAME });
    expect(['waiting', 'reading']).toContain(first.status);
    await ctx.scans.idle();

    const list = (await agent.get('/api/scans').expect(200)).body;
    expect(list).toMatchObject({ aiConfigured: true, maxUploadBytes: 20 * 1024 * 1024 });
    expect(list.scans.map((s: { originalName: string; status: string }) => [s.originalName, s.status])).toEqual([
      ['invoice.pdf', 'ready'],
      ['second.pdf', 'ready'],
    ]);
    expect(list.scans[0].reading).toMatchObject({ payee: 'Bead World', totalPence: 3000 });
    expect(read.sort()).toEqual(['%PDF first', '%PDF second']);
    // Stored with the documents, so backups include them, under names no one would choose.
    expect(files()).toHaveLength(2);
    expect(files().every((f) => /^scan-[0-9a-f]{16}\.pdf$/.test(f))).toBe(true);
    const file = await agent.get(`/api/scans/${first.id}/file`).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.body.toString()).toBe('%PDF first');
    // Not served as a transaction's document.
    await agent.get(`/api/documents/${files()[0]}`).expect(404);
  });

  it('keeps a document Claude cannot read, to fill in by hand, and reads one that failed again', async () => {
    const heic = (await scan('heic', 'photo.heic').expect(201)).body;
    expect(heic).toMatchObject({ status: 'failed', error: expect.stringMatching(/PDF, JPG, PNG and WebP/) });
    await agent.post(`/api/scans/${heic.id}/retry`).expect(422);

    failNext = new HttpError(429, 'Anthropic is busy. Try again in a minute.');
    const busy = (await scan('%PDF busy').expect(201)).body;
    await ctx.scans.idle();
    expect((await agent.get(`/api/scans/${busy.id}`).expect(200)).body).toMatchObject({ status: 'failed', error: 'Anthropic is busy. Try again in a minute.' });
    expect((await agent.post(`/api/scans/${busy.id}/retry`).expect(200)).body.status).toMatch(/waiting|reading/);
    await ctx.scans.idle();
    expect((await agent.get(`/api/scans/${busy.id}`)).body).toMatchObject({ status: 'ready', error: null });
    await agent.post(`/api/scans/${busy.id}/retry`).expect(409);
    expect(read).toEqual(['%PDF busy', '%PDF busy']);
  });

  it('removes the scan when its expense is saved, once only', async () => {
    const year = await createYear();
    const { id } = (await scan('%PDF bead').expect(201)).body;
    await ctx.scans.idle();
    const save = () =>
      agent
        .post('/api/expenses')
        .field('data', JSON.stringify(expense(year, { scanId: id })))
        .attach('documents', Buffer.from('%PDF bead'), '2025-05-02_Bead World.pdf');
    const saved = (await save().expect(201)).body;
    expect(saved).toMatchObject({ createdBy: NAME, updatedBy: NAME });
    expect((await agent.get(`/api/expenses/${saved.id}`)).body).toMatchObject({ createdBy: NAME });
    expect((await agent.get('/api/scans')).body.scans).toEqual([]);
    expect(files()).toEqual(['2025-05-02_Bead World.pdf']);

    // Saved again from another window: refused, and nothing is added.
    const again = await save().expect(409);
    expect(again.body.error).toMatch(/already been saved or discarded/);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 1 });
    expect(files()).toEqual(['2025-05-02_Bead World.pdf']);
  });

  it('says under the bell when a pile has been read, until none are left to check', async () => {
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    const scansRead = async (who = agent) =>
      ((await who.get('/api/notifications').expect(200)).body.notifications as { id: number; kind: string; message: string; link: string }[]).filter(
        (n) => n.kind === 'scans-read',
      );
    const first = (await scan('%PDF one').expect(201)).body;
    failNext = new HttpError(429, 'Anthropic is busy. Try again in a minute.');
    await scan('%PDF two', 'two.pdf').expect(201);
    await ctx.scans.idle();
    const [n] = await scansRead();
    expect(n).toMatchObject({ link: '/expenses/scans', message: "1 document is ready to check, and 1 document couldn't be read and needs filling in by hand." });
    expect(await scansRead(viewer)).toEqual([]);
    await agent.post(`/api/notifications/${n.id}/read`).expect(200);

    // Another pile: a new one, unread again, replacing the last.
    await scan('%PDF three', 'three.pdf').expect(201);
    await ctx.scans.idle();
    const [again] = await scansRead();
    expect(again.id).not.toBe(n.id);
    expect(again.message).toBe("2 documents are ready to check, and 1 document couldn't be read and needs filling in by hand.");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'scans-read'").get()).toEqual({ n: 1 });

    // Gone once every one has been saved or discarded.
    const year = await createYear();
    const ids = (await agent.get('/api/scans')).body.scans.map((s: { id: number }) => s.id) as number[];
    await agent.delete(`/api/scans/${ids[1]}`).expect(204);
    await agent.delete(`/api/scans/${ids[2]}`).expect(204);
    expect(await scansRead()).toHaveLength(1);
    await agent
      .post('/api/expenses')
      .field('data', JSON.stringify(expense(year, { scanId: first.id })))
      .expect(201);
    expect(await scansRead()).toEqual([]);
  });

  it('discards a scan and its file', async () => {
    const { id } = (await scan('%PDF junk').expect(201)).body;
    await ctx.scans.idle();
    await agent.delete(`/api/scans/${id}`).expect(204);
    await agent.delete(`/api/scans/${id}`).expect(404);
    expect(files()).toEqual([]);
  });

  it('waits for a key, and lets only editors add, retry or discard', async () => {
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await scan('%PDF viewer', 'v.pdf', viewer).expect(403);

    await agent.delete('/api/ai/claude/key').expect(200);
    await scan('%PDF later').expect(404);
    // Added just before the key was removed: it waits, and the list still shows it.
    ctx.db.prepare("INSERT INTO scans (filename, original_name, size_bytes) VALUES ('scan-0000000000000000.pdf', 'later.pdf', 10)").run();
    fs.writeFileSync(path.join(ctx.paths.uploadsDir, 'scan-0000000000000000.pdf'), '%PDF later');
    const list = (await viewer.get('/api/scans').expect(200)).body;
    expect(list).toMatchObject({ aiConfigured: false, scans: [{ status: 'waiting' }] });
    await viewer.delete(`/api/scans/${list.scans[0].id}`).expect(403);

    await agent.put('/api/ai/claude').send({ apiKey: KEY }).expect(200);
    await ctx.scans.idle();
    expect((await agent.get('/api/scans')).body.scans[0].status).toBe('ready');
    expect(read).toEqual(['%PDF later']);
  });

  it('refuses documents that would leave the disk nearly full', async () => {
    const year = await createYear();
    const MB = 1024 ** 2;
    ctx.diskSpace = () => ({ freeBytes: 150 * MB, totalBytes: 1000 * MB });
    expect((await agent.get('/api/scans')).body.space).toEqual({ freeBytes: 150 * MB, minimumFreeBytes: 200 * MB });
    expect((await scan('%PDF full').expect(507)).body.error).toMatch(/nearly full \(150 MB free\)/);
    await agent
      .post('/api/expenses')
      .field('data', JSON.stringify(expense(year)))
      .attach('documents', PDF, 'receipt.pdf')
      .expect(507);
    expect(files()).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM scans').get()).toEqual({ n: 0 });
    // Changes without documents still save.
    await agent.post('/api/expenses').field('data', JSON.stringify(expense(year))).expect(201);

    // Room for the next backup like the newest is kept too.
    ctx.diskSpace = () => ({ freeBytes: 300 * MB, totalBytes: 1000 * MB });
    fs.mkdirSync(ctx.paths.backupDir, { recursive: true });
    const backup = path.join(ctx.paths.backupDir, 'crafty-accounting-auto-2025-06-01-0200.zip');
    fs.writeFileSync(backup, '');
    fs.truncateSync(backup, 400 * MB);
    await scan('%PDF full').expect(507);
    fs.truncateSync(backup, 10 * MB);
    await scan('%PDF fits').expect(201);
    await ctx.scans.idle();
  });

  it('keeps scans in backups, carries on reading after a restore, and empties them on a reset', async () => {
    await scan('%PDF kept').expect(201);
    await ctx.scans.idle();
    // One mid-read when the backup was made is read again after the restore.
    ctx.db.prepare("UPDATE scans SET status = 'reading', reading = NULL").run();
    const zip = await agent
      .get('/api/backup.zip')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    await agent.delete(`/api/scans/${(await agent.get('/api/scans')).body.scans[0].id}`).expect(204);
    await agent.post('/api/restore').attach('file', zip.body as Buffer, 'backup.zip').expect(200);
    await ctx.scans.idle();
    const [restored] = (await agent.get('/api/scans')).body.scans;
    expect(restored).toMatchObject({ originalName: 'invoice.pdf', status: 'ready' });
    expect((await agent.get(`/api/scans/${restored.id}/file`).expect(200)).body.toString()).toBe('%PDF kept');

    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/scans')).body.scans).toEqual([]);
  });

  describe('duplicates', () => {
    const beads = () => [{ description: 'Glass beads', amountPence: 3000, categoryId: cat('costOfGoods') }];
    const listed = async () =>
      (await agent.get('/api/scans').expect(200)).body.scans as { id: number; originalName: string; duplicates: { reason: string; kind: string; id: number }[] }[];
    const addExpense = async (year: number, overrides: Record<string, unknown>) =>
      (await agent.post('/api/expenses').field('data', JSON.stringify(expense(year, { lineItems: beads(), ...overrides }))).expect(201)).body.id as number;

    it('notices the same file again, in the books or waiting to be checked', async () => {
      const year = await createYear();
      const { id: scanId } = (await scan('%PDF bead').expect(201)).body;
      await ctx.scans.idle();
      // Saved with a different invoice number, so only the file can match.
      const saved = await agent
        .post('/api/expenses')
        .field('data', JSON.stringify(expense(year, { scanId, invoiceNumber: 'OTHER' })))
        .attach('documents', Buffer.from('%PDF bead'), 'beads.pdf')
        .expect(201);

      const again = (await scan('%PDF bead', 'again.pdf').expect(201)).body;
      const copy = (await scan('%PDF bead', 'copy.pdf').expect(201)).body;
      await scan('%PDF different', 'different.pdf').expect(201);
      await ctx.scans.idle();
      const scans = await listed();
      expect(scans.find((s) => s.id === again.id)!.duplicates).toEqual([
        { reason: 'same-file', kind: 'expense', id: saved.body.id, date: '2025-05-02', payee: 'Bead World', totalPence: 4550, name: null },
        // Its reading also matches the other copy's; the same file is the reason given.
        expect.objectContaining({ reason: 'same-file', kind: 'scan', id: copy.id, name: 'copy.pdf' }),
        expect.objectContaining({ reason: 'same-invoice', kind: 'scan', name: 'different.pdf' }),
      ]);
      // Claude read the different file as the same invoice (INV-7) as the other two scans.
      expect(scans.find((s) => s.originalName === 'different.pdf')!.duplicates.map((d) => [d.reason, d.kind])).toEqual([
        ['same-invoice', 'scan'],
        ['same-invoice', 'scan'],
      ]);

      // A document stored before fingerprints were kept is fingerprinted when scans are listed.
      ctx.db.prepare('UPDATE documents SET sha256 = NULL').run();
      expect((await listed()).find((s) => s.id === again.id)!.duplicates[0]).toMatchObject({ reason: 'same-file', kind: 'expense' });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE sha256 IS NULL').get()).toEqual({ n: 0 });
    });

    it('matches an invoice in the books only when its invoice or order number agrees too', async () => {
      const year = await createYear();
      const same = await addExpense(year, { invoiceNumber: 'inv 7' });
      await addExpense(year, { invoiceNumber: '' }); // No number: two purchases can share the rest.
      await addExpense(year, { invoiceNumber: 'INV-8' });
      await addExpense(year, { invoiceNumber: 'INV-7', payee: 'Hobbycraft' });
      await addExpense(year, { invoiceNumber: 'INV-7', date: '2025-05-03' });
      await scan('%PDF bead').expect(201);
      await ctx.scans.idle();
      expect((await listed())[0].duplicates).toEqual([
        { reason: 'same-invoice', kind: 'expense', id: same, date: '2025-05-02', payee: 'Bead World', totalPence: 3000, name: null },
      ]);
    });

    it('compares invoice numbers and order numbers', () => {
      const a = { date: '2025-05-02', payee: 'Bead World', totalPence: 3000, invoiceNumber: 'INV-7', orderNumber: '' };
      expect(sameInvoice(a, { ...a, payee: ' bead  world ', invoiceNumber: '#INV-7' })).toBe(true);
      expect(sameInvoice(a, { ...a, invoiceNumber: 'INV-8' })).toBe(false);
      expect(sameInvoice(a, { ...a, invoiceNumber: '' })).toBe(false);
      expect(sameInvoice(a, { ...a, totalPence: 3001 })).toBe(false);
      // The order number alone is enough, but a differing invoice number still rules it out.
      const order = { ...a, invoiceNumber: '', orderNumber: '204-1234' };
      expect(sameInvoice(order, { ...order, invoiceNumber: 'X1' })).toBe(true);
      expect(sameInvoice({ ...order, invoiceNumber: 'X2' }, { ...order, invoiceNumber: 'X1' })).toBe(false);
      expect(sameInvoice({ ...a, date: null }, { ...a, date: null })).toBe(false);
    });
  });

  it('restores a backup made before fingerprints, and fingerprints its documents', async () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 22)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    old.prepare("INSERT INTO scans (filename, original_name, size_bytes, status) VALUES ('scan-0000000000000001.pdf', 'old.pdf', 8, 'failed')").run();
    const dump = dumpSql(old);
    old.close();
    expect(dump).not.toMatch(/sha256/);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    // A backup from before business details has none, so they're set up again before changing anything.
    setUpBusiness(ctx.db);
    fs.writeFileSync(path.join(ctx.paths.uploadsDir, 'scan-0000000000000001.pdf'), '%PDF old');
    await scan('%PDF old', 'new.pdf').expect(201);
    await ctx.scans.idle();
    const scans = (await agent.get('/api/scans').expect(200)).body.scans as { originalName: string; duplicates: { reason: string; name: string }[] }[];
    expect(scans.find((s) => s.originalName === 'new.pdf')!.duplicates).toEqual([expect.objectContaining({ reason: 'same-file', name: 'old.pdf' })]);
  });

  it('restores a backup made before scanning', async () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 21)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    const dump = dumpSql(old);
    old.close();
    expect(dump).not.toMatch(/scans/);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    // A backup from before business details has none, so they're set up again before changing anything.
    setUpBusiness(ctx.db);
    expect((await agent.get('/api/scans').expect(200)).body.scans).toEqual([]);
    await scan('%PDF new').expect(201);
    await ctx.scans.idle();
  });
});

describe('Square', () => {
  const TOKEN = 'EAAAl-test-square-token-WXYZ';
  const gbp = (amount: number) => ({ amount, currency_code: 'GBP' });
  type Entry = { type: string; effective_at?: string; gross: number; fee: number };
  let payouts: { id: string; status: string; amount: number; arrival_date: string; entries: Entry[] }[];
  let calls: string[];
  let payoutsQuery: URLSearchParams;
  let paymentsReadable: boolean;

  const charge = (gross: number, fee: number, at = '2025-11-01T11:00:00Z'): Entry => ({ type: 'CHARGE', effective_at: at, gross, fee });
  const refund = (gross: number, fee: number, at = '2025-11-01T15:00:00Z'): Entry => ({ type: 'REFUND', effective_at: at, gross: -gross, fee: -fee });
  const payout = (id: string, arrival_date: string, entries: Entry[]) => ({
    id,
    status: 'PAID',
    arrival_date,
    amount: entries.reduce((acc, e) => acc + e.gross - e.fee, 0),
    entries,
  });
  const asSquare = (p: (typeof payouts)[number]) => ({ id: p.id, status: p.status, location_id: 'L1', amount_money: gbp(p.amount), arrival_date: p.arrival_date });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    calls = [];
    paymentsReadable = true;
    payouts = [
      payout('po_1', '2025-11-03', [charge(5000, 88), charge(5000, 87)]),
      payout('po_2', '2025-11-10', [charge(3000, 53, '2025-11-08T10:00:00Z'), refund(1000, 18, '2025-11-08T12:00:00Z')]),
    ];
    ctx.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${url.host}${url.pathname}`);
      if ((init?.headers as Record<string, string>).Authorization !== `Bearer ${TOKEN}`) {
        return json({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] }, 401);
      }
      expect((init?.headers as Record<string, string>)['Square-Version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const path = url.pathname;
      if (path === '/v2/merchants/me') return json({ merchant: { id: 'M1', business_name: 'Hedgerow Crafts', currency: 'GBP' } });
      if (path === '/v2/locations') return json({ locations: [{ id: 'L1' }] });
      if (path === '/v2/payments') {
        if (!paymentsReadable) return json({ errors: [{ code: 'INSUFFICIENT_SCOPES', detail: 'PAYMENTS_READ' }] }, 403);
        // Every payment, as each entry's own, with a receipt number of its own.
        const all = payouts.flatMap((p) => p.entries.map((_, i) => `pay_${p.id}_${i}`));
        return json({ payments: all.map((id) => ({ id, receipt_number: `R${id.slice(-3)}`, receipt_url: `https://squareup.com/receipt/preview/${id}`, card_details: { card: { card_brand: 'VISA', last_4: '4242' } } })) });
      }
      if (path === '/v2/payouts') {
        payoutsQuery = url.searchParams;
        expect(url.searchParams.get('location_id')).toBe('L1');
        return json({ payouts: payouts.map(asSquare) });
      }
      const one = path.match(/^\/v2\/payouts\/([^/]+)(\/payout-entries)?$/);
      const p = one && payouts.find((x) => x.id === one[1]);
      if (!p) return json({ errors: [{ code: 'NOT_FOUND', detail: 'Not found' }] }, 404);
      if (!one![2]) return json({ payout: asSquare(p) });
      return json({
        payout_entries: p.entries.map((e, i) => ({
          id: `poe_${i}`,
          payout_id: p.id,
          type: e.type,
          effective_at: e.effective_at ?? '2025-11-01T09:00:00Z',
          gross_amount_money: gbp(e.gross),
          fee_amount_money: gbp(e.fee),
          net_amount_money: gbp(e.gross - e.fee),
          ...(e.type === 'CHARGE' ? { type_charge_details: { payment_id: `pay_${p.id}_${i}` } } : {}),
          ...(e.type === 'REFUND' ? { type_refund_details: { payment_id: `pay_${p.id}_${i}` } } : {}),
        })),
      });
    }) as typeof fetch;
  });

  const connect = () => agent.put('/api/square').send({ accessToken: TOKEN }).expect(200);

  it('checks a token with Square before saving it, and never sends it back', async () => {
    const yearId = await createYear(2025);
    expect((await agent.get('/api/square').expect(200)).body).toMatchObject({ configured: false, environment: 'production', incomeCategoryId: cat('turnover'), feeCategoryId: cat('financeCharges') });
    const bad = await agent.put('/api/square').send({ accessToken: 'EAAAwrong' }).expect(422);
    expect(bad.body.error).toMatch(/didn’t accept the access token/);
    const { body } = await connect();
    expect(body).toMatchObject({ configured: true, tokenHint: '…WXYZ', merchantName: 'Hedgerow Crafts', tokenAddedBy: NAME });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(calls).toContain('connect.squareup.com/v2/merchants/me');

    await agent.put('/api/square').send({ accessToken: TOKEN, environment: 'sandbox' }).expect(200);
    expect(calls.at(-1)).toBe('connect.squareupsandbox.com/v2/merchants/me');
    await agent.put('/api/square').send({ environment: 'production' }).expect(400);

    expect((await agent.delete('/api/square/token').expect(200)).body).toMatchObject({ configured: false, tokenHint: null, merchantName: null });
    await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(404);
  });

  it('refuses a Square account in another currency', async () => {
    const real = ctx.fetch;
    ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/v2/merchants/me') ? json({ merchant: { business_name: 'Elsewhere', currency: 'EUR' } }) : real(input, init)) as typeof fetch;
    expect((await agent.put('/api/square').send({ accessToken: TOKEN }).expect(422)).body.error).toMatch(/EUR/);
  });

  it('lets only editors connect, list payouts and import', async () => {
    const yearId = await createYear(2025);
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await viewer.put('/api/square').send({ accessToken: TOKEN }).expect(403);
    await connect();
    expect((await viewer.get('/api/square').expect(200)).body).toMatchObject({ configured: true, tokenHint: '…WXYZ' });
    await viewer.get(`/api/square/payouts?taxYearId=${yearId}`).expect(403);
    await viewer.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1'] }).expect(403);
    await viewer.delete('/api/square/token').expect(403);
  });

  it('works out each payout’s sales, refunds and fees', async () => {
    const yearId = await createYear(2025);
    await connect();
    const { body } = await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200);
    expect(body.payouts.map((p: { id: string }) => p.id)).toEqual(['po_2', 'po_1']);
    expect(body.payouts[1]).toMatchObject({
      id: 'po_1',
      arrivalDate: '2025-11-03',
      netPence: 9825,
      incomeId: null,
      saleDate: '2025-11-01',
      incomePence: 10000,
      feesPence: 175,
      refundsPence: 0,
      taxYearLabel: '2025-26',
      problem: null,
      possibleDuplicate: null,
    });
    expect(body.payouts[0]).toMatchObject({ netPence: 1965, saleDate: '2025-11-08', incomePence: 2000, feesPence: 35, refundsPence: 1000, problem: null });
  });

  it('dates sales by the UK day, so a late sale in summer is the next day', async () => {
    const yearId = await createYear(2025);
    await connect();
    payouts = [payout('po_late', '2025-06-17', [charge(2000, 35, '2025-06-14T23:30:00Z'), charge(1000, 18, '2025-06-15T10:00:00Z')])];
    const [p] = (await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200)).body.payouts;
    expect(p).toMatchObject({ saleDate: '2025-06-15', saleDates: ['2025-06-15'] });
  });

  it('leaves a payout holding anything but sales and fees to add by hand', async () => {
    const yearId = await createYear(2025);
    await connect();
    payouts.push(payout('po_hold', '2025-11-12', [charge(4000, 70, '2025-11-11T10:00:00Z'), { type: 'RESERVE_HOLD', gross: -500, fee: 0 }]));
    payouts.push(payout('po_refunds', '2025-11-13', [refund(1000, 18)]));
    const list = (await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200)).body.payouts;
    const problem = (id: string) => list.find((p: { id: string }) => p.id === id).problem;
    expect(problem('po_hold')).toMatch(/aren’t sales or fees: reserve hold \(-£5\.00\)/);
    expect(problem('po_refunds')).toMatch(/no card sales/);

    const refused = await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1', 'po_hold'] }).expect(422);
    expect(refused.body.error).toMatch(/^Nothing was imported/);
    expect((await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body).toEqual([]);
  });

  it('lists and imports only the chosen tax year’s sales, whenever they were paid in', async () => {
    const earlier = await createYear(2025);
    const later = await createYear(2026);
    await connect();
    payouts.push(
      payout('po_5apr', '2026-04-07', [charge(3000, 53, '2026-04-05T15:00:00Z')]),
      payout('po_6apr', '2026-04-07', [charge(2000, 35, '2026-04-06T15:00:00Z')]),
    );
    const ids = async (yearId: number) =>
      (await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200)).body.payouts.map((p: { id: string }) => p.id);
    expect(await ids(earlier)).toEqual(['po_5apr', 'po_2', 'po_1']);
    expect(payoutsQuery.get('begin_time')).toBe('2025-04-06T00:00:00Z');
    expect(payoutsQuery.get('end_time')).toBe('2026-04-20T00:00:00Z');
    expect(await ids(later)).toEqual(['po_6apr']);

    const refused = await agent.post('/api/square/import').send({ taxYearId: earlier, payoutIds: ['po_5apr', 'po_6apr'] }).expect(422);
    expect(refused.body.error).toMatch(/outside tax year 2025\/26/);
    await agent.post('/api/square/import').send({ taxYearId: earlier, payoutIds: ['po_5apr'] }).expect(200);
    const [inc] = (await agent.get(`/api/incomes?taxYearId=${earlier}`).expect(200)).body;
    expect(inc).toMatchObject({ date: '2026-04-05', amountPence: 3000, reference: 'po_5apr' });
    expect((await agent.get(`/api/incomes?taxYearId=${later}`).expect(200)).body).toEqual([]);
    await agent.get('/api/square/payouts?taxYearId=999').expect(404);
  });

  it('imports each payout as its sales and an expense for the fees, once', async () => {
    const yearId = await createYear(2025);
    await connect();
    const { body } = await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1', 'po_2'] }).expect(200);
    expect(body).toEqual({ imported: 2, alreadyImported: 0, incomePence: 12000, feesPence: 210, years: [{ taxYearId: yearId, label: '2025-26', firstDate: '2025-11-01' }] });

    const incomes = (await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body;
    expect(incomes).toHaveLength(2);
    expect(incomes[1]).toMatchObject({
      date: '2025-11-01',
      description: 'Square card sales',
      source: 'Square',
      reference: 'po_1',
      paymentMethod: 'bank_transfer',
      amountPence: 10000,
      categoryId: cat('turnover'),
      createdBy: NAME,
    });
    expect(incomes[1].notes).toContain('Square paid £98.25 into the bank on 3 Nov 2025, after £1.75 of fees');
    expect(incomes[0].notes).toContain('Less £10.00 of refunds');

    const expenses = (await agent.get(`/api/expenses?taxYearId=${yearId}`).expect(200)).body;
    expect(expenses).toHaveLength(2);
    const fees = (await agent.get(`/api/expenses/${expenses[1].id}`).expect(200)).body;
    expect(fees).toMatchObject({ date: '2025-11-01', payee: 'Square', orderNumber: 'po_1', paymentMethod: 'bank_transfer', totalPence: 175 });
    expect(fees.lineItems).toMatchObject([{ description: 'Square card processing fees', amountPence: 175, categoryId: cat('financeCharges'), disallowable: false }]);

    // Listed as imported, without fetching their entries again.
    calls = [];
    const list = (await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200)).body.payouts;
    expect(list.map((p: { incomeId: number | null }) => p.incomeId)).toEqual([incomes[0].id, incomes[1].id]);
    expect(list.map((p: { saleDate: string }) => p.saleDate)).toEqual(['2025-11-08', '2025-11-01']);
    expect(calls.some((c) => c.includes('payout-entries'))).toBe(false);

    const again = await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1'] }).expect(200);
    expect(again.body).toMatchObject({ imported: 0, alreadyImported: 1 });
    expect((await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body).toHaveLength(2);
  });

  it('attaches a statement of each payout to its income and fee expense', async () => {
    const yearId = await createYear(2025);
    await connect();
    await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1'] }).expect(200);
    expect(calls).toContain('connect.squareup.com/v2/payments');
    const [income] = (await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body;
    const [expense] = (await agent.get(`/api/expenses?taxYearId=${yearId}`).expect(200)).body;
    expect(income.documents.map((d: { filename: string }) => d.filename)).toEqual(['2025-11-01_Square_payout_po_1_£100.00.pdf']);
    expect(expense.documents.map((d: { filename: string }) => d.filename)).toEqual(['2025-11-01_Square_payout_po_1_fees_£1.75.pdf']);
    const pdf = await agent.get(`/api/documents/${encodeURIComponent('2025-11-01_Square_payout_po_1_£100.00.pdf')}`).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');

    // A clash with a document already stored gets another name.
    payouts.push(payout('po_3', '2025-11-17', [charge(2000, 35, '2025-11-15T10:00:00Z')]));
    const stored = path.join(dataDir, 'uploads', '2025-11-15_Square_payout_po_3_£20.00.pdf');
    fs.writeFileSync(stored, 'x');
    await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_3'] }).expect(200);
    const third = (await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body.find((i: { reference: string }) => i.reference === 'po_3');
    expect(third.documents[0].filename).toBe('2025-11-15_Square_payout_po_3_£20.00-2.pdf');
    expect(fs.readFileSync(stored, 'utf8')).toBe('x');
  });

  it('still imports, without receipt numbers, when the token can’t read payments', async () => {
    const yearId = await createYear(2025);
    await connect();
    paymentsReadable = false;
    await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_2'] }).expect(200);
    const [income] = (await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body;
    expect(income.documents).toHaveLength(1);
  });

  it('lists every entry on the statement, with receipts and a payout fee taken from the payout', () => {
    const entry = (type: string, at: string, gross: number, fee: number, paymentId?: string) => ({
      id: `e_${at}`,
      type,
      effective_at: at,
      gross_amount_money: gbp(gross),
      fee_amount_money: gbp(fee),
      net_amount_money: gbp(gross - fee),
      ...(paymentId ? { type_charge_details: { payment_id: paymentId } } : {}),
    });
    const entries = [entry('CHARGE', '2025-07-05T14:30:00Z', 2000, 35, 'pay_b'), entry('CHARGE', '2025-07-05T09:05:00Z', 1000, 18, 'pay_a')];
    const statement = buildStatement(
      { id: 'po_9', status: 'PAID', amount_money: gbp(2947 - 50), arrival_date: '2025-07-07', payout_fee: [{ amount_money: gbp(50) }] },
      entries,
      new Map([['pay_a', { receiptNumber: 'Ab12', receiptUrl: 'https://squareup.com/receipt/preview/pay_a', card: 'Visa •••• 4242' }]]),
      'Hedgerow Crafts',
      '2025-07-08',
    );
    expect(statement).toMatchObject({ salesPence: 3000, incomePence: 3000, feesPence: 103, netPence: 2897, receiptsRead: true });
    expect(statement.rows).toEqual([
      { when: '05/07/2025 10:05', type: 'Sale', payment: expect.objectContaining({ receiptNumber: 'Ab12' }), grossPence: 1000, feePence: 18, netPence: 982 },
      { when: '05/07/2025 15:30', type: 'Sale', payment: null, grossPence: 2000, feePence: 35, netPence: 1965 },
      { when: '', type: 'Payout fee', payment: null, grossPence: 0, feePence: 50, netPence: -50 },
    ]);
  });

  it('knows a payout brought back from a JSON export by its reference', async () => {
    const yearId = await createYear(2025);
    await connect();
    await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1'] }).expect(200);
    const exported = (await agent.get(`/api/incomes/export.json?taxYearId=${yearId}`).expect(200)).body;
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    const newYearId = await createYear(2025);
    await agent.post('/api/incomes/import').send(exported).expect(201);
    const list = (await agent.get(`/api/square/payouts?taxYearId=${newYearId}`).expect(200)).body.payouts;
    expect(list.find((p: { id: string }) => p.id === 'po_1').incomeId).not.toBeNull();
  });

  it('points out an income already added by hand for the same day and amount', async () => {
    const yearId = await createYear(2025);
    await connect();
    const { body: hand } = await agent.post('/api/incomes').send(income(yearId, { date: '2025-11-01', amountPence: 9825 })).expect(201);
    const list = (await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200)).body.payouts;
    expect(list.find((p: { id: string }) => p.id === 'po_1').possibleDuplicate).toMatchObject({ id: hand.id, amountPence: 9825 });
  });

  it('imports into the categories chosen in Settings', async () => {
    const yearId = await createYear(2025);
    await connect();
    const { body: market } = await agent.post('/api/categories').send({ name: 'Market sales', mapsToCategoryId: cat('turnover') }).expect(201);
    const { body: cardFees } = await agent.post('/api/categories').send({ name: 'Card fees', mapsToCategoryId: cat('financeCharges') }).expect(201);
    await agent.put('/api/square').send({ incomeCategoryId: cat('financeCharges') }).expect(422);
    await agent.put('/api/square').send({ feeCategoryId: cat('depreciation') }).expect(422);
    const { body: status } = await agent.put('/api/square').send({ incomeCategoryId: market.id, feeCategoryId: cardFees.id }).expect(200);
    expect(status).toMatchObject({ incomeCategoryId: market.id, feeCategoryId: cardFees.id });
    await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1'] }).expect(200);
    const [inc] = (await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body;
    expect(inc.categoryId).toBe(market.id);
    const [exp] = (await agent.get(`/api/expenses?taxYearId=${yearId}`).expect(200)).body;
    expect((await agent.get(`/api/expenses/${exp.id}`).expect(200)).body.lineItems[0].categoryId).toBe(cardFees.id);
    // A reset that drops the custom categories falls back to the standard ones.
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/square').expect(200)).body).toMatchObject({ configured: true, incomeCategoryId: cat('turnover'), feeCategoryId: cat('financeCharges') });
  });

  it('puts the fees under a custom category named for them, unless another is chosen', async () => {
    const yearId = await createYear(2025);
    await connect();
    const { body: pitch } = await agent.post('/api/categories').send({ name: 'Pitch fees', mapsToCategoryId: cat('otherExpenses') }).expect(201);
    const { body: squareFees } = await agent.post('/api/categories').send({ name: 'Square processing fees', mapsToCategoryId: cat('financeCharges') }).expect(201);
    expect((await agent.get('/api/square').expect(200)).body).toMatchObject({ feeCategoryId: squareFees.id, feeCategoryAutomatic: true });
    const feeLine = async (payoutId: string) => {
      await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: [payoutId] }).expect(200);
      const expenses = (await agent.get(`/api/expenses?taxYearId=${yearId}`).expect(200)).body;
      const fees = expenses.find((e: { orderNumber: string }) => e.orderNumber === payoutId);
      return (await agent.get(`/api/expenses/${fees.id}`).expect(200)).body.lineItems[0].categoryId;
    };
    expect(await feeLine('po_1')).toBe(squareFees.id);

    // A choice made in Settings wins, and choosing Automatic again goes back to the match.
    expect((await agent.put('/api/square').send({ feeCategoryId: pitch.id }).expect(200)).body).toMatchObject({ feeCategoryId: pitch.id, feeCategoryAutomatic: false });
    expect(await feeLine('po_2')).toBe(pitch.id);
    expect((await agent.put('/api/square').send({ feeCategoryId: null }).expect(200)).body).toMatchObject({ feeCategoryId: squareFees.id, feeCategoryAutomatic: true });
  });

  it('puts the sales under a custom category named for Square, unless another is chosen', async () => {
    const yearId = await createYear(2025);
    await connect();
    const { body: market } = await agent.post('/api/categories').send({ name: 'Market sales', mapsToCategoryId: cat('turnover') }).expect(201);
    const { body: squareSales } = await agent.post('/api/categories').send({ name: 'Square sales', mapsToCategoryId: cat('turnover') }).expect(201);
    expect((await agent.get('/api/square').expect(200)).body).toMatchObject({ incomeCategoryId: squareSales.id, incomeCategoryAutomatic: true });
    const salesCategory = async (payoutId: string) => {
      await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: [payoutId] }).expect(200);
      const incomes = (await agent.get(`/api/incomes?taxYearId=${yearId}`).expect(200)).body;
      return incomes.find((i: { reference: string }) => i.reference === payoutId).categoryId;
    };
    expect(await salesCategory('po_1')).toBe(squareSales.id);

    expect((await agent.put('/api/square').send({ incomeCategoryId: market.id }).expect(200)).body).toMatchObject({ incomeCategoryId: market.id, incomeCategoryAutomatic: false });
    expect(await salesCategory('po_2')).toBe(market.id);
    expect((await agent.put('/api/square').send({ incomeCategoryId: null }).expect(200)).body).toMatchObject({ incomeCategoryId: squareSales.id, incomeCategoryAutomatic: true });
  });

  it('keeps the token out of backups and through a restore', async () => {
    const yearId = await createYear(2025);
    await connect();
    await agent.post('/api/square/import').send({ taxYearId: yearId, payoutIds: ['po_1'] }).expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).not.toMatch(/INSERT INTO "square_settings"/);
    expect(dump).not.toContain(TOKEN);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/square')).body).toMatchObject({ configured: true, merchantName: 'Hedgerow Crafts' });
    const list = (await agent.get(`/api/square/payouts?taxYearId=${yearId}`).expect(200)).body.payouts;
    expect(list.find((p: { id: string }) => p.id === 'po_1').incomeId).not.toBeNull();
  });

  it('upgrades a backup made before Square imports', async () => {
    await connect();
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 23)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    old.prepare("INSERT INTO tax_years (label, start_date, end_date) VALUES ('2025-26', '2025-04-06', '2026-04-05')").run();
    old
      .prepare(
        "INSERT INTO incomes (tax_year_id, date, description, payment_method, amount_pence, category_id) VALUES (1, '2025-11-01', 'Fair', 'cash', 500, (SELECT id FROM categories WHERE hmrc_code = 'turnover'))",
      )
      .run();
    const dump = dumpSql(old);
    old.close();
    expect(dump).toMatch(/schema_version: 23/);

    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    // A backup from before business details has none, so they're set up again before changing anything.
    setUpBusiness(ctx.db);
    expect((await agent.get('/api/square')).body).toMatchObject({ configured: true });
    await agent.post('/api/square/import').send({ taxYearId: 1, payoutIds: ['po_1'] }).expect(200);
    expect((await agent.get('/api/incomes?taxYearId=1').expect(200)).body).toHaveLength(2);
  });
});

describe('HTTPS certificate', () => {
  const DAY = 86_400_000;
  let tlsDir: string;
  /** Caddy restarts asked for in this test; each test has its own, as a restart comes after the answer. */
  let restartCalls: number[];
  const restarts = () => restartCalls.length;

  /** An RSA key pair, made by Node (forge's own is slow) and handed to forge. */
  const keyPair = () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()) as forge.pki.rsa.PrivateKey;
    return { privateKey: key, publicKey: forge.pki.setRsaPublicKey(key.n, key.e) };
  };

  let serial = 1;
  function certificate(opts: { cn: string; names?: { dns?: string; ip?: string }[]; issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }; ca?: boolean; from?: number; to?: number }) {
    const keys = keyPair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(10 + serial++);
    cert.validity.notBefore = new Date(Date.now() + (opts.from ?? -DAY));
    cert.validity.notAfter = new Date(Date.now() + (opts.to ?? 90 * DAY));
    cert.setSubject([{ name: 'commonName', value: opts.cn }]);
    cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : [{ name: 'commonName', value: opts.cn }]);
    const extensions: object[] = [{ name: 'basicConstraints', cA: !!opts.ca }];
    if (opts.names) extensions.push({ name: 'subjectAltName', altNames: opts.names.map((n) => (n.dns ? { type: 2, value: n.dns } : { type: 7, ip: n.ip })) });
    cert.setExtensions(extensions);
    cert.sign(opts.issuer?.key ?? keys.privateKey, forge.md.sha256.create());
    return { cert, key: keys.privateKey };
  }

  const pfx = (key: forge.pki.rsa.PrivateKey | null, certs: forge.pki.Certificate[], password: string, algorithm: '3des' | 'aes256' = 'aes256') =>
    Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, certs, password, { algorithm })).getBytes(), 'binary');

  const NAMES = [{ dns: 'crafty.local' }, { dns: 'localhost' }, { ip: '192.168.1.50' }];

  beforeEach(() => {
    tlsDir = path.join(dataDir, 'caddy-custom');
    const calls: number[] = [];
    restartCalls = calls;
    ctx.config.tls = {
      dir: tlsDir,
      setup: 'restarts-itself',
      restartCommand: null,
      disabled: false,
      siteAddresses: ['localhost', 'crafty.local:8443', '192.168.1.50'],
      localIp: null,
      serverIp: '192.168.1.50',
      domainPort: null,
      caddyAddress: null,
      acmeCa: null,
    };
    ctx.restartCaddy = async () => {
      calls.push(Date.now());
    };
  });

  const upload = (file: Buffer, password: string, as = agent, name = 'site.pfx') => as.put('/api/tls').field('password', password).attach('certificate', file, name);

  it('saves a certificate from a .pfx file, writes it for Caddy, and restarts Caddy after answering', async () => {
    const root = certificate({ cn: 'Test Root', ca: true, to: 3650 * DAY });
    const intermediate = certificate({ cn: 'Test Intermediate', ca: true, issuer: root, to: 365 * DAY });
    const leaf = certificate({ cn: 'crafty.local', names: NAMES, issuer: intermediate });
    // Files can list the chain in any order.
    const res = await upload(pfx(leaf.key, [root.cert, leaf.cert, intermediate.cert], 'secret'), 'secret').expect(200);
    expect(res.body).toMatchObject({
      setup: 'restarts-itself',
      restarting: true,
      certificate: { names: ['crafty.local', 'localhost', '192.168.1.50'], intermediates: 1, selfSigned: false, keyType: 'RSA 2048', uncovered: [], fileName: 'site.pfx', addedBy: NAME },
    });
    expect(res.body.certificate.issuer).toBe('CN=Test Intermediate');
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY/);

    const certPem = fs.readFileSync(path.join(tlsDir, 'cert.pem'), 'utf8');
    const keyPem = fs.readFileSync(path.join(tlsDir, 'key.pem'), 'utf8');
    // The certificate first, then the intermediate; the root (browsers have their own) left out.
    const chain = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!.map((p) => new crypto.X509Certificate(p));
    expect(chain.map((c) => c.subject)).toEqual(['CN=crafty.local', 'CN=Test Intermediate']);
    expect(chain[0].checkPrivateKey(crypto.createPrivateKey(keyPem))).toBe(true);
    expect(fs.statSync(path.join(tlsDir, 'key.pem')).mode & 0o777).toBe(0o600);
    await vi.waitFor(() => expect(restarts()).toBe(1));

    expect((await agent.get('/api/tls').expect(200)).body.certificate.fingerprint).toBe(chain[0].fingerprint256);
  });

  it('opens files with older encryption, and ones without a password', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    await upload(pfx(leaf.key, [leaf.cert], 'secret', '3des'), 'secret').expect(200);
    await upload(pfx(leaf.key, [leaf.cert], ''), '').expect(200);
  });

  it("refuses a wrong password, a file without a key, a key that isn't the certificate's, and certificates out of date", async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    const other = certificate({ cn: 'other.local' });
    expect((await upload(pfx(leaf.key, [leaf.cert], 'secret'), 'wrong').expect(400)).body.error).toMatch(/password doesn't open/);
    expect((await upload(pfx(leaf.key, [leaf.cert], 'secret'), '').expect(400)).body.error).toMatch(/needs its password/);
    expect((await upload(pfx(null, [leaf.cert], 'secret'), 'secret').expect(400)).body.error).toMatch(/no private key/);
    expect((await upload(pfx(leaf.key, [other.cert], 'secret'), 'secret').expect(400)).body.error).toMatch(/None of the certificates/);
    const expired = certificate({ cn: 'crafty.local', from: -90 * DAY, to: -DAY });
    expect((await upload(pfx(expired.key, [expired.cert], 'x'), 'x').expect(400)).body.error).toMatch(/expired on/);
    const future = certificate({ cn: 'crafty.local', from: 5 * DAY });
    expect((await upload(pfx(future.key, [future.cert], 'x'), 'x').expect(400)).body.error).toMatch(/isn't valid until/);
    expect((await upload(Buffer.from('not a certificate'), 'x').expect(400)).body.error).toMatch(/isn't a .pfx or .p12 file/);
    await agent.put('/api/tls').field('password', 'x').expect(400);
    expect(fs.existsSync(path.join(tlsDir, 'cert.pem'))).toBe(false);
    expect(restarts()).toBe(0);
  });

  it('says which addresses in SITE_ADDRESS the certificate is not for', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: [{ dns: 'crafty.local' }] });
    const res = await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    expect(res.body.certificate).toMatchObject({ uncovered: ['localhost', '192.168.1.50'], selfSigned: true });
    expect(['https://crafty.local:8443', '[::1]:8443', '::1', 'Example.COM'].map(siteHost)).toEqual(['crafty.local', '::1', '::1', 'example.com']);
  });

  it("serves the certificate's names that aren't in SITE_ADDRESS too, while it's in use", async () => {
    const block = () => path.join(tlsDir, 'custom.caddy');
    const leaf = certificate({
      cn: 'crafty.local',
      names: [{ dns: 'crafty.local' }, { dns: 'Books.Example.co.uk' }, { dns: 'shop.example.co.uk' }, { dns: '*.example.co.uk' }, { ip: '10.0.0.9' }],
    });
    const res = await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    // Not crafty.local (in SITE_ADDRESS already), the wildcard or the IP address.
    expect(res.body.certificate.added).toEqual(['books.example.co.uk', 'shop.example.co.uk']);
    expect(fs.readFileSync(block(), 'utf8')).toContain(
      `\nbooks.example.co.uk, shop.example.co.uk {\n\ttls ${path.join(tlsDir, 'cert.pem')} ${path.join(tlsDir, 'key.pem')}\n\timport app\n}\n`,
    );
    expect(fs.statSync(block()).mode & 0o777).toBe(0o600);

    // Off port 443 each carries the port, as SITE_ADDRESS does.
    ctx.config.tls = { ...ctx.config.tls, domainPort: 8443 };
    await agent.put('/api/tls/method').send({ method: 'internal' }).expect(200);
    expect(fs.existsSync(block())).toBe(false);
    await agent.put('/api/tls/method').send({ method: 'custom' }).expect(200);
    expect(fs.readFileSync(block(), 'utf8')).toContain('\nbooks.example.co.uk:8443, shop.example.co.uk:8443 {\n');

    // Nothing extra while TLS_CUSTOM=off has Caddy ignore the certificate, or once each name is in SITE_ADDRESS.
    ctx.config.tls = { ...ctx.config.tls, disabled: true };
    writeTlsFiles(ctx);
    expect(fs.existsSync(block())).toBe(false);
    ctx.config.tls = { ...ctx.config.tls, disabled: false, siteAddresses: [...ctx.config.tls.siteAddresses, 'books.example.co.uk', 'https://shop.example.co.uk:8443'] };
    writeTlsFiles(ctx);
    expect(fs.existsSync(block())).toBe(false);
    expect((await agent.get('/api/tls').expect(200)).body.certificate.added).toEqual([]);
  });

  it('removes the certificate and its files, and restarts Caddy', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    await vi.waitFor(() => expect(restarts()).toBe(1));
    expect((await agent.delete('/api/tls').expect(200)).body).toMatchObject({ certificate: null, restarting: true });
    expect(fs.readdirSync(tlsDir)).toEqual([]);
    await vi.waitFor(() => expect(restarts()).toBe(2));
  });

  it("leaves restarting to the person on Docker, and isn't offered where there's no Caddy", async () => {
    ctx.config.tls = { ...ctx.config.tls, setup: 'restart-command', restartCommand: 'cd /srv/crafty && docker compose restart caddy' };
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    expect((await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200)).body).toMatchObject({ restarting: false, restartCommand: 'cd /srv/crafty && docker compose restart caddy' });
    await new Promise((r) => setTimeout(r, 400));
    expect(restarts()).toBe(0);

    ctx.config.tls = { ...ctx.config.tls, dir: null, setup: 'unavailable', restartCommand: null };
    expect((await agent.get('/api/tls').expect(200)).body.setup).toBe('unavailable');
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(409);
    await agent.delete('/api/tls').expect(409);
  });

  it("counts the quick install's local IP address among those served, and points a domain at it", () => {
    const env = { DATA_DIR: dataDir, SITE_ADDRESS: 'craftyaccounting.uk', SITE_IP: 'craftyaccounting.uk', CRAFTY_LOCAL_IP: '192.168.50.204' };
    expect(loadConfig(env).tls).toMatchObject({ siteAddresses: ['craftyaccounting.uk', '192.168.50.204'], serverIp: '192.168.50.204' });
    // Not twice, nor anything that isn't an IPv4 address.
    expect(loadConfig({ ...env, SITE_ADDRESS: 'localhost, https://192.168.50.204:8443' }).tls.siteAddresses).toEqual(['localhost', 'https://192.168.50.204:8443']);
    expect(loadConfig({ ...env, CRAFTY_LOCAL_IP: 'not-an-ip' }).tls).toMatchObject({ siteAddresses: ['craftyaccounting.uk'], serverIp: null });
  });

  it('works out where certificates go from the install', () => {
    const base = { DATA_DIR: dataDir, SITE_ADDRESS: 'localhost, 192.168.1.50' };
    expect(loadConfig(base).tls).toMatchObject({ dir: null, setup: 'unavailable', siteAddresses: ['localhost', '192.168.1.50'] });
    expect(loadConfig({ ...base, CRAFTY_INSTALL: 'docker', CRAFTY_DIR: '/home/me/crafty-accounting', CRAFTY_TLS_DIR: '/tls', TLS_CUSTOM: 'off' }).tls).toEqual({
      dir: '/tls',
      setup: 'restart-command',
      restartCommand: 'cd /home/me/crafty-accounting && docker compose restart caddy',
      disabled: true,
      siteAddresses: ['localhost', '192.168.1.50'],
      localIp: null,
      serverIp: '192.168.1.50',
      domainPort: null,
      caddyAddress: { host: 'caddy', port: 443 },
      acmeCa: null,
    });
  });

  it('lets viewers see the certificate but not change it', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x', viewer).expect(403);
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    await viewer.delete('/api/tls').expect(403);
    expect((await viewer.get('/api/tls').expect(200)).body.certificate.names).toContain('crafty.local');
  });

  it('keeps the certificate out of backups and through a restore and a reset', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    expect(dump).not.toMatch(/INSERT INTO "tls_certificate"/);
    expect(dump).not.toMatch(/PRIVATE KEY/);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    expect((await agent.get('/api/tls')).body.certificate).not.toBeNull();
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    expect((await agent.get('/api/tls')).body.certificate).not.toBeNull();
  });

  it('upgrades a backup made before certificates, keeping the saved one', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES });
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    const old = new Database(':memory:');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 25)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
    seedCategories(old);
    const dump = dumpSql(old);
    old.close();
    expect(dump).not.toMatch(/tls_certificate/);
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
    setUpBusiness(ctx.db);
    expect((await agent.get('/api/tls')).body.certificate.names).toContain('crafty.local');
  });

  it('warns under the bell 30 days before expiry, again at 7 days and once expired, and clears when replaced', async () => {
    const leaf = certificate({ cn: 'crafty.local', names: NAMES, to: 20 * DAY });
    await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
    const open = () => (ctx.db.prepare('SELECT key, title FROM notifications ORDER BY id').all() as { key: string; title: string }[]).filter((n) => n.key.startsWith('certificate-expiry:'));
    expect(open()).toEqual([expect.objectContaining({ key: expect.stringMatching(/:30$/), title: 'The HTTPS certificate expires soon' })]);
    checkCertificateExpiry(ctx, new Date(Date.now() + 15 * DAY));
    expect(open()).toEqual([expect.objectContaining({ key: expect.stringMatching(/:7$/) })]);
    checkCertificateExpiry(ctx, new Date(Date.now() + 25 * DAY));
    expect(open()).toEqual([expect.objectContaining({ key: expect.stringMatching(/:expired$/), title: 'The HTTPS certificate has expired' })]);

    const renewed = certificate({ cn: 'crafty.local', names: NAMES, to: 365 * DAY });
    await upload(pfx(renewed.key, [renewed.cert], 'x'), 'x').expect(200);
    expect(open()).toEqual([]);
  });

  it('downloads the uploaded certificate with its intermediates, never the key', async () => {
    await agent.get('/api/tls/certificate.crt').expect(404);
    const root = certificate({ cn: 'Test Root', ca: true, to: 3650 * DAY });
    const leaf = certificate({ cn: 'crafty.local', names: NAMES, issuer: root });
    await upload(pfx(leaf.key, [leaf.cert, root.cert], 'x'), 'x').expect(200);
    const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
    const res = await viewer.get('/api/tls/certificate.crt').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/x-x509-ca-cert/);
    expect(res.headers['content-disposition']).toContain('crafty-certificate.crt');
    const text = res.text ?? res.body.toString();
    expect(new crypto.X509Certificate(text).fingerprint256).toBe(new crypto.X509Certificate(forge.pki.certificateToPem(leaf.cert)).fingerprint256);
    expect(text).not.toMatch(/PRIVATE KEY/);
  });

  describe('domain on Cloudflare', () => {
    const TOKEN = 'cf_Abcdefghijklmnopqrstuvwxyz0123456789AB';
    let calls: { method: string; path: string }[];
    /** Whether the token may read the zone's DNS records. */
    let dnsReadable: boolean;

    /** Cloudflare's API, with the zone example.co.uk. */
    beforeEach(() => {
      calls = [];
      dnsReadable = true;
      ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const path = url.pathname.replace('/client/v4', '');
        calls.push({ method, path });
        const reply = (status: number, result?: unknown) =>
          new Response(
            JSON.stringify(
              status < 400 ? { success: true, errors: [], result } : { success: false, errors: [{ code: status === 403 ? 10000 : 1000, message: status === 403 ? 'Authentication error' : 'Invalid API Token' }] },
            ),
            { status },
          );
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) return reply(401);
        if (path === '/zones') return reply(200, url.searchParams.get('name') === 'example.co.uk' ? [{ id: 'zone-1', name: 'example.co.uk' }] : []);
        if (path === '/zones/zone-1/dns_records') return dnsReadable ? reply(200, []) : reply(403);
        return reply(404);
      }) as typeof fetch;
    });

    const setUp = (body: object, as = agent) => as.put('/api/tls/domain').send(body);
    const domainFile = () => path.join(tlsDir, 'domain.caddy');

    it("checks the token and zone with Cloudflare, and writes the domain's site block for Caddy", async () => {
      const res = await setUp({ domain: 'Books.Example.co.uk', token: TOKEN }).expect(200);
      expect(res.body).toMatchObject({ restarting: true, serverIp: '192.168.1.50', domain: { domain: 'books.example.co.uk', zone: 'example.co.uk', addedBy: 'Admin' } });
      expect(res.body.domain.tokenHint).not.toContain(TOKEN);
      expect(JSON.stringify((await agent.get('/api/tls').expect(200)).body)).not.toContain(TOKEN);
      // The zone is found from the domain's parent name, and its DNS is only read, never changed.
      expect(calls.filter((c) => c.path === '/zones')).toHaveLength(2);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
      const block = fs.readFileSync(domainFile(), 'utf8');
      expect(block).toMatch(/^books\.example\.co\.uk \{$/m);
      expect(block).toContain(`dns cloudflare ${TOKEN}`);
      expect(block).toContain('import app');
      expect(block).not.toContain('dir ');
      // Caddy's own authority stands in while Let's Encrypt can't issue one.
      expect(block).toMatch(/\t\t\}\n\t\t# .*\n\t\tissuer internal\n/);
      expect(fs.statSync(domainFile()).mode & 0o777).toBe(0o600);
      await vi.waitFor(() => expect(restarts()).toBe(1));

      // Off port 443 the site block carries the port, ACME_CA picks another authority, and the saved token is kept.
      ctx.config.tls = { ...ctx.config.tls, domainPort: 8443, acmeCa: 'https://acme-staging-v02.api.letsencrypt.org/directory' };
      await setUp({ domain: 'accounts.example.co.uk' }).expect(200);
      expect(fs.readFileSync(domainFile(), 'utf8')).toMatch(/^accounts\.example\.co\.uk:8443 \{\n\ttls \{\n\t\tissuer acme \{\n\t\t\tdir https:\/\/acme-staging/m);

      const removed = await agent.delete('/api/tls/domain').expect(200);
      expect(removed.body).toMatchObject({ domain: null, restarting: true });
      expect(fs.existsSync(domainFile())).toBe(false);
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });

    it("refuses what Cloudflare won't allow", async () => {
      await setUp({ domain: 'not a domain', token: TOKEN }).expect(400);
      await setUp({ domain: '192.168.1.50', token: TOKEN }).expect(400);
      expect((await setUp({ domain: 'books.example.co.uk' }).expect(400)).body.error).toMatch(/token/);
      await setUp({ domain: 'books.example.co.uk', token: 'short' }).expect(400);
      expect((await setUp({ domain: 'books.example.co.uk', token: 'x'.repeat(40) }).expect(422)).body.error).toMatch(/didn't accept/);
      expect((await setUp({ domain: 'books.example.com', token: TOKEN }).expect(422)).body.error).toMatch(/can't see a Cloudflare zone/);
      dnsReadable = false;
      expect((await setUp({ domain: 'books.example.co.uk', token: TOKEN }).expect(422)).body.error).toMatch(/DNS → Edit/);
      expect((await agent.get('/api/tls').expect(200)).body.domain).toBeNull();
      expect(fs.existsSync(domainFile())).toBe(false);
    });

    it('takes a domain that is also in SITE_ADDRESS, which then needs no cover from an uploaded certificate', async () => {
      ctx.config.tls = { ...ctx.config.tls, siteAddresses: ['localhost', 'https://Books.example.co.uk:8443', '192.168.1.50'] };
      const leaf = certificate({ cn: 'crafty.local', names: [{ dns: 'crafty.local' }] });
      const uploaded = await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
      expect(uploaded.body.certificate.uncovered).toEqual(['localhost', 'https://Books.example.co.uk:8443', '192.168.1.50']);
      const res = await setUp({ domain: 'books.example.co.uk', token: TOKEN }).expect(200);
      expect(res.body.domain.domain).toBe('books.example.co.uk');
      expect(res.body.certificate.uncovered).toEqual(['localhost', '192.168.1.50']);
    });

    it('says which certificate Caddy serves for the domain', async () => {
      expect((await agent.get('/api/tls/domain/certificate').expect(200)).body).toEqual({ state: 'none' });
      await setUp({ domain: 'books.example.co.uk', token: TOKEN }).expect(200);
      expect((await agent.get('/api/tls/domain/certificate').expect(200)).body.state).toBe('unreachable');

      // A stand-in for Caddy, serving one certificate whatever name is asked for.
      const serve = async (cert: ReturnType<typeof certificate>) => {
        const server = tls.createServer({ cert: forge.pki.certificateToPem(cert.cert), key: forge.pki.privateKeyToPem(cert.key) }, (socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        ctx.config.tls = { ...ctx.config.tls, caddyAddress: { host: '127.0.0.1', port: (server.address() as { port: number }).port } };
        return server;
      };
      let server = await serve(certificate({ cn: 'localhost', names: [{ dns: 'localhost' }] }));
      expect((await agent.get('/api/tls/domain/certificate').expect(200)).body).toEqual({ state: 'waiting' });
      server.close();

      server = await serve(certificate({ cn: 'books.example.co.uk', names: [{ dns: 'books.example.co.uk' }] }));
      const issued = (await agent.get('/api/tls/domain/certificate').expect(200)).body;
      expect(issued).toMatchObject({ state: 'issued', issuer: 'books.example.co.uk', trusted: false });
      server.close();

      // Caddy's own authority standing in.
      const local = certificate({ cn: 'Caddy Local Authority - ECC Intermediate', ca: true });
      server = await serve(certificate({ cn: 'books.example.co.uk', names: [{ dns: 'books.example.co.uk' }], issuer: local }));
      expect((await agent.get('/api/tls/domain/certificate').expect(200)).body).toEqual({ state: 'fallback' });
      server.close();

      ctx.config.tls = { ...ctx.config.tls, caddyAddress: { host: '127.0.0.1', port: 1 } };
      expect((await agent.get('/api/tls/domain/certificate').expect(200)).body.state).toBe('unreachable');

      // Saved but not in use: nothing to ask Caddy.
      await agent.put('/api/tls/method').send({ method: 'internal' }).expect(200);
      expect((await agent.get('/api/tls/domain/certificate').expect(200)).body).toEqual({ state: 'none' });
    });

    it('keeps each method saved while another is in use, writing only its files for Caddy', async () => {
      const files = () => (fs.existsSync(tlsDir) ? fs.readdirSync(tlsDir).sort() : []);
      const method = async () => (await agent.get('/api/tls').expect(200)).body.method;
      expect(await method()).toBe('internal');
      await agent.put('/api/tls/method').send({ method: 'custom' }).expect(400);
      await agent.put('/api/tls/method').send({ method: 'cloudflare' }).expect(400);
      await agent.put('/api/tls/method').send({ method: 'other' }).expect(400);

      // Saving a method's settings starts using it.
      const leaf = certificate({ cn: 'crafty.local', names: NAMES });
      expect((await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200)).body.method).toBe('custom');
      expect(files()).toEqual(['cert.pem', 'key.pem']);
      const set = await setUp({ domain: 'books.example.co.uk', token: TOKEN }).expect(200);
      expect(set.body).toMatchObject({ method: 'cloudflare', certificate: { fileName: 'site.pfx' } });
      expect(files()).toEqual(['domain.caddy']);
      await vi.waitFor(() => expect(restarts()).toBe(2));

      // Switching back needs nothing entering again, and restarts Caddy only for a change.
      const back = await agent.put('/api/tls/method').send({ method: 'custom' }).expect(200);
      expect(back.body).toMatchObject({ method: 'custom', restarting: true, domain: { domain: 'books.example.co.uk' } });
      expect(files()).toEqual(['cert.pem', 'key.pem']);
      expect((await agent.put('/api/tls/method').send({ method: 'custom' }).expect(200)).body.restarting).toBe(false);
      await agent.put('/api/tls/method').send({ method: 'internal' }).expect(200);
      expect(files()).toEqual([]);

      // Removing one not in use changes nothing for Caddy; removing the one in use goes back to Caddy's own.
      expect((await agent.delete('/api/tls').expect(200)).body).toMatchObject({ method: 'internal', certificate: null, restarting: false });
      await agent.put('/api/tls/method').send({ method: 'cloudflare' }).expect(200);
      expect((await agent.delete('/api/tls/domain').expect(200)).body).toMatchObject({ method: 'internal', domain: null, restarting: true });
      expect(files()).toEqual([]);

      const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
      await viewer.put('/api/tls/method').send({ method: 'internal' }).expect(403);
    });

    it('serves addresses added in the app, each with the certificate that covers it', async () => {
      const own = () => path.join(tlsDir, 'addresses.caddy');
      const custom = () => path.join(tlsDir, 'custom.caddy');
      const put = (addresses: string[], as = agent) => as.put('/api/tls/addresses').send({ addresses });

      // Refused: an IP address, a wildcard, and one SITE_ADDRESS has; repeats and the way it's written are tidied.
      expect((await put(['10.0.0.9']).expect(400)).body.error).toMatch(/SITE_ADDRESS/);
      await put(['*.example.co.uk']).expect(400);
      expect((await put(['Crafty.Local']).expect(400)).body.error).toMatch(/served already/);
      const res = await put(['https://Books.Example.co.uk/', 'shop.example.co.uk.', 'books.example.co.uk']).expect(200);
      expect(res.body).toMatchObject({ restarting: true, ownCertificateAddresses: ['books.example.co.uk', 'shop.example.co.uk'] });
      expect(res.body.extraAddresses).toEqual([
        expect.objectContaining({ name: 'books.example.co.uk', addedBy: 'Admin' }),
        expect.objectContaining({ name: 'shop.example.co.uk', addedBy: 'Admin' }),
      ]);
      expect(fs.readFileSync(own(), 'utf8')).toContain('\nbooks.example.co.uk, shop.example.co.uk {\n\ttls {\n\t\tissuer internal\n\t\tprotocols tls1.2 tls1.3\n\t}\n\timport app\n}\n');
      await vi.waitFor(() => expect(restarts()).toBe(1));

      // An uploaded certificate in use serves the ones it covers (by a wildcard here); the app's own the rest.
      const leaf = certificate({ cn: 'crafty.local', names: [...NAMES, { dns: '*.example.co.uk' }] });
      await upload(pfx(leaf.key, [leaf.cert], 'x'), 'x').expect(200);
      expect(fs.readFileSync(custom(), 'utf8')).toMatch(/^books\.example\.co\.uk, shop\.example\.co\.uk \{$/m);
      expect(fs.existsSync(own())).toBe(false);
      await put(['books.example.co.uk', 'crafty.test']).expect(200);
      expect(fs.readFileSync(custom(), 'utf8')).toMatch(/^books\.example\.co\.uk \{$/m);
      expect(fs.readFileSync(own(), 'utf8')).toMatch(/^crafty\.test \{$/m);

      // A domain on Cloudflare in use has its own block, so it isn't in the app's own.
      await setUp({ domain: 'books.example.co.uk', token: TOKEN }).expect(200);
      expect(fs.existsSync(custom())).toBe(false);
      expect(fs.readFileSync(own(), 'utf8')).toMatch(/^crafty\.test \{$/m);
      expect((await agent.get('/api/tls').expect(200)).body.ownCertificateAddresses).toEqual(['crafty.test']);

      // Editors only; kept through a restore and a reset, and out of backups.
      await put([], await addPerson('Accountant', 'read-only-password', 'viewer')).expect(403);
      const dump = (await agent.get('/api/backup.sql').expect(200)).text;
      expect(dump).not.toContain('crafty.test');
      await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
      await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
      expect((await agent.get('/api/tls').expect(200)).body.extraAddresses.map((a: { name: string }) => a.name)).toEqual(['books.example.co.uk', 'crafty.test']);
      await put([]).expect(200);
      expect(fs.existsSync(own())).toBe(false);
    });

    it('works out the method in use from what was saved before methods could be chosen', () => {
      const methodAfter = (rows: string[]) => {
        const old = new Database(':memory:');
        for (const migration of MIGRATIONS.filter((m) => m.version <= 29)) old.exec(migration.sql);
        for (const row of rows) old.exec(row);
        old.exec(MIGRATIONS.find((m) => m.version === 30)!.sql);
        return (old.prepare('SELECT method FROM tls_settings').get() as { method: string }).method;
      };
      const domain = `INSERT INTO tls_domain (id, domain, zone_id, zone_name, api_token, added_by) VALUES (1, 'books.example.co.uk', 'z', 'example.co.uk', 't', 'Admin')`;
      const cert = `INSERT INTO tls_certificate (id, cert_pem, key_pem, added_by) VALUES (1, 'c', 'k', 'Admin')`;
      expect(methodAfter([])).toBe('internal');
      expect(methodAfter([cert])).toBe('custom');
      expect(methodAfter([domain, cert])).toBe('cloudflare');
    });

    it('keeps the domain and token out of backups, through a restore and a reset, and from viewers', async () => {
      const viewer = await addPerson('Accountant', 'read-only-password', 'viewer');
      await setUp({ domain: 'books.example.co.uk', token: TOKEN }, viewer).expect(403);
      await setUp({ domain: 'books.example.co.uk', token: TOKEN }).expect(200);
      await viewer.delete('/api/tls/domain').expect(403);
      expect((await viewer.get('/api/tls').expect(200)).body.domain.domain).toBe('books.example.co.uk');
      const dump = (await agent.get('/api/backup.sql').expect(200)).text;
      expect(dump).not.toContain('tls_domain" VALUES');
      expect(dump).not.toContain(TOKEN);
      await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
      await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
      expect((await agent.get('/api/tls')).body.domain.domain).toBe('books.example.co.uk');
    });

    it('drops the DNS record columns from a domain saved by 1.10.73, keeping the domain', () => {
      const old = new Database(':memory:');
      for (const migration of MIGRATIONS.filter((m) => m.version <= 28)) old.exec(migration.sql);
      old.prepare(`INSERT INTO tls_domain (id, domain, zone_id, zone_name, api_token, dns_record_id, pointed_at, added_by) VALUES (1, 'books.example.co.uk', 'z', 'example.co.uk', ?, 'rec-1', '10.0.0.4', 'Admin')`).run(TOKEN);
      old.exec(MIGRATIONS.find((m) => m.version === 29)!.sql);
      expect(old.prepare('SELECT * FROM tls_domain').get()).toEqual(expect.objectContaining({ domain: 'books.example.co.uk', api_token: TOKEN }));
      expect(Object.keys(old.prepare('SELECT * FROM tls_domain').get() as object)).not.toContain('dns_record_id');
    });

    it('works out where Caddy answers and the server address a domain should point at', () => {
      const env = { DATA_DIR: dataDir, SITE_ADDRESS: 'localhost, crafty.local', SITE_IP: 'localhost', HTTPS_PORT: '8443' };
      expect(loadConfig(env).tls).toMatchObject({ serverIp: null, caddyAddress: null, domainPort: null });
      expect(loadConfig({ ...env, SITE_ADDRESS: 'localhost, 192.168.1.50:8443', CRAFTY_CADDY_ADDRESS: 'proxy:443' }).tls).toMatchObject({
        serverIp: '192.168.1.50',
        caddyAddress: { host: 'proxy', port: 443 },
      });
    });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Category } from '@crafty/shared';
import { createApp } from './app';
import { dumpSql } from './backup';
import { NEXT_UPDATED_AT, nextTimestamp } from './repo';
import { seedCategories } from './db';
import { MIGRATIONS } from './db/migrations';
import { isAutoBackupDue, nextAutoBackup, runAutoBackup } from './autoBackup';
import { loadConfig } from './config';
import { createContext, type AppContext } from './context';
import { documentNameProblem } from './documents';
import { clearData, generateSampleData } from './sampleData';

const NAME = 'Admin';
const PASSWORD = 'test-password';
const PDF = Buffer.from('%PDF-1.4\n%test\n');

let dataDir: string;
let ctx: AppContext;
let agent: ReturnType<typeof request.agent>;
let categories: Category[];

const cat = (code: string) => categories.find((c) => c.hmrcCode === code)!.id;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
  ctx = createContext(loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, CLIENT_DIST: path.join(dataDir, 'none') }));
  agent = request.agent(createApp(ctx));
  await agent.post('/api/auth/login').send({ name: NAME, password: PASSWORD }).expect(200);
  categories = (await agent.get('/api/categories').expect(200)).body;
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createYear(startYear = 2025): Promise<number> {
  const res = await agent.post('/api/tax-years').send({ startYear }).expect(201);
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
    totalPence: 4550,
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

  it('needs ADMIN_PASSWORD only while nobody has been set up', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafty-test-'));
    try {
      expect(() => createContext(loadConfig({ DATA_DIR: emptyDir }))).toThrow(/ADMIN_PASSWORD/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
    // The test install already has a user, so it opens without one.
    ctx.db.close();
    ctx = createContext(loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: 'ignored' }));
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
      .send(expense(yearId, { totalPence: 2500, lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
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
      .send(expense(yearId, { totalPence: 2500, lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
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
        .send(expense(yearId, { totalPence: 2500, lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
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
    await viewer.get('/api/documents/payout.pdf').expect(200);

    const refused = [
      viewer.post('/api/incomes').send(income(yearId)),
      viewer.put(`/api/incomes/${saved.id}`).send(income(yearId)),
      viewer.delete(`/api/incomes/${saved.id}`),
      viewer.post('/api/expenses').send(expense(yearId)),
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

  it('stores documents on outgoing too', async () => {
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
    expect(csv.headers['content-disposition']).toContain('incoming-2025-26.csv');
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Christmas fair');
    expect(lines[1]).toContain('138.00');
  });
});

describe('expenses', () => {
  it('rejects a total that does not equal the line items', async () => {
    const yearId = await createYear();
    const res = await agent.post('/api/expenses').send(expense(yearId, { totalPence: 4000 })).expect(400);
    expect(res.body.error).toMatch(/sum of its line items/);
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
            totalPence: 4200,
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

  it('includes each transaction’s line items in the list', async () => {
    const yearId = await createYear();
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { totalPence: 700, lineItems: [{ description: 'Glue', amountPence: 700, categoryId: cat('costOfGoods') }] }))
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
      totalPence: 2000,
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
    // The standard category on its own is just the outgoing recorded against it.
    expect(
      (await agent.get('/api/reports/breakdown/items').query({ ...range, categoryId: cat('carVanTravelExpenses'), group: '0' }).expect(200)).body,
    ).toEqual([]);
    await agent.get('/api/reports/breakdown/items').query({ ...range, flatRate: 'mileage', payee: 'Shell' }).expect(400);
    const items = (
      await agent.get('/api/reports/breakdown/items').query({ ...range, categoryId: cat('carVanTravelExpenses'), group: '1' }).expect(200)
    ).body;
    expect(items).toMatchObject([{ kind: 'mileage', amountPence: 1350, description: 'Home to Abingdon Market and back' }]);
  });

  it('warns when outgoing in the same category may claim the car twice', async () => {
    const yearId = await createYear();
    const fuel = (disallowable = false) =>
      expense(yearId, {
        payee: 'Shell',
        totalPence: 4000,
        lineItems: [{ description: 'Fuel', amountPence: 4000, categoryId: cat('carVanTravelExpenses'), disallowable }],
      });
    // Fuel alone is fine: no mileage, so the actual-costs method is being used.
    await agent.post('/api/expenses').send(fuel()).expect(201);
    await agent.post('/api/expenses').send(fuel(true)).expect(201);
    expect((await agent.get('/api/mileage').query({ taxYearId: yearId })).body.check).toBeNull();

    await agent.post('/api/mileage').send(trip(yearId)).expect(201);
    const check = { mileagePence: 1350, outgoingPence: 4000, outgoingCount: 1, categoryId: cat('carVanTravelExpenses') };
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
    await agent.post('/api/expenses').send(expense(yearId, { totalPence: 200_000, lineItems: stock })).expect(201);
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

  it('records, updates and clears a submission, and deletes it with the tax year', async () => {
    const yearId = await createYear();
    await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-01', reference: 'ABC123' }).expect(200);
    await agent.put(`/api/mtd/quarters/${yearId}/1/submission`).send({ submittedOn: '2025-08-02' }).expect(200);
    let { body } = await agent.get('/api/mtd/quarters').query({ taxYearId: yearId });
    expect(body.quarters[0].submission).toEqual({ submittedOn: '2025-08-02', reference: null });

    await agent.put(`/api/mtd/quarters/${yearId}/5/submission`).send({ submittedOn: '2025-08-02' }).expect(404);
    await agent.delete(`/api/mtd/quarters/${yearId}/1/submission`).expect(204);
    ({ body } = await agent.get('/api/mtd/quarters').query({ taxYearId: yearId }));
    expect(body.quarters[0].submission).toBeNull();

    await agent.put(`/api/mtd/quarters/${yearId}/2/submission`).send({ submittedOn: '2025-11-01' }).expect(200);
    await agent.delete(`/api/tax-years/${yearId}`).expect(200);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM mtd_submissions').get() as { n: number }).n).toBe(0);
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
        .send(expense(taxYearId, { date, payee, totalPence: lines.reduce((a, l) => a + l.amountPence, 0), lineItems: lines }))
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

describe('year-end summary', () => {
  it('gives SA103S figures that agree with the MTD totals, including custom categories', async () => {
    const yearId = await createYear();
    const filament = (await agent.post('/api/categories').send({ name: 'Filament', mapsToCategoryId: cat('costOfGoods') })).body;
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 120000 })).expect(201);
    await agent.post('/api/incomes').send(income(yearId, { amountPence: 5000, categoryId: cat('other'), date: '2026-01-10' })).expect(201);
    await agent.post('/api/expenses').send(expense(yearId)).expect(201);
    await agent
      .post('/api/expenses')
      .send(expense(yearId, { totalPence: 2500, lineItems: [{ description: 'PLA', amountPence: 2500, categoryId: filament.id }] }))
      .expect(201);

    const { body } = await agent.get('/api/reports/year-end').query({ taxYearId: yearId }).expect(200);
    expect(body.filingDeadline).toBe('2027-01-31');
    const boxes = Object.fromEntries(
      [...body.summary.incomeBoxes, ...body.summary.expenseBoxes].map((b: { box: string; amountPence: number }) => [b.box, b.amountPence]),
    );
    expect(boxes).toMatchObject({ '9': 120000, '10': 5000, '11': 5500, '18': 550, '19': 0 });
    expect(body.summary.totalAllowableExpensesPence).toBe(6050);
    expect(body.summary.disallowable).toEqual([{ hmrcCode: 'otherExpenses', amountPence: 1000 }]);

    const quarters = (await agent.get('/api/mtd/quarters').query({ taxYearId: yearId })).body.quarters;
    expect(body.summary.netProfitPence).toBe(quarters[3].cumulative.totals.netProfitPence);
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
  });
});

describe('sample data', () => {
  const uploads = () => path.join(dataDir, 'uploads');

  it('generates consistent data that the API and backups accept', async () => {
    const result = generateSampleData(ctx.db, uploads(), '2026-10-26');
    expect(result.taxYears).toBe(2);
    expect(result.incomes).toBeGreaterThan(40);
    expect(result.expenses).toBeGreaterThan(40);
    expect(result.documents).toBeGreaterThan(5);
    expect(result.submissions).toBe(5);
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
    expect(body.taxYears.map((y: { label: string }) => y.label)).toEqual(['2026-27', '2025-26']);
    await agent.get('/api/dashboard').query({ taxYearId: body.activeTaxYearId }).expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
  });

  it('can be loaded from the app into an empty install, and is flagged until cleared', async () => {
    expect((await agent.get('/api/sample-data').expect(200)).body).toEqual({ loaded: false, canLoad: true });
    const { body } = await agent.post('/api/sample-data').expect(201);
    expect(body.taxYears).toBe(2);
    expect((await agent.get('/api/sample-data')).body).toEqual({ loaded: true, canLoad: false });
    await agent.post('/api/sample-data').expect(409);

    // Deleting every tax year clears the flag; a reset does too.
    for (const y of (await agent.get('/api/tax-years')).body.taxYears) await agent.delete(`/api/tax-years/${y.id}`).expect(200);
    expect((await agent.get('/api/sample-data')).body).toEqual({ loaded: false, canLoad: true });
    await agent.post('/api/sample-data').expect(201);
    await agent.post('/api/reset').send({ confirm: 'RESET' }).expect(200);
    await createYear();
    expect((await agent.get('/api/sample-data')).body).toEqual({ loaded: false, canLoad: false });
  });

  it('refuses to overwrite existing data, and clears it on request', () => {
    generateSampleData(ctx.db, uploads(), '2026-10-26');
    expect(() => generateSampleData(ctx.db, uploads(), '2026-10-26')).toThrow(/already has data/);
    clearData(ctx.db, uploads());
    expect(fs.readdirSync(uploads())).toHaveLength(0);
    expect(generateSampleData(ctx.db, uploads(), '2026-10-26').taxYears).toBe(2);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Category } from '@crafty/shared';
import { createApp } from './app';
import { loadConfig } from './config';
import { createContext, type AppContext } from './context';
import { documentNameProblem } from './documents';
import { clearData, generateSampleData } from './sampleData';

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
  await agent.post('/api/auth/login').send({ password: PASSWORD }).expect(200);
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
    supplier: 'Bead World',
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
    await anon.post('/api/auth/login').send({ password: 'nope' }).expect(401);
    expect((await anon.get('/api/auth/me')).body.authenticated).toBe(false);
  });
});

describe('categories', () => {
  it('seeds the standard MTD categories', () => {
    expect(categories.filter((c) => c.type === 'INCOME').map((c) => c.hmrcCode)).toEqual(['turnover', 'other']);
    expect(categories.filter((c) => c.type === 'EXPENSE')).toHaveLength(15);
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

  it('switches the active tax year', async () => {
    await createYear(2024);
    const second = await createYear(2025);
    const { body } = await agent.put('/api/tax-years/active').send({ taxYearId: second }).expect(200);
    expect(body.activeTaxYearId).toBe(second);
  });

  it('deletes all transactions and documents in the year', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('document', PDF, 'receipt-1.pdf').expect(201);
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
      .attach('document', PDF, 'Square payout 14-06-2025.pdf')
      .expect(201);
    expect(first.body.documentFilename).toBe('Square payout 14-06-2025.pdf');

    const dup = await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId)))
      .attach('document', PDF, 'Square payout 14-06-2025.pdf')
      .expect(409);
    expect(dup.body.error).toMatch(/already stored/);
    expect((await agent.get('/api/incomes').query({ taxYearId: yearId })).body).toHaveLength(1);

    const doc = await agent.get(`/api/documents/${encodeURIComponent('Square payout 14-06-2025.pdf')}`).expect(200);
    expect(doc.headers['content-type']).toBe('application/pdf');
  });

  it('rejects disallowed file types', async () => {
    const yearId = await createYear();
    await agent.post('/api/incomes').field('data', JSON.stringify(income(yearId))).attach('document', PDF, 'notes.exe').expect(400);
  });

  it('replaces and removes documents on edit, and deletes them with the record', async () => {
    const yearId = await createYear();
    const created = await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId)))
      .attach('document', PDF, 'a.pdf')
      .expect(201);
    const id = created.body.id;
    await agent.put(`/api/incomes/${id}`).field('data', JSON.stringify(income(yearId))).attach('document', PDF, 'b.pdf').expect(200);
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'a.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'b.pdf'))).toBe(true);
    await agent.put(`/api/incomes/${id}`).send(income(yearId, { removeDocument: true })).expect(200);
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'b.pdf'))).toBe(false);
    await agent.put(`/api/incomes/${id}`).field('data', JSON.stringify(income(yearId))).attach('document', PDF, 'c.pdf').expect(200);
    await agent.delete(`/api/incomes/${id}`).expect(204);
    expect(fs.existsSync(path.join(dataDir, 'uploads', 'c.pdf'))).toBe(false);
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
    expect(lines[0]).toContain('Supplier');
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
      supplier: 'Fuel Co',
      totalPence: 2000,
      lineItems: [{ description: 'Diesel', amountPence: 2000, categoryId: cat('carVanTravelExpenses') }],
    })).expect(201);
    const byLine = await agent.get('/api/expenses').query({ taxYearId: yearId, search: 'glass', from: '2025-04-06' }).expect(200);
    expect(byLine.body.map((e: { supplier: string }) => e.supplier)).toEqual(['Bead World']);
    const byCat = await agent.get('/api/expenses').query({ taxYearId: yearId, categoryId: cat('carVanTravelExpenses') }).expect(200);
    expect(byCat.body.map((e: { supplier: string }) => e.supplier)).toEqual(['Fuel Co']);
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
    expect(body.monthly[0].expensesPence).toBe(4550);
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

describe('backup and restore', () => {
  async function seed() {
    const yearId = await createYear();
    await agent
      .post('/api/incomes')
      .field('data', JSON.stringify(income(yearId, { notes: "Line one\nIt's line two" })))
      .attach('document', PDF, 'payout.pdf')
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
        `SELECT document_filename AS name FROM incomes WHERE document_filename IS NOT NULL
         UNION ALL SELECT document_filename FROM expenses WHERE document_filename IS NOT NULL`,
      )
      .all() as { name: string }[];
    expect(docs).toHaveLength(result.documents);
    for (const { name } of docs) expect(fs.existsSync(path.join(uploads(), name))).toBe(true);

    const { body } = await agent.get('/api/tax-years').expect(200);
    expect(body.taxYears.map((y: { label: string }) => y.label)).toEqual(['2026-27', '2025-26']);
    await agent.get('/api/dashboard').query({ taxYearId: body.activeTaxYearId }).expect(200);
    const dump = (await agent.get('/api/backup.sql').expect(200)).text;
    await agent.post('/api/restore').attach('file', Buffer.from(dump), 'backup.sql').expect(200);
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

// Generates realistic sample data for testing: two tax years of craft-fair
// sales and purchases, some attached PDFs and recorded MTD submissions.
// The output is deterministic for a given "today" so test runs are repeatable.
import fs from 'node:fs';
import path from 'node:path';
import {
  mtdQuarters,
  taxMonths,
  taxYearFromStartYear,
  taxYearStartYearForDate,
  todayIso,
} from '@crafty/shared';
import { setSetting, type Db } from './db';

export interface SampleDataResult {
  taxYears: number;
  incomes: number;
  expenses: number;
  documents: number;
  submissions: number;
  trips: number;
}

const FAIRS = [
  'Abingdon Market',
  'Oxford Town Hall Craft Fair',
  'Wallingford Makers Market',
  'Witney Artisan Market',
  'Thame Craft Show',
  'Banbury Spring Fair',
  'Henley Christmas Fair',
  'Didcot Makers Day',
];

/** `custom` names one of CUSTOM_CATEGORIES; otherwise the standard category for `code` is used. */
type Line = { description: string; code: string; custom?: string; min: number; max: number; disallowable?: boolean };
interface Purchase {
  payee: string;
  lines: Line[];
  orderNumber?: boolean;
  payment?: 'cash' | 'card' | 'bank_transfer';
}

const CUSTOM_CATEGORIES = [
  { name: 'Beads', code: 'costOfGoods', type: 'EXPENSE' },
  { name: 'Printer filament', code: 'costOfGoods', type: 'EXPENSE' },
  { name: 'Stall fees', code: 'premisesRunningCosts', type: 'EXPENSE' },
  { name: 'Etsy sales', code: 'turnover', type: 'INCOME' },
] as const;

const PURCHASES: Purchase[] = [
  {
    payee: 'Bead World Ltd',
    orderNumber: true,
    lines: [
      { description: 'Glass beads', code: 'costOfGoods', custom: 'Beads', min: 1200, max: 6500 },
      { description: 'Silver findings', code: 'costOfGoods', min: 800, max: 4200 },
      { description: 'Postage', code: 'adminCosts', min: 295, max: 650 },
    ],
  },
  {
    payee: 'Hobbycraft',
    lines: [
      { description: 'Yarn', code: 'costOfGoods', min: 900, max: 4800 },
      { description: 'Fabric', code: 'costOfGoods', min: 1100, max: 3900 },
      { description: 'Personal craft kit', code: 'otherExpenses', min: 1500, max: 2500, disallowable: true },
    ],
  },
  {
    payee: 'Cotton Reel Supplies',
    orderNumber: true,
    payment: 'bank_transfer',
    lines: [
      { description: 'Cotton thread bundle', code: 'costOfGoods', min: 1500, max: 5200 },
      { description: 'Gift boxes and packaging', code: 'costOfGoods', min: 700, max: 2400 },
    ],
  },
  {
    payee: 'Prusa Research',
    orderNumber: true,
    lines: [
      { description: 'PLA filament 1kg', code: 'costOfGoods', custom: 'Printer filament', min: 2200, max: 6600 },
      { description: 'PETG filament 1kg', code: 'costOfGoods', custom: 'Printer filament', min: 2500, max: 5000 },
      { description: 'Shipping', code: 'adminCosts', min: 495, max: 995 },
    ],
  },
  {
    payee: 'Vistaprint',
    orderNumber: true,
    lines: [
      { description: 'Business cards', code: 'advertisingCosts', min: 1500, max: 3500 },
      { description: 'Pull-up banner', code: 'advertisingCosts', min: 4000, max: 8500 },
    ],
  },
  {
    payee: 'EE Mobile',
    payment: 'bank_transfer',
    lines: [
      { description: 'Phone bill – business use', code: 'adminCosts', min: 1200, max: 1800 },
      { description: 'Phone bill – personal use', code: 'adminCosts', min: 800, max: 1200, disallowable: true },
    ],
  },
  {
    payee: 'Square',
    lines: [{ description: 'Card processing fees', code: 'financeCharges', min: 350, max: 1900 }],
  },
  {
    payee: 'Etsy',
    lines: [
      { description: 'Listing and transaction fees', code: 'financeCharges', min: 400, max: 2200 },
      { description: 'Etsy Ads', code: 'advertisingCosts', min: 500, max: 1500 },
    ],
  },
  {
    payee: 'Screwfix',
    lines: [
      { description: 'Display stand repair parts', code: 'maintenanceCosts', min: 800, max: 3000 },
      { description: 'Gazebo weights', code: 'otherExpenses', min: 1500, max: 2800 },
    ],
  },
];

const YEARLY: Purchase[] = [
  {
    payee: 'Policy Expert',
    payment: 'bank_transfer',
    lines: [{ description: 'Public and product liability insurance', code: 'premisesRunningCosts', min: 9500, max: 13500 }],
  },
  {
    payee: 'Smith & Co Accountants',
    payment: 'bank_transfer',
    lines: [{ description: 'Self Assessment preparation', code: 'professionalFees', min: 15000, max: 25000 }],
  },
];

/** Small deterministic PRNG (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

/** Saturdays from start to end (inclusive). */
function saturdays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7));
  while (iso(d) <= end) {
    out.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

/** A minimal one-page PDF with a line of text. */
function samplePdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, '');
  const stream = `BT /F1 14 Tf 40 140 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function hasData(db: Db): boolean {
  return db.prepare('SELECT 1 FROM tax_years LIMIT 1').get() !== undefined;
}

/** Removes every tax year (and with it all transactions and submissions) and all documents. */
export function clearData(db: Db, uploadsDir: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM tax_years').run();
    db.prepare('UPDATE users SET active_tax_year_id = NULL').run();
  })();
  for (const name of fs.readdirSync(uploadsDir)) fs.rmSync(path.join(uploadsDir, name), { force: true });
}

export function generateSampleData(db: Db, uploadsDir: string, today = todayIso()): SampleDataResult {
  if (hasData(db)) throw new Error('The database already has data. Use --reset to replace it.');
  const rnd = random(20260406);
  const result: SampleDataResult = { taxYears: 0, incomes: 0, expenses: 0, documents: 0, submissions: 0, trips: 0 };

  const category = new Map(
    (db.prepare('SELECT id, hmrc_code FROM categories WHERE is_custom = 0').all() as { id: number; hmrc_code: string }[]).map(
      (c) => [c.hmrc_code, c.id],
    ),
  );
  const custom = new Map<string, number>();
  const insertCategory = db.prepare(
    "INSERT INTO categories (type, name, hmrc_code, sort_order, is_custom) VALUES (?, ?, ?, 1000, 1) ON CONFLICT DO NOTHING",
  );
  const findCategory = db.prepare('SELECT id FROM categories WHERE is_custom = 1 AND type = ? AND name = ? COLLATE NOCASE');
  const lineCategory = (l: Line) => (l.custom ? custom.get(l.custom) : category.get(l.code));
  const insertYear = db.prepare('INSERT INTO tax_years (label, start_date, end_date) VALUES (?, ?, ?)');
  const incomeRow = db.prepare(
    `INSERT INTO incomes (tax_year_id, date, description, reference, payment_method, amount_pence, category_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const expenseRow = db.prepare(
    `INSERT INTO expenses (tax_year_id, date, payee, invoice_number, order_number, description, payment_method, total_pence, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const documentRow = db.prepare('INSERT INTO documents (filename, income_id, expense_id) VALUES (?, ?, ?)');
  // The last argument is an attached document's filename, if any.
  type Value = string | number | null | undefined;
  const insertIncome = (...values: [...Value[], string | null]) => {
    const doc = values.pop() as string | null;
    const { lastInsertRowid } = incomeRow.run(...values);
    if (doc) documentRow.run(doc, lastInsertRowid, null);
  };
  const insertExpense = (...values: [...Value[], string | null]) => {
    const doc = values.pop() as string | null;
    const result = expenseRow.run(...values);
    if (doc) documentRow.run(doc, null, result.lastInsertRowid);
    return result;
  };
  const insertLine = db.prepare(
    `INSERT INTO expense_line_items (expense_id, description, amount_pence, category_id, disallowable, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertTrip = db.prepare(
    'INSERT INTO mileage_trips (tax_year_id, date, description, vehicle, distance_tenths) VALUES (?, ?, ?, ?, ?)',
  );
  const insertHomeMonth = db.prepare('INSERT INTO home_working_months (tax_year_id, month_index, hours) VALUES (?, ?, ?)');
  const insertSubmission = db.prepare('INSERT INTO mtd_submissions (tax_year_id, quarter, submitted_on, reference) VALUES (?, ?, ?, ?)');

  const attach = (name: string, title: string): string | null => {
    const file = path.join(uploadsDir, name);
    if (fs.existsSync(file)) return null;
    fs.writeFileSync(file, samplePdf(title));
    result.documents++;
    return name;
  };

  const addExpense = (yearId: number, date: string, purchase: Purchase, extraLine?: Line) => {
    const lines = [...purchase.lines.filter((l, i) => i === 0 || rnd.chance(l.disallowable ? 0.35 : 0.6))];
    if (extraLine) lines.push(extraLine);
    const amounts = lines.map((l) => rnd.int(l.min, l.max));
    const total = amounts.reduce((a, b) => a + b, 0);
    const invoice = rnd.chance(0.7) ? `INV-${rnd.int(10000, 99999)}` : null;
    const order = purchase.orderNumber ? `ORD-${rnd.int(100000, 999999)}` : null;
    const doc =
      invoice && rnd.chance(0.35) ? attach(`${date} ${purchase.payee} ${invoice}.pdf`, `${purchase.payee} invoice ${invoice}`) : null;
    const { lastInsertRowid } = insertExpense(
      yearId,
      date,
      purchase.payee,
      invoice,
      order,
      null,
      purchase.payment ?? 'card',
      total,
      null,
      doc,
    );
    lines.forEach((l, i) => insertLine.run(lastInsertRowid, l.description, amounts[i], lineCategory(l), l.disallowable ? 1 : 0, i));
    result.expenses++;
  };

  const currentStart = taxYearStartYearForDate(today);
  let currentYearId = 0;

  db.transaction(() => {
    for (const c of CUSTOM_CATEGORIES) {
      insertCategory.run(c.type, c.name, c.code);
      custom.set(c.name, (findCategory.get(c.type, c.name) as { id: number }).id);
    }
    for (const startYear of [currentStart - 1, currentStart]) {
      const year = taxYearFromStartYear(startYear);
      const yearId = Number(insertYear.run(year.label, year.startDate, year.endDate).lastInsertRowid);
      currentYearId = yearId;
      result.taxYears++;
      const end = year.endDate < today ? year.endDate : today;
      if (end < year.startDate) continue;

      // Craft fairs on about two Saturdays a month: card and cash takings.
      for (const date of saturdays(year.startDate, end)) {
        if (!rnd.chance(0.5)) continue;
        const fair = rnd.pick(FAIRS);
        const busy = /Christmas/.test(fair) || date.slice(5, 7) === '12' ? 1.8 : 1;
        const card = Math.round(rnd.int(6000, 42000) * busy);
        const doc = rnd.chance(0.3) ? attach(`${date} ${fair} Square payout.pdf`, `Square payout ${fair} ${date}`) : null;
        insertIncome(yearId, date, `${fair} – card sales`, `SQ-${rnd.int(100000, 999999)}`, 'card', card, category.get('turnover'), null, doc);
        insertIncome(yearId, date, `${fair} – cash sales`, null, 'cash', Math.round(rnd.int(2500, 16000) * busy), category.get('turnover'), null, null);
        result.incomes += 2;
        const feeDate = addDays(date, -rnd.int(7, 30));
        addExpense(yearId, feeDate < year.startDate ? date : feeDate, {
          payee: fair,
          payment: 'bank_transfer',
          lines: [{ description: 'Stall fee', code: 'premisesRunningCosts', custom: 'Stall fees', min: 2500, max: 6500 }],
        });
        // Driving there is claimed as mileage, so there are no fuel receipts for the car.
        insertTrip.run(yearId, date, `Home to ${fair} and back`, 'car', rnd.int(80, 600));
        result.trips++;
      }

      // Monthly Etsy payouts, purchases and bills.
      for (let m = 0; m < 12; m++) {
        const monthStart = addDays(year.startDate, Math.round(m * 30.4));
        if (monthStart > end) break;
        const payoutDate = addDays(monthStart, rnd.int(0, 27));
        if (payoutDate <= end) {
          const doc = rnd.chance(0.5) ? attach(`${payoutDate} Etsy payout.pdf`, `Etsy payout ${payoutDate}`) : null;
          insertIncome(yearId, payoutDate, 'Etsy payout', `ETSY-${rnd.int(1000000, 9999999)}`, 'bank_transfer', rnd.int(3500, 19000), custom.get('Etsy sales'), null, doc);
          result.incomes++;
        }
        for (let i = rnd.int(1, 3); i > 0; i--) {
          const date = addDays(monthStart, rnd.int(0, 27));
          if (date <= end) addExpense(yearId, date, rnd.pick(PURCHASES));
        }
      }

      // Occasional other income and yearly bills.
      for (const offset of [95, 250]) {
        const date = addDays(year.startDate, offset);
        if (date <= end) {
          insertIncome(yearId, date, 'Beading workshop – teaching fee', null, 'bank_transfer', rnd.int(6000, 15000), category.get('other'), 'Taught at the village hall', null);
          result.incomes++;
        }
      }
      YEARLY.forEach((purchase, i) => {
        const date = addDays(year.startDate, 20 + i * 220);
        if (date <= end) addExpense(yearId, date, purchase);
      });

      // Hours making stock at home each month, claimed at the flat rate.
      for (const month of taxMonths(startYear)) {
        if (month.endDate <= end) insertHomeMonth.run(yearId, month.index, rnd.int(15, 130));
      }

      // Record submissions for quarters whose deadline has passed.
      for (const q of mtdQuarters(startYear)) {
        if (q.deadline >= today) continue;
        const submittedOn = addDays(q.deadline, -rnd.int(2, 25));
        insertSubmission.run(yearId, q.quarter, submittedOn, `MTD-${year.label}-Q${q.quarter}`);
        result.submissions++;
      }
    }
    // Everyone starts on the current year.
    db.prepare('UPDATE users SET active_tax_year_id = ?').run(currentYearId);
    // Lets the dashboard remind you this is sample data until it's cleared.
    setSetting(db, 'sample_data_loaded', '1');
  })();

  return result;
}

// Documents scanned in bulk (Expenses → Scan documents). Each is stored in uploads/ as scan-….ext
// with a row in `scans`, then read by the chosen AI (Claude or Gemini) in the background, a few at a time, so a long pile
// keeps going after the page is closed. Someone then checks each reading in the expense form;
// saving it as an expense (with `scanId`) removes the scan.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AI_PROVIDER_INFO, CASH_BASIS_UNUSED_CODE, type InvoiceReading, type Scan, type ScanDuplicate, type ScanStatus } from '@crafty/shared';
import type { AppContext } from './context';
import { activeReader, getAiSettings, type ActiveReader } from './aiSettings';
import type { Db } from './db';
import { documentPath, fileFingerprint, removeDocumentFile } from './documents';
import { HttpError } from './http';
import { invoiceMediaType, unreadableReason } from './invoiceReader';
import { notifyScansRead, syncScansNotification } from './notifications';
import { listCategories } from './repo';

/** How many documents are read at once: quicker than one by one, within the providers' rate limits. */
const READERS_AT_ONCE = 2;

/** Why the chosen AI can't read a file with this name and size, or null if it can. */
export const scanProblem = (db: Db, name: string, sizeBytes: number) => unreadableReason(getAiSettings(db).provider, name, sizeBytes);

/** The categories the AI may choose from: expense ones, without depreciation (cash basis). */
export function readableCategories(db: Db) {
  return listCategories(db)
    .filter((c) => c.type === 'EXPENSE' && c.hmrcCode !== CASH_BASIS_UNUSED_CODE)
    .map(({ id, name, hmrcCode, isCustom }) => ({ id, name, hmrcCode, isCustom }));
}

interface ScanRow {
  id: number;
  filename: string;
  original_name: string;
  size_bytes: number;
  status: ScanStatus;
  reading: string | null;
  error: string | null;
  uploaded_by: string | null;
  created_at: string;
  sha256: string | null;
}

/**
 * Fills in the fingerprints of scans and documents stored before they were kept (or restored
 * from an older backup). Those whose files are missing stay without one.
 */
export function fillFingerprints(ctx: AppContext): void {
  for (const table of ['scans', 'documents'] as const) {
    const rows = ctx.db.prepare(`SELECT id, filename FROM ${table} WHERE sha256 IS NULL`).all() as { id: number; filename: string }[];
    const save = ctx.db.prepare(`UPDATE ${table} SET sha256 = ? WHERE id = ?`);
    for (const row of rows) {
      const file = documentPath(ctx, row.filename);
      if (fs.existsSync(file)) save.run(fileFingerprint(file), row.id);
    }
  }
}

/** An invoice or order number as compared: letters and digits only, in capitals ("inv 7" is INV-7). */
const sameNumber = (text: string | null) => (text ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
const samePayee = (text: string | null) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

interface InvoiceDetails {
  date: string | null;
  payee: string | null;
  totalPence: number | null;
  invoiceNumber: string | null;
  orderNumber: string | null;
}

const readingDetails = (r: InvoiceReading): InvoiceDetails => ({
  date: r.date,
  payee: r.payee,
  totalPence: r.totalPence ?? r.lineItems.reduce((sum, li) => sum + li.amountPence, 0),
  invoiceNumber: r.invoiceNumber,
  orderNumber: r.orderNumber,
});

/**
 * Whether two invoices look like the same one: the same date, payee and total, and the same
 * invoice or order number, with neither number differing where both have it. Without a number
 * in common they never match, as two purchases can share the rest.
 */
export function sameInvoice(a: InvoiceDetails, b: InvoiceDetails): boolean {
  if (!a.date || a.date !== b.date || !a.totalPence || a.totalPence !== b.totalPence) return false;
  if (!samePayee(a.payee) || samePayee(a.payee) !== samePayee(b.payee)) return false;
  let matched = false;
  for (const [x, y] of [
    [a.invoiceNumber, b.invoiceNumber],
    [a.orderNumber, b.orderNumber],
  ]) {
    const [p, q] = [sameNumber(x), sameNumber(y)];
    if (!p || !q) continue;
    if (p !== q) return false;
    matched = true;
  }
  return matched;
}

/** What each scan looks like a copy of: expenses in the books and other scans, by file and by invoice. */
function findDuplicates(db: Db, rows: ScanRow[]): Map<number, ScanDuplicate[]> {
  const found = new Map<number, ScanDuplicate[]>(rows.map((r) => [r.id, []]));
  const readings = new Map(rows.map((r) => [r.id, r.reading ? readingDetails(JSON.parse(r.reading) as InvoiceReading) : null]));
  const add = (scanId: number, dup: ScanDuplicate) => {
    const list = found.get(scanId)!;
    // The same file is the stronger reason; one entry per expense or scan.
    if (!list.some((d) => d.kind === dup.kind && d.id === dup.id)) list.push(dup);
  };
  const scanDup = (other: ScanRow, reason: ScanDuplicate['reason']): ScanDuplicate => {
    const r = readings.get(other.id);
    return { reason, kind: 'scan', id: other.id, date: r?.date ?? null, payee: r?.payee || null, totalPence: r?.totalPence ?? null, name: other.original_name };
  };
  type ExpenseMatch = { id: number; date: string; payee: string; total_pence: number; invoice_number: string | null; order_number: string | null };
  const expenseDup = (e: ExpenseMatch, reason: ScanDuplicate['reason']): ScanDuplicate => ({
    reason,
    kind: 'expense',
    id: e.id,
    date: e.date,
    payee: e.payee,
    totalPence: e.total_pence,
    name: null,
  });

  const byFile = db.prepare(
    `SELECT DISTINCT e.id, e.date, e.payee, e.total_pence, e.invoice_number, e.order_number
     FROM documents d JOIN expenses e ON e.id = d.expense_id WHERE d.sha256 = ? ORDER BY e.date, e.id`,
  );
  const byInvoice = db.prepare(
    'SELECT id, date, payee, total_pence, invoice_number, order_number FROM expenses WHERE date = ? AND total_pence = ? ORDER BY id',
  );
  for (const row of rows) {
    if (row.sha256) {
      for (const e of byFile.all(row.sha256) as ExpenseMatch[]) add(row.id, expenseDup(e, 'same-file'));
      for (const other of rows) if (other.id !== row.id && other.sha256 === row.sha256) add(row.id, scanDup(other, 'same-file'));
    }
    const details = readings.get(row.id);
    if (!details?.date || !details.totalPence) continue;
    for (const e of byInvoice.all(details.date, details.totalPence) as ExpenseMatch[]) {
      const theirs = { date: e.date, payee: e.payee, totalPence: e.total_pence, invoiceNumber: e.invoice_number, orderNumber: e.order_number };
      if (sameInvoice(details, theirs)) add(row.id, expenseDup(e, 'same-invoice'));
    }
    for (const other of rows) {
      const theirs = readings.get(other.id);
      if (other.id !== row.id && theirs && sameInvoice(details, theirs)) add(row.id, scanDup(other, 'same-invoice'));
    }
  }
  return found;
}

const toScan = (row: ScanRow, duplicates: ScanDuplicate[]): Scan => ({
  id: row.id,
  originalName: row.original_name,
  sizeBytes: row.size_bytes,
  status: row.status,
  reading: row.reading ? (JSON.parse(row.reading) as InvoiceReading) : null,
  error: row.error,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at,
  duplicates,
});

/** Every scan, oldest first, each with what it looks like a copy of. */
export function listScans(db: Db): Scan[] {
  const rows = db.prepare('SELECT * FROM scans ORDER BY id').all() as ScanRow[];
  const duplicates = findDuplicates(db, rows);
  return rows.map((row) => toScan(row, duplicates.get(row.id)!));
}

export function getScanRow(db: Db, id: number): ScanRow | null {
  return (db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as ScanRow | undefined) ?? null;
}

export function getScan(db: Db, id: number): Scan | null {
  return listScans(db).find((s) => s.id === id) ?? null;
}

/**
 * Stores an uploaded file as a new scan, moving it out of the temporary folder (the same disk).
 * One the chosen AI can't read is recorded as failed straight away, so it can still be filled in by hand.
 */
export function addScan(ctx: AppContext, upload: { path: string; originalName: string; size: number }, by: string): Scan {
  const filename = `scan-${crypto.randomBytes(8).toString('hex')}${path.extname(upload.originalName).toLowerCase()}`;
  const sha256 = fileFingerprint(upload.path);
  fs.renameSync(upload.path, documentPath(ctx, filename));
  const problem = scanProblem(ctx.db, upload.originalName, upload.size);
  try {
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO scans (filename, original_name, size_bytes, status, error, uploaded_by, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(filename, upload.originalName, upload.size, problem ? 'failed' : 'waiting', problem, by, sha256);
    return getScan(ctx.db, Number(lastInsertRowid))!;
  } catch (err) {
    removeDocumentFile(ctx, filename);
    throw err;
  }
}

/** Removes a scan and its file. */
export function deleteScan(ctx: AppContext, id: number): void {
  const row = getScanRow(ctx.db, id);
  if (!row) throw new HttpError(404, 'That document has already been saved or discarded');
  ctx.db.prepare('DELETE FROM scans WHERE id = ?').run(id);
  removeDocumentFile(ctx, row.filename);
  syncScansNotification(ctx);
}

/** Reads waiting scans with the chosen AI in the background, a few at a time. */
export class ScanReader {
  private running = 0;
  /** Whether anything has been read since the reader was last idle, for the notification. */
  private readSome = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private ctx: AppContext) {}

  /** At start-up and after a restore: anything left mid-read starts again, then reading carries on. */
  resume(): void {
    this.ctx.db.prepare("UPDATE scans SET status = 'waiting' WHERE status = 'reading'").run();
    // After a restore, the notification may be about scans the books no longer have.
    syncScansNotification(this.ctx);
    this.kick();
  }

  /** Starts reading waiting scans, up to the limit. Without a key for the chosen AI they stay waiting. */
  kick(): void {
    const { db } = this.ctx;
    while (this.running < READERS_AT_ONCE) {
      const reader = activeReader(db);
      if (!reader) break;
      const row = db.prepare("SELECT * FROM scans WHERE status = 'waiting' ORDER BY id LIMIT 1").get() as ScanRow | undefined;
      if (!row) break;
      // Claimed before anything is awaited, so two kicks can't take the same one.
      db.prepare("UPDATE scans SET status = 'reading' WHERE id = ?").run(row.id);
      this.running++;
      this.changed();
      void this.read(row, reader).finally(() => {
        this.running--;
        this.kick();
        if (this.running > 0) return;
        if (this.readSome) this.finished();
        for (const done of this.idleWaiters.splice(0)) done();
      });
    }
  }

  /** Resolves once nothing is being read (tests wait on it). */
  idle(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async read(row: ScanRow, { provider, apiKey, model }: ActiveReader): Promise<void> {
    let result: { status: 'ready'; reading: InvoiceReading } | { status: 'failed'; error: string };
    try {
      const data = await fs.promises.readFile(documentPath(this.ctx, row.filename));
      const problem = unreadableReason(provider, row.original_name, row.size_bytes);
      const mediaType = invoiceMediaType(provider, row.original_name);
      // Chosen when another AI was, which could read it.
      if (problem || !mediaType) throw new HttpError(422, problem ?? 'This file can\'t be read.');
      const reading = await this.ctx.readers[provider].readInvoice(apiKey, model, { data, mediaType, categories: readableCategories(this.ctx.db) });
      result = { status: 'ready', reading };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      const message = missing
        ? 'The file is missing from storage.'
        : err instanceof HttpError
          ? err.message
          : `${AI_PROVIDER_INFO[provider].name} could not read it. Try again, or fill it in yourself.`;
      if (!missing && !(err instanceof HttpError)) console.error(`Reading scan ${row.id} failed:`, (err as Error).message);
      result = { status: 'failed', error: message };
    }
    // The books may have been restored or reset meanwhile, so only the same scan, still being read, is updated.
    try {
      const update = this.ctx.db.prepare("UPDATE scans SET status = ?, reading = ?, error = ? WHERE id = ? AND filename = ? AND status = 'reading'");
      const reading = result.status === 'ready' ? JSON.stringify(result.reading) : null;
      const error = result.status === 'failed' ? result.error : null;
      if (update.run(result.status, reading, error, row.id, row.filename).changes) {
        this.readSome = true;
        this.changed();
      }
    } catch (err) {
      // The database was closed (shutting down, or a test finishing).
      console.error(`Saving what was read from scan ${row.id} failed:`, (err as Error).message);
    }
  }

  /** The pile has been read (nothing waiting, or no key to read the rest): says so under the bell. */
  private finished(): void {
    this.readSome = false;
    try {
      notifyScansRead(this.ctx);
    } catch (err) {
      console.error('Raising the scanned documents notification failed:', (err as Error).message);
    }
  }

  /** Tells every open browser, including the one that added the scan. */
  private changed(): void {
    this.ctx.liveUpdates.publish({ area: 'scans', by: AI_PROVIDER_INFO[getAiSettings(this.ctx.db).provider].name }, null);
  }
}

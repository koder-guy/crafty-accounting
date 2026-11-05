// Documents scanned in bulk (Expenses → Scan documents). Each is stored in uploads/ as scan-….ext
// with a row in `scans`, then read by Claude in the background, a few at a time, so a long pile
// keeps going after the page is closed. Someone then checks each reading in the expense form;
// saving it as an expense (with `scanId`) removes the scan.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CASH_BASIS_UNUSED_CODE, type InvoiceReading, type Scan, type ScanStatus } from '@crafty/shared';
import type { AppContext } from './context';
import { getClaudeSettings } from './claudeSettings';
import type { Db } from './db';
import { documentPath, removeDocumentFile } from './documents';
import { HttpError } from './http';
import { MAX_INVOICE_IMAGE_BYTES, type InvoiceMediaType } from './invoiceReader';
import { listCategories } from './repo';

/** How many documents Claude reads at once: quicker than one by one, within Anthropic's rate limits. */
const READERS_AT_ONCE = 2;

const READABLE: Record<string, InvoiceMediaType> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Why Claude can't read a file with this name and size, or null if it can. */
export function unreadableReason(name: string, sizeBytes: number): string | null {
  const mediaType = READABLE[path.extname(name).toLowerCase()];
  if (!mediaType) return 'Claude can read PDF, JPG, PNG and WebP files, not this one. Check it and fill it in yourself.';
  if (mediaType !== 'application/pdf' && sizeBytes > MAX_INVOICE_IMAGE_BYTES) {
    return 'The image is too large for Claude to read (the most is 5 MB). Check it and fill it in yourself.';
  }
  return null;
}

/** The categories Claude may choose from: expense ones, without depreciation (cash basis). */
export function readableCategories(db: Db) {
  return listCategories(db)
    .filter((c) => c.type === 'EXPENSE' && c.hmrcCode !== CASH_BASIS_UNUSED_CODE)
    .map(({ id, name, hmrcCode }) => ({ id, name, hmrcCode }));
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
}

const toScan = (row: ScanRow): Scan => ({
  id: row.id,
  originalName: row.original_name,
  sizeBytes: row.size_bytes,
  status: row.status,
  reading: row.reading ? (JSON.parse(row.reading) as InvoiceReading) : null,
  error: row.error,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at,
});

export function listScans(db: Db): Scan[] {
  return (db.prepare('SELECT * FROM scans ORDER BY id').all() as ScanRow[]).map(toScan);
}

export function getScanRow(db: Db, id: number): ScanRow | null {
  return (db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as ScanRow | undefined) ?? null;
}

export function getScan(db: Db, id: number): Scan | null {
  const row = getScanRow(db, id);
  return row ? toScan(row) : null;
}

/**
 * Stores an uploaded file as a new scan, moving it out of the temporary folder (the same disk).
 * One Claude can't read is recorded as failed straight away, so it can still be filled in by hand.
 */
export function addScan(ctx: AppContext, upload: { path: string; originalName: string; size: number }, by: string): Scan {
  const filename = `scan-${crypto.randomBytes(8).toString('hex')}${path.extname(upload.originalName).toLowerCase()}`;
  fs.renameSync(upload.path, documentPath(ctx, filename));
  const problem = unreadableReason(upload.originalName, upload.size);
  try {
    const { lastInsertRowid } = ctx.db
      .prepare('INSERT INTO scans (filename, original_name, size_bytes, status, error, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(filename, upload.originalName, upload.size, problem ? 'failed' : 'waiting', problem, by);
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
}

/** Reads waiting scans with Claude in the background, a few at a time. */
export class ScanReader {
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private ctx: AppContext) {}

  /** At start-up and after a restore: anything left mid-read starts again, then reading carries on. */
  resume(): void {
    this.ctx.db.prepare("UPDATE scans SET status = 'waiting' WHERE status = 'reading'").run();
    this.kick();
  }

  /** Starts reading waiting scans, up to the limit. Without a Claude key they stay waiting. */
  kick(): void {
    const { db } = this.ctx;
    while (this.running < READERS_AT_ONCE) {
      const settings = getClaudeSettings(db);
      if (!settings.apiKey) break;
      const row = db.prepare("SELECT * FROM scans WHERE status = 'waiting' ORDER BY id LIMIT 1").get() as ScanRow | undefined;
      if (!row) break;
      // Claimed before anything is awaited, so two kicks can't take the same one.
      db.prepare("UPDATE scans SET status = 'reading' WHERE id = ?").run(row.id);
      this.running++;
      this.changed();
      void this.read(row, settings.apiKey, settings.model).finally(() => {
        this.running--;
        this.kick();
        if (this.running === 0) for (const done of this.idleWaiters.splice(0)) done();
      });
    }
  }

  /** Resolves once nothing is being read (tests wait on it). */
  idle(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async read(row: ScanRow, apiKey: string, model: ReturnType<typeof getClaudeSettings>['model']): Promise<void> {
    let result: { status: 'ready'; reading: InvoiceReading } | { status: 'failed'; error: string };
    try {
      const data = await fs.promises.readFile(documentPath(this.ctx, row.filename));
      const mediaType = READABLE[path.extname(row.original_name).toLowerCase()];
      const reading = await this.ctx.claude.readInvoice(apiKey, model, { data, mediaType, categories: readableCategories(this.ctx.db) });
      result = { status: 'ready', reading };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      const message = missing
        ? 'The file is missing from storage.'
        : err instanceof HttpError
          ? err.message
          : 'Claude could not read it. Try again, or fill it in yourself.';
      if (!missing && !(err instanceof HttpError)) console.error(`Reading scan ${row.id} failed:`, (err as Error).message);
      result = { status: 'failed', error: message };
    }
    // The books may have been restored or reset meanwhile, so only the same scan, still being read, is updated.
    try {
      const update = this.ctx.db.prepare("UPDATE scans SET status = ?, reading = ?, error = ? WHERE id = ? AND filename = ? AND status = 'reading'");
      const reading = result.status === 'ready' ? JSON.stringify(result.reading) : null;
      const error = result.status === 'failed' ? result.error : null;
      if (update.run(result.status, reading, error, row.id, row.filename).changes) this.changed();
    } catch (err) {
      // The database was closed (shutting down, or a test finishing).
      console.error(`Saving what was read from scan ${row.id} failed:`, (err as Error).message);
    }
  }

  /** Tells every open browser, including the one that added the scan. */
  private changed(): void {
    this.ctx.liveUpdates.publish({ area: 'scans', by: 'Claude' }, null);
  }
}

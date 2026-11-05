import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { openDatabase, type Db } from './db';
import { LiveUpdates } from './liveUpdates';
import { claudeInvoiceReader, type InvoiceReader } from './invoiceReader';
import { Updates } from './updates';
import { ensureFirstUser } from './users';

export interface AppContext {
  config: Config;
  /** Replaced in place when a backup is restored, so always read it per request. */
  db: Db;
  paths: {
    dbFile: string;
    uploadsDir: string;
    tmpDir: string;
    backupDir: string;
  };
  liveUpdates: LiveUpdates;
  /** Used for calls to HMRC and GitHub; tests replace it. */
  fetch: typeof fetch;
  /** Checking for and applying new versions (Settings → Updates). */
  updates: Updates;
  /** Reads an invoice with Claude; null without ANTHROPIC_API_KEY. Tests replace it. */
  readInvoice: InvoiceReader | null;
}

export function createContext(config: Config): AppContext {
  const paths = {
    dbFile: path.join(config.dataDir, 'crafty.db'),
    uploadsDir: path.join(config.dataDir, 'uploads'),
    tmpDir: path.join(config.dataDir, 'tmp'),
    backupDir: config.backupDir,
  };
  fs.mkdirSync(paths.uploadsDir, { recursive: true });
  fs.rmSync(paths.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  const db = openDatabase(paths.dbFile);
  ensureFirstUser(db, config.adminName, config.adminPassword);
  const ctx = { config, db, paths, liveUpdates: new LiveUpdates(), fetch: (...args) => globalThis.fetch(...args) } as AppContext;
  ctx.updates = new Updates(ctx);
  ctx.readInvoice = config.invoiceReader.apiKey ? claudeInvoiceReader(config.invoiceReader.apiKey, config.invoiceReader.model) : null;
  return ctx;
}

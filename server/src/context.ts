import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { openDatabase, type Db } from './db';
import { LiveUpdates } from './liveUpdates';
import type { DiskSpace } from '@crafty/shared';
import { diskSpace } from './autoBackup';
import type { AiProvider } from '@crafty/shared';
import type { DocumentReader } from './invoiceReader';
import { anthropicReader } from './readers/anthropic';
import { geminiReader } from './readers/gemini';
import { ScanReader } from './scans';
import { restartCaddyService, type CaddyRestarter } from './tlsCertificate';
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
  /** Calls to each AI provider (checking a key, reading an invoice); tests replace them. */
  readers: Record<AiProvider, DocumentReader>;
  /** Reads documents scanned in bulk with the chosen AI, in the background. */
  scans: ScanReader;
  /** Free and total space on the disk holding a folder; tests replace it. */
  diskSpace: (dir: string) => DiskSpace | null;
  /** Restarts Caddy to serve a new HTTPS certificate (quick install only); tests replace it. */
  restartCaddy: CaddyRestarter;
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
  ctx.readers = { claude: anthropicReader, gemini: geminiReader };
  ctx.scans = new ScanReader(ctx);
  ctx.diskSpace = diskSpace;
  ctx.restartCaddy = restartCaddyService;
  return ctx;
}

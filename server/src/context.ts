import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { openDatabase, type Db } from './db';
import { LiveUpdates } from './liveUpdates';
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
  /** Used for calls to HMRC; tests replace it. */
  fetch: typeof fetch;
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
  return { config, db, paths, liveUpdates: new LiveUpdates(), fetch: (...args) => globalThis.fetch(...args) };
}

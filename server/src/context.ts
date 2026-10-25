import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { openDatabase, type Db } from './db';

export interface AppContext {
  config: Config;
  /** Replaced in place when a backup is restored, so always read it per request. */
  db: Db;
  paths: {
    dbFile: string;
    uploadsDir: string;
    tmpDir: string;
  };
}

export function createContext(config: Config): AppContext {
  const paths = {
    dbFile: path.join(config.dataDir, 'crafty.db'),
    uploadsDir: path.join(config.dataDir, 'uploads'),
    tmpDir: path.join(config.dataDir, 'tmp'),
  };
  fs.mkdirSync(paths.uploadsDir, { recursive: true });
  fs.rmSync(paths.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  return { config, db: openDatabase(paths.dbFile), paths };
}

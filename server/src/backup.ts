// Backup format: a plain-text SQL dump with one statement per line (strings
// containing newlines are written with char(10)/char(13)). Restoring only runs
// CREATE TABLE / CREATE INDEX / INSERT lines, each prepared on its own, so a
// tampered file can't smuggle in ATTACH, triggers or other statements.
//
// The zip backup holds backup.sql plus every document under uploads/.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import archiver from 'archiver';
import Database from 'better-sqlite3';
import yauzl from 'yauzl';
import { APP_NAME } from '@crafty/shared';
import type { AppContext } from './context';
import { applyMigrations, openDatabase, schemaVersion, seedCategories, type Db } from './db';
import { CURRENT_SCHEMA_VERSION } from './db/migrations';
import { documentNameProblem } from './documents';
import { HttpError } from './http';

const REQUIRED_TABLES = ['schema_migrations', 'tax_years', 'settings', 'categories', 'incomes', 'expenses', 'expense_line_items', 'mtd_submissions'];
const ALLOWED_STATEMENT = /^(CREATE TABLE |CREATE INDEX |CREATE UNIQUE INDEX |INSERT INTO )/;
const MAX_ZIP_BYTES = 4 * 1024 ** 3;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  const parts = String(value)
    .split(/(\r|\n)/)
    .filter((part, _i, all) => part !== '' || all.length === 1)
    .map((part) => {
      if (part === '\n') return 'char(10)';
      if (part === '\r') return 'char(13)';
      return `'${part.replace(/'/g, "''")}'`;
    });
  return parts.length === 1 ? parts[0] : `(${parts.join(' || ')})`;
}

export function dumpSql(db: Db): string {
  const lines = [
    `-- ${APP_NAME} backup`,
    `-- schema_version: ${schemaVersion(db)}`,
    `-- created: ${new Date().toISOString()}`,
  ];
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
    .all() as { name: string; sql: string }[];
  for (const table of tables) lines.push(`${table.sql.replace(/\s+/g, ' ')};`);
  for (const table of tables) {
    const select = db.prepare(`SELECT * FROM ${quoteIdent(table.name)} ORDER BY rowid`);
    const columns = select
      .columns()
      .map((c) => quoteIdent(c.name))
      .join(', ');
    for (const row of select.raw().iterate() as Iterable<unknown[]>) {
      lines.push(`INSERT INTO ${quoteIdent(table.name)} (${columns}) VALUES (${row.map(sqlLiteral).join(', ')});`);
    }
  }
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY rowid")
    .all() as { sql: string }[];
  for (const index of indexes) lines.push(`${index.sql.replace(/\s+/g, ' ')};`);
  return `${lines.join('\n')}\n`;
}

/** Loads a dump into a new database file, validating it, and returns its path. */
function buildDatabaseFromDump(ctx: AppContext, sql: string): string {
  if (!sql.replace(/^﻿/, '').startsWith(`-- ${APP_NAME} backup`)) {
    throw new HttpError(400, `This file is not a ${APP_NAME} backup`);
  }
  const file = path.join(ctx.paths.tmpDir, `restore-${Date.now()}.db`);
  const temp = new Database(file);
  try {
    temp.transaction(() => {
      for (const raw of sql.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('--') || line.startsWith('﻿--')) continue;
        if (!ALLOWED_STATEMENT.test(line)) throw new HttpError(400, 'The backup contains an unexpected statement');
        try {
          temp.prepare(line).run();
        } catch (err) {
          throw new HttpError(400, `The backup could not be read: ${(err as Error).message}`);
        }
      }
    })();
    const tables = new Set(
      (temp.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name),
    );
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new HttpError(400, `The backup is missing tables: ${missing.join(', ')}`);
    if (schemaVersion(temp) > CURRENT_SCHEMA_VERSION) {
      throw new HttpError(400, 'The backup was made by a newer version of the app. Upgrade the app before restoring it.');
    }
    temp.pragma('foreign_keys = ON');
    applyMigrations(temp);
    seedCategories(temp);
    if ((temp.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new HttpError(400, 'The backup contains records that refer to missing data');
    }
    if (temp.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new HttpError(400, 'The backup database failed an integrity check');
    }
    temp.close();
    return file;
  } catch (err) {
    if (temp.open) temp.close();
    fs.rmSync(file, { force: true });
    throw err;
  }
}

/**
 * Replaces the live database (and, for a zip backup, the uploads folder).
 * The previous database is kept as crafty.pre-restore.db.
 */
export function restoreBackup(ctx: AppContext, sql: string, uploadsFrom?: string): void {
  const newDbFile = buildDatabaseFromDump(ctx, sql);
  const { dbFile, uploadsDir } = ctx.paths;

  ctx.db.pragma('wal_checkpoint(TRUNCATE)');
  ctx.db.close();
  fs.copyFileSync(dbFile, path.join(path.dirname(dbFile), 'crafty.pre-restore.db'));
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.renameSync(newDbFile, dbFile);
  ctx.db = openDatabase(dbFile);

  if (uploadsFrom) {
    const old = `${uploadsDir}.old-${Date.now()}`;
    fs.renameSync(uploadsDir, old);
    fs.renameSync(uploadsFrom, uploadsDir);
    fs.rmSync(old, { recursive: true, force: true });
  }
}

export async function writeZipBackup(ctx: AppContext, out: Writable): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = pipeline(archive, out);
  archive.append(dumpSql(ctx.db), { name: 'backup.sql' });
  for (const name of fs.readdirSync(ctx.paths.uploadsDir)) {
    const file = path.join(ctx.paths.uploadsDir, name);
    if (fs.statSync(file).isFile()) archive.file(file, { name: `uploads/${name}` });
  }
  await archive.finalize();
  await done;
}

/** Extracts a zip backup into a temporary folder; returns the SQL and the uploads folder. */
export function extractZipBackup(ctx: AppContext, zipFile: string): Promise<{ sql: string; uploadsDir: string }> {
  const outDir = path.join(ctx.paths.tmpDir, `restore-uploads-${Date.now()}`);
  fs.mkdirSync(outDir);
  const cleanup = () => fs.rmSync(outDir, { recursive: true, force: true });

  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        cleanup();
        reject(new HttpError(400, 'The file is not a valid zip archive'));
        return;
      }
      let sql: string | null = null;
      let total = 0;
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        zip.close();
        cleanup();
        reject(err instanceof HttpError ? err : new HttpError(400, 'The zip archive could not be read'));
      };

      zip.on('error', fail);
      zip.on('end', () => {
        if (failed) return;
        if (sql === null) fail(new HttpError(400, 'The zip archive does not contain backup.sql'));
        else resolve({ sql, uploadsDir: outDir });
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        total += entry.uncompressedSize;
        if (total > MAX_ZIP_BYTES) return fail(new HttpError(400, 'The zip archive is too large'));
        if (name.endsWith('/')) return zip.readEntry();
        const isSql = name === 'backup.sql';
        const upload = name.startsWith('uploads/') ? name.slice('uploads/'.length) : null;
        if (!isSql && (upload === null || documentNameProblem(upload))) {
          return fail(new HttpError(400, `The zip archive contains an unexpected file: ${name}`));
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return fail(streamErr ?? new Error('stream'));
          if (isSql) {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', fail);
            stream.on('end', () => {
              sql = Buffer.concat(chunks).toString('utf8');
              zip.readEntry();
            });
          } else {
            pipeline(stream, fs.createWriteStream(path.join(outDir, upload!), { flags: 'wx' }))
              .then(() => zip.readEntry())
              .catch(fail);
          }
        });
      });
      zip.readEntry();
    });
  });
}

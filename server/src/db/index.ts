import Database from 'better-sqlite3';
import { ALL_CATEGORIES } from '@crafty/shared';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

export function applyMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const current = schemaVersion(db);
  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }
  });
  apply();
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  return row.version ?? 0;
}

/** Inserts the standard categories, refreshing names if HMRC wording changes. */
export function seedCategories(db: Db): void {
  const upsert = db.prepare(`
    INSERT INTO categories (type, name, hmrc_code, sort_order, is_custom)
    VALUES (@type, @name, @hmrcCode, @sortOrder, 0)
    ON CONFLICT (type, hmrc_code) WHERE is_custom = 0 DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order
  `);
  db.transaction(() => {
    ALL_CATEGORIES.forEach((category, sortOrder) => upsert.run({ ...category, sortOrder }));
  })();
}

export function openDatabase(file: string, options: { wal?: boolean } = {}): Db {
  const db = new Database(file);
  if (options.wal !== false) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  seedCategories(db);
  return db;
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string | null): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

// People who can sign in. Passwords are stored as scrypt hashes with a
// random salt: "scrypt$<salt hex>$<hash hex>".
import crypto from 'node:crypto';
import type { User } from '@crafty/shared';
import type { Db } from './db';

const KEY_LENGTH = 32;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

type Row = Record<string, any>;

const mapUser = (row: Row): User => ({ id: row.id, name: row.name, createdAt: row.created_at });

export function listUsers(db: Db): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all() as Row[]).map(mapUser);
}

export function getUser(db: Db, id: number): (User & { activeTaxYearId: number | null }) | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
  return row ? { ...mapUser(row), activeTaxYearId: row.active_tax_year_id } : null;
}

/** The user with this name (ignoring case) if the password matches. */
export function authenticate(db: Db, name: string, password: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name) as Row | undefined;
  // Hash anyway when the name is unknown, so timing doesn't reveal which names exist.
  const ok = verifyPassword(password, row?.password_hash ?? hashPassword(''));
  return row && ok ? mapUser(row) : null;
}

export function createUser(db: Db, name: string, password: string): number {
  const result = db.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)').run(name, hashPassword(password));
  return Number(result.lastInsertRowid);
}

export const nameTaken = (db: Db, name: string, exceptId = 0) =>
  db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId) !== undefined;

export const userCount = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

/**
 * On a new install (or one upgraded from the single shared password), creates
 * the first user from ADMIN_NAME and ADMIN_PASSWORD. After that, people are
 * managed in Settings → Users and these variables are ignored.
 */
export function ensureFirstUser(db: Db, name: string, password: string | null): void {
  if (userCount(db) > 0) return;
  if (!password) {
    throw new Error('No users exist yet: set ADMIN_PASSWORD (and optionally ADMIN_NAME) to create the first one (see .env.example)');
  }
  createUser(db, name, password);
}

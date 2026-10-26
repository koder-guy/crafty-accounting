// Automatic daily backups: a full .zip (database and documents) written to
// BACKUP_DIR at a set local time, skipped if nothing has changed, keeping the
// newest N. Settings and the last result live in the settings table.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context';
import { getSetting, setSetting, type Db } from './db';
import { dumpSql, writeZipBackup } from './backup';

export const AUTO_BACKUP_PREFIX = 'crafty-accounting-auto-';
const NAME_PATTERN = /^crafty-accounting-auto-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.zip$/;

export interface AutoBackupSettings {
  enabled: boolean;
  /** Local time of day, "HH:MM". */
  time: string;
  /** How many automatic backups to keep. */
  keep: number;
}

export const DEFAULT_AUTO_BACKUP: AutoBackupSettings = { enabled: true, time: '02:00', keep: 30 };

export interface AutoBackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AutoBackupResult {
  status: 'created' | 'skipped' | 'failed';
  file?: string;
  error?: string;
}

export function isAutoBackupName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function getAutoBackupSettings(db: Db): AutoBackupSettings {
  const enabled = getSetting(db, 'auto_backup_enabled');
  const time = getSetting(db, 'auto_backup_time');
  const keep = Number(getSetting(db, 'auto_backup_keep'));
  return {
    enabled: enabled === null ? DEFAULT_AUTO_BACKUP.enabled : enabled === '1',
    time: time && /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_AUTO_BACKUP.time,
    keep: Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_AUTO_BACKUP.keep,
  };
}

export function saveAutoBackupSettings(db: Db, settings: AutoBackupSettings): void {
  setSetting(db, 'auto_backup_enabled', settings.enabled ? '1' : '0');
  setSetting(db, 'auto_backup_time', settings.time);
  setSetting(db, 'auto_backup_keep', String(settings.keep));
}

export function lastAutoBackup(db: Db) {
  const at = getSetting(db, 'auto_backup_last_at');
  if (!at) return null;
  return {
    at,
    status: getSetting(db, 'auto_backup_last_status') as AutoBackupResult['status'],
    file: getSetting(db, 'auto_backup_last_file'),
    error: getSetting(db, 'auto_backup_last_error'),
  };
}

/** Whether the backup folder exists (creating it if needed) and can be written to. */
export function backupDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function listAutoBackups(dir: string): AutoBackupFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(isAutoBackupName);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** True once the set time has passed today and today's run hasn't happened yet. */
export function isAutoBackupDue(settings: AutoBackupSettings, now: Date, lastRunDate: string | null): boolean {
  return settings.enabled && localTime(now) >= settings.time && lastRunDate !== localDate(now);
}

/** When the next scheduled run will happen, as an ISO string (or null if switched off). */
export function nextAutoBackup(settings: AutoBackupSettings, now: Date, lastRunDate: string | null): string | null {
  if (!settings.enabled) return null;
  const [h, m] = settings.time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (lastRunDate === localDate(now)) next.setDate(next.getDate() + 1);
  else if (next <= now) return now.toISOString(); // due now; the scheduler picks it up within a minute
  return next.toISOString();
}

/** A hash of everything a backup contains, to skip backups when nothing changed. */
function fingerprint(ctx: AppContext): string {
  const hash = crypto.createHash('sha256');
  for (const line of dumpSql(ctx.db).split('\n')) {
    // Ignore the dump's timestamp and the backup bookkeeping itself.
    if (line.startsWith('-- created') || line.includes("'auto_backup_")) continue;
    hash.update(line).update('\n');
  }
  for (const name of fs.readdirSync(ctx.paths.uploadsDir).sort()) {
    const stat = fs.statSync(path.join(ctx.paths.uploadsDir, name));
    hash.update(`${name}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

function record(db: Db, now: Date, result: AutoBackupResult, scheduled: boolean): void {
  if (scheduled) setSetting(db, 'auto_backup_last_run_date', localDate(now));
  setSetting(db, 'auto_backup_last_at', now.toISOString());
  setSetting(db, 'auto_backup_last_status', result.status);
  setSetting(db, 'auto_backup_last_file', result.file ?? null);
  setSetting(db, 'auto_backup_last_error', result.error ?? null);
}

let running = false;

/**
 * Writes a backup to the backup folder. A scheduled run is skipped when the
 * data hasn't changed since the last backup; `force` (Back up now) always writes.
 */
export async function runAutoBackup(
  ctx: AppContext,
  { force = false, now = new Date(), scheduled = !force }: { force?: boolean; now?: Date; scheduled?: boolean } = {},
): Promise<AutoBackupResult> {
  if (running) return { status: 'skipped', error: 'A backup is already running' };
  running = true;
  const db = ctx.db;
  const dir = ctx.paths.backupDir;
  try {
    const print = fingerprint(ctx);
    if (!force && print === getSetting(db, 'auto_backup_fingerprint')) {
      const result: AutoBackupResult = { status: 'skipped' };
      record(db, now, result, scheduled);
      return result;
    }
    if (!backupDirWritable(dir)) throw new Error(`The backup folder ${dir} can't be written to`);

    const stem = `${AUTO_BACKUP_PREFIX}${localDate(now)}-${localTime(now).replace(':', '')}`;
    let name = `${stem}.zip`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}.zip`;
    const partial = path.join(dir, `.${name}.partial`);
    try {
      await writeZipBackup(ctx, fs.createWriteStream(partial));
      fs.renameSync(partial, path.join(dir, name));
    } finally {
      fs.rmSync(partial, { force: true });
    }

    // Keep only the newest backups.
    const keep = getAutoBackupSettings(db).keep;
    for (const old of listAutoBackups(dir).slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });

    setSetting(ctx.db, 'auto_backup_fingerprint', print);
    const result: AutoBackupResult = { status: 'created', file: name };
    record(ctx.db, now, result, scheduled);
    return result;
  } catch (err) {
    const result: AutoBackupResult = { status: 'failed', error: (err as Error).message };
    console.error('Automatic backup failed:', result.error);
    record(ctx.db, now, result, scheduled);
    return result;
  } finally {
    running = false;
  }
}

/** Checks once a minute whether the daily backup is due. Returns a stop function. */
export function startAutoBackupScheduler(ctx: AppContext): () => void {
  const tick = () => {
    const now = new Date();
    const settings = getAutoBackupSettings(ctx.db);
    if (isAutoBackupDue(settings, now, getSetting(ctx.db, 'auto_backup_last_run_date'))) {
      void runAutoBackup(ctx, { now });
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(timer);
}

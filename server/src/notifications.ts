// Notifications under the bell: conditions the server notices (an update to install, a disk
// running low) that someone should act on. Each is keyed by its condition, so it's raised once
// while the condition lasts and removed when it ends; each person marks it read for themselves.
// Like the people, they belong to the install: left out of backups, kept through restore and reset.
import crypto from 'node:crypto';
import { APP_NAME, APP_VERSION, CERTIFICATE_WARN_DAYS, daysUntil, diskSize, lowSpaceThreshold, type AppNotification, type DiskSpace, type NotificationKind, type Role, type UpdateStatus } from '@crafty/shared';
import { diskSpace, listAutoBackups, sameDisk } from './autoBackup';
import type { AppContext } from './context';
import type { Db } from './db';
import { savedCertificate } from './tlsCertificate';
import { compareVersions, parseVersion } from './updates';

/** Who sees a notification: everyone, or only those who can act on it. */
export type Audience = 'all' | 'editors';

export interface NewNotification {
  key: string;
  kind: NotificationKind;
  title: string;
  message: string;
  link?: string | null;
  audience: Audience;
}

/** Tells open browsers to refetch their notifications. */
const announce = (ctx: AppContext) => ctx.liveUpdates.publish({ area: 'notifications', by: APP_NAME }, null);

/**
 * Raises a notification for a condition, unless one for it is already open; then only its
 * wording is brought up to date, quietly, so it doesn't become unread again. Returns whether it's new.
 */
export function raiseNotification(ctx: AppContext, n: NewNotification): boolean {
  const existing = ctx.db.prepare('SELECT id FROM notifications WHERE key = ?').get(n.key) as { id: number } | undefined;
  if (existing) {
    ctx.db
      .prepare('UPDATE notifications SET title = ?, message = ?, link = ?, audience = ? WHERE id = ?')
      .run(n.title, n.message, n.link ?? null, n.audience, existing.id);
    return false;
  }
  ctx.db
    .prepare('INSERT INTO notifications (key, kind, title, message, link, audience) VALUES (?, ?, ?, ?, ?, ?)')
    .run(n.key, n.kind, n.title, n.message, n.link ?? null, n.audience);
  announce(ctx);
  return true;
}

/** Removes the notifications for conditions that have ended. Returns how many went. */
export function resolveNotifications(ctx: AppContext, keys: string[]): number {
  if (!keys.length) return 0;
  const { changes } = ctx.db.prepare(`DELETE FROM notifications WHERE key IN (${keys.map(() => '?').join(', ')})`).run(...keys);
  if (changes) announce(ctx);
  return changes;
}

const openKeys = (db: Db, prefix: string) =>
  (db.prepare("SELECT key FROM notifications WHERE key LIKE ? ESCAPE '\\'").all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as { key: string }[]).map(
    (r) => r.key,
  );

/** A person's unread notifications, newest first. */
export function unreadNotifications(db: Db, user: { id: number; role: Role }): AppNotification[] {
  return db
    .prepare(
      `SELECT id, kind, title, message, link, created_at AS createdAt FROM notifications n
       WHERE (audience = 'all' OR ? = 'editor')
         AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?)
       ORDER BY created_at DESC, id DESC`,
    )
    .all(user.role, user.id) as AppNotification[];
}

/** Marks one notification (or, with null, every one they can see) read for a person. */
export function markNotificationsRead(db: Db, user: { id: number; role: Role }, id: number | null): void {
  const ids = id === null ? unreadNotifications(db, user).map((n) => n.id) : [id];
  const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) SELECT id, ? FROM notifications WHERE id = ?');
  db.transaction(() => {
    for (const nid of ids) insert.run(user.id, nid);
  })();
}

// ---- Updates ----

const UPDATE_KEY = 'update:';

/**
 * Keeps the update notification in step with the newest release: raised for it, and gone once
 * it's installed or a newer one replaces it. `checked` is false before GitHub has been asked
 * (just after starting), when only versions already installed are cleared.
 */
export function syncUpdateNotification(ctx: AppContext, available: UpdateStatus['available'], checked: boolean): void {
  const current = parseVersion(APP_VERSION)!;
  const stale = openKeys(ctx.db, UPDATE_KEY).filter((key) => {
    const version = key.slice(UPDATE_KEY.length);
    const parsed = parseVersion(version);
    if (!parsed || compareVersions(parsed, current) <= 0) return true;
    return checked && version !== available?.version;
  });
  resolveNotifications(ctx, stale);
  if (!available) return;
  const how = ctx.config.updates.install === 'native' ? 'Install it from Settings → Updates.' : 'Settings → Updates says how to install it.';
  raiseNotification(ctx, {
    key: `${UPDATE_KEY}${available.version}`,
    kind: 'update',
    title: `Version ${available.version} is available`,
    message: `You're running version ${APP_VERSION}. ${how}`,
    link: '/settings/updates',
    audience: 'editors',
  });
}

// ---- Scanned documents ----

const SCANS_KEY = 'scans-read:';

const scansToCheck = (db: Db) =>
  db.prepare("SELECT status, COUNT(*) AS n FROM scans WHERE status IN ('ready', 'failed') GROUP BY status").all() as { status: 'ready' | 'failed'; n: number }[];

/**
 * When the AI has finished reading a pile of scanned documents: a new notification (unread again
 * for everyone, replacing the last one) saying how many are waiting to be checked.
 */
export function notifyScansRead(ctx: AppContext): void {
  const counts = scansToCheck(ctx.db);
  const ready = counts.find((c) => c.status === 'ready')?.n ?? 0;
  const failed = counts.find((c) => c.status === 'failed')?.n ?? 0;
  if (!ready && !failed) return;
  const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;
  const parts = [ready && `${docs(ready)} ${ready === 1 ? 'is' : 'are'} ready to check`, failed && `${docs(failed)} couldn't be read and need${failed === 1 ? 's' : ''} filling in by hand`].filter(Boolean);
  const message = `${parts.join(', and ')}.`;
  const stale = openKeys(ctx.db, SCANS_KEY);
  raiseNotification(ctx, {
    key: `${SCANS_KEY}${crypto.randomUUID()}`,
    kind: 'scans-read',
    title: 'Scanned documents have been read',
    message,
    link: '/expenses/scans',
    audience: 'editors',
  });
  resolveNotifications(ctx, stale);
}

/** Removes the scanned documents notification once none are left to check. */
export function syncScansNotification(ctx: AppContext): void {
  if (scansToCheck(ctx.db).length) return;
  resolveNotifications(ctx, openKeys(ctx.db, SCANS_KEY));
}

// ---- Disk space ----

/** Once low, a disk counts as fine again only with this much more than the limit, so it doesn't flicker. */
const RECOVERED = 1.25;

type ReadSpace = (dir: string) => DiskSpace | null;

/**
 * Raises a notification when the disk holding the data (or the backups, if they're on another
 * disk) runs low, by the same rule as Settings → Backup and Restore, and removes it once there's room.
 */
export function checkDiskSpace(ctx: AppContext, readSpace: ReadSpace = diskSpace): void {
  const newestBackup = listAutoBackups(ctx.paths.backupDir)[0]?.sizeBytes ?? 0;
  const limit = lowSpaceThreshold(newestBackup);
  const disks = [{ key: 'low-space:data', dir: ctx.config.dataDir, what: 'The disk holding your books and documents' }];
  const ended: string[] = [];
  // Backups on the same disk as the data are covered by the data's notification.
  if (sameDisk(ctx.config.dataDir, ctx.paths.backupDir)) ended.push('low-space:backups');
  else disks.push({ key: 'low-space:backups', dir: ctx.paths.backupDir, what: 'The disk holding your automatic backups' });

  for (const { key, dir, what } of disks) {
    const space = readSpace(dir);
    if (!space) continue; // can't be read: leave things as they are
    if (space.freeBytes < limit) {
      raiseNotification(ctx, {
        key,
        kind: 'low-space',
        title: 'Disk space is running low',
        message: `${what} has ${diskSize(space.freeBytes)} free of ${diskSize(space.totalBytes)}. Free up some space, or keep fewer automatic backups, before it fills up.`,
        link: '/settings/backup',
        audience: 'editors',
      });
    } else if (space.freeBytes >= limit * RECOVERED) {
      ended.push(key);
    }
  }
  resolveNotifications(ctx, ended);
}

// ---- HTTPS certificate ----

const CERTIFICATE_KEY = 'certificate-expiry:';

/**
 * Warns when the uploaded HTTPS certificate is within 30 days of expiring, again (unread once
 * more) at 7 days and once it has expired; gone when it's replaced, removed or switched off.
 */
export function checkCertificateExpiry(ctx: AppContext, now = new Date()): void {
  const cert = ctx.config.tls.disabled ? null : savedCertificate(ctx);
  let key: string | null = null;
  if (cert) {
    const days = daysUntil(cert.validTo, now);
    const stage = days < 0 ? 'expired' : CERTIFICATE_WARN_DAYS.filter((d) => days < d).at(-1);
    if (stage !== undefined) {
      key = `${CERTIFICATE_KEY}${cert.fingerprint}:${stage}`;
      const date = new Date(cert.validTo).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
      raiseNotification(ctx, {
        key,
        kind: 'certificate-expiry',
        title: days < 0 ? 'The HTTPS certificate has expired' : 'The HTTPS certificate expires soon',
        message:
          days < 0
            ? `It expired on ${date}, so browsers warn before opening the app. Upload a renewed one in Settings → HTTPS Certificate.`
            : `It expires on ${date}${days === 0 ? ' (today)' : days === 1 ? ' (tomorrow)' : `, in ${days} days`}. Upload a renewed one in Settings → HTTPS Certificate before then, or browsers will warn before opening the app.`,
        link: '/settings/https',
        audience: 'editors',
      });
    }
  }
  resolveNotifications(ctx, openKeys(ctx.db, CERTIFICATE_KEY).filter((k) => k !== key));
}

const DISK_CHECK_EVERY_MS = 5 * 60 * 1000;

/** Checks the disks shortly after starting and every few minutes, and clears update notifications already installed. */
export function startNotificationChecks(ctx: AppContext): () => void {
  syncUpdateNotification(ctx, null, false);
  const tick = () => {
    try {
      checkDiskSpace(ctx);
    } catch (err) {
      console.error('Checking disk space failed:', (err as Error).message);
    }
    try {
      checkCertificateExpiry(ctx);
    } catch (err) {
      console.error('Checking the HTTPS certificate failed:', (err as Error).message);
    }
  };
  const first = setTimeout(tick, 5_000);
  first.unref();
  const timer = setInterval(tick, DISK_CHECK_EVERY_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

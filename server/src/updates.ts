// Checking GitHub for new releases, and updating an install.sh install from Settings → Updates.
// Releases are the repository's vX.Y.Z tags, which is also what the installers install.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_VERSION, type UpdateStatus } from '@crafty/shared';
import { runAutoBackup } from './autoBackup';
import type { AppContext } from './context';
import { HttpError } from './http';
import { syncUpdateNotification } from './notifications';

export const UPDATE_REPO = 'koder-guy/crafty-accounting';
const GITHUB_API = `https://api.github.com/repos/${UPDATE_REPO}`;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const UPDATE_LOG = 'update.log';

type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The newest vX.Y.Z tag name, ignoring anything else. */
export function newestTag(names: string[]): string | null {
  let best: { name: string; version: Version } | null = null;
  for (const name of names) {
    const version = parseVersion(name);
    if (version && name.startsWith('v') && (!best || compareVersions(version, best.version) > 0)) best = { name, version };
  }
  return best?.name ?? null;
}

/** Commit summaries worth showing: first lines, without the release commits themselves. */
export function changeSummaries(messages: string[]): string[] {
  return messages
    .map((m) => m.split('\n')[0].trim())
    .filter((line) => line && !/^Version \d+\.\d+\.\d+$/.test(line) && !/^Merge (branch|pull request) /.test(line))
    .reverse();
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Runs `crafty update` for a release tag and resolves with its exit code. Tests replace it. */
export type Updater = (installDir: string, tag: string, logFile: string) => Promise<number | null>;

const runCraftyUpdate: Updater = (installDir, tag, logFile) =>
  new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    // Only what the installer needs: the app's own settings (NODE_ENV=production in particular,
    // which makes npm leave out the build tools) mustn't reach it.
    const env: NodeJS.ProcessEnv = { CRAFTY_BRANCH: tag };
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    // Detached in a session of its own: the update stops this server and starts the new one.
    const child = spawn(path.join(installDir, 'crafty'), ['update'], { cwd: installDir, env, detached: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    child.on('error', (err) => {
      fs.appendFileSync(logFile, `\n${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code));
    child.unref();
  });

export class Updates {
  private checkedAt: string | null = null;
  private checkError: string | null = null;
  private available: UpdateStatus['available'] = null;
  private applying: UpdateStatus['applying'] = null;
  private failed: UpdateStatus['failed'] = null;
  private checking: Promise<void> | null = null;
  runUpdater: Updater = runCraftyUpdate;

  constructor(private ctx: AppContext) {}

  status(): UpdateStatus {
    const { install, installDir, autoCheck } = this.ctx.config.updates;
    return {
      currentVersion: APP_VERSION,
      install,
      installDir,
      autoCheck,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      available: this.available,
      applying: this.applying,
      failed: this.failed,
    };
  }

  private async github<T>(pathname: string): Promise<T> {
    const res = await this.ctx.fetch(`${GITHUB_API}${pathname}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${APP_NAME.replace(/ /g, '-')}/${APP_VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting how often this address can check; try again in an hour');
      throw new Error(`GitHub answered ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Asks GitHub for the newest release. Concurrent callers share one check. */
  check(): Promise<void> {
    this.checking ??= this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(): Promise<void> {
    try {
      const tags = await this.github<{ name: string }[]>('/tags?per_page=100');
      const tag = newestTag(tags.map((t) => t.name));
      const newest = tag && parseVersion(tag);
      const current = parseVersion(APP_VERSION)!;
      if (!tag || !newest || compareVersions(newest, current) <= 0) {
        this.available = null;
      } else {
        let changes: string[] = [];
        try {
          const compare = await this.github<{ commits: { commit: { message: string } }[] }>(`/compare/v${APP_VERSION}...${tag}`);
          changes = changeSummaries(compare.commits.map((c) => c.commit.message));
        } catch {
          // The list of changes is a nicety; the update is still there.
        }
        this.available = { version: tag.slice(1), url: `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`, changes };
      }
      this.checkError = null;
      syncUpdateNotification(this.ctx, this.available, true);
    } catch (err) {
      const message = (err as Error).name === 'TimeoutError' ? 'GitHub took too long to answer' : (err as Error).message;
      this.checkError = `Couldn't check for updates: ${message}`;
    }
    this.checkedAt = new Date().toISOString();
  }

  /**
   * Starts updating an install.sh install to the version the person confirmed, after
   * saving a backup. Resolves once the update has started; it finishes by restarting the app.
   */
  async apply(version: string): Promise<void> {
    const { install, installDir } = this.ctx.config.updates;
    if (install !== 'native' || !installDir) throw new HttpError(409, "This copy of the app can't update itself; see Settings → Updates for how to update it");
    if (this.applying) throw new HttpError(409, `Already updating to version ${this.applying.version}`);
    if (!this.available || this.available.version !== version) {
      throw new HttpError(409, `Version ${version} isn't the newest version available any more. Check for updates again.`);
    }

    this.applying = { version, startedAt: new Date().toISOString() };
    this.failed = null;
    try {
      const backup = await runAutoBackup(this.ctx, { force: true });
      if (backup.status !== 'created') throw new HttpError(500, `Couldn't save a backup before updating, so the update didn't start: ${backup.error}`);
    } catch (err) {
      this.applying = null;
      throw err;
    }

    const logDir = path.join(installDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, UPDATE_LOG);
    void this.runUpdater(installDir, `v${version}`, logFile).then((code) => {
      // Normally this server has been stopped by now and the new version started.
      // Still here means the update failed before swapping the app, leaving it as it was.
      const applying = this.applying;
      this.applying = null;
      if (code === 0 || !applying) return;
      let log = '';
      try {
        log = stripAnsi(fs.readFileSync(logFile, 'utf8')).trim().split('\n').slice(-30).join('\n');
      } catch {
        // No log to show.
      }
      this.failed = { version: applying.version, at: new Date().toISOString(), log };
      this.ctx.liveUpdates.publish({ area: 'updates', by: APP_NAME }, null);
    });
  }
}

/** Checks a minute after starting and then twice a day, unless UPDATE_CHECK is off. Returns a stop function. */
export function startUpdateChecker(ctx: AppContext): () => void {
  if (!ctx.config.updates.autoCheck) return () => {};
  const tick = async () => {
    const before = ctx.updates.status().available?.version;
    await ctx.updates.check();
    // Only open browsers' sidebar notice depends on it.
    if (ctx.updates.status().available?.version !== before) ctx.liveUpdates.publish({ area: 'updates', by: APP_NAME }, null);
  };
  const first = setTimeout(() => void tick(), 60_000);
  first.unref();
  const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

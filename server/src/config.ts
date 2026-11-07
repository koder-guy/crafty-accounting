import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HmrcEnvironment, InstallKind } from '@crafty/shared';

export interface Config {
  dataDir: string;
  /** Where automatic backups are written; ideally on a different disk. */
  backupDir: string;
  port: number;
  /** Address to listen on; all of them unless set (127.0.0.1 behind the quick install's Caddy). */
  host: string | undefined;
  /** Name and password for the first user, created when no users exist yet. */
  adminName: string;
  adminPassword: string | null;
  sessionSecret: string;
  maxUploadMb: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  clientDist: string | null;
  /** The app registered on HMRC's Developer Hub, for Making Tax Digital. */
  hmrc: {
    environment: HmrcEnvironment;
    clientId: string | null;
    clientSecret: string | null;
    /** Overrides the redirect URI worked out from the address the app is reached at. */
    redirectUri: string | null;
  };
  /** Sends Square's API calls here instead (SQUARE_API_URL), to try the import against a stand-in. For development only. */
  squareApiUrl: string | null;
  updates: {
    /** Check GitHub for new releases twice a day (UPDATE_CHECK); Check now works either way. */
    autoCheck: boolean;
    install: InstallKind;
    /** The install's folder: install.sh's ~/crafty-accounting, or CRAFTY_DIR from install-docker.sh's .env. */
    installDir: string | null;
  };
}

const truthy = (value: string | undefined) => value === 'true' || value === '1';

/** Reads settings from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const clientDist = path.resolve(env.CLIENT_DIST ?? path.join(process.cwd(), 'client', 'dist'));

  return {
    dataDir,
    backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
    port: Number(env.PORT ?? 3000),
    host: env.HOST?.trim() || undefined,
    adminName: env.ADMIN_NAME?.trim() || 'Admin',
    adminPassword: env.ADMIN_PASSWORD || null,
    sessionSecret: env.SESSION_SECRET || persistedSecret(dataDir),
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 20),
    cookieSecure: truthy(env.COOKIE_SECURE),
    trustProxy: truthy(env.TRUST_PROXY),
    clientDist: fs.existsSync(path.join(clientDist, 'index.html')) ? clientDist : null,
    hmrc: {
      environment: hmrcEnvironment(env.HMRC_ENV),
      clientId: env.HMRC_CLIENT_ID?.trim() || null,
      clientSecret: env.HMRC_CLIENT_SECRET?.trim() || null,
      redirectUri: env.HMRC_REDIRECT_URI?.trim() || null,
    },
    squareApiUrl: env.SQUARE_API_URL?.trim().replace(/\/$/, '') || null,
    updates: { autoCheck: !/^(false|0)$/i.test(env.UPDATE_CHECK?.trim() ?? ''), ...installKind(env) },
  };
}

/**
 * How this copy was installed. install.sh runs the app from <folder>/app, next to its
 * crafty script and its own Node; install-docker.sh's compose file sets CRAFTY_INSTALL.
 */
function installKind(env: NodeJS.ProcessEnv): { install: InstallKind; installDir: string | null } {
  if (env.CRAFTY_INSTALL === 'docker') return { install: 'docker', installDir: env.CRAFTY_DIR?.trim() || null };
  const dir = path.dirname(process.cwd());
  if (path.basename(process.cwd()) === 'app' && fs.existsSync(path.join(dir, 'crafty')) && fs.existsSync(path.join(dir, 'node', 'bin', 'node'))) {
    return { install: 'native', installDir: dir };
  }
  return { install: 'manual', installDir: null };
}

/** HMRC's test service unless HMRC_ENV says otherwise, so nothing reaches the live service by accident. */
function hmrcEnvironment(value: string | undefined): HmrcEnvironment {
  const env = value?.trim() || 'sandbox';
  if (env !== 'sandbox' && env !== 'production') throw new Error(`HMRC_ENV must be sandbox or production, not "${env}"`);
  return env;
}

/** Generates a session secret on first run so sessions survive restarts. */
function persistedSecret(dataDir: string): string {
  const file = path.join(dataDir, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

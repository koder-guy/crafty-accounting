import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Config {
  dataDir: string;
  /** Where automatic backups are written; ideally on a different disk. */
  backupDir: string;
  port: number;
  adminPassword: string;
  sessionSecret: string;
  maxUploadMb: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  clientDist: string | null;
}

const truthy = (value: string | undefined) => value === 'true' || value === '1';

/** Reads settings from the environment. Throws if ADMIN_PASSWORD is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD must be set (see .env.example)');
  }

  const clientDist = path.resolve(env.CLIENT_DIST ?? path.join(process.cwd(), 'client', 'dist'));

  return {
    dataDir,
    backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
    port: Number(env.PORT ?? 3000),
    adminPassword,
    sessionSecret: env.SESSION_SECRET || persistedSecret(dataDir),
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 20),
    cookieSecure: truthy(env.COOKIE_SECURE),
    trustProxy: truthy(env.TRUST_PROXY),
    clientDist: fs.existsSync(path.join(clientDist, 'index.html')) ? clientDist : null,
  };
}

/** Generates a session secret on first run so sessions survive restarts. */
function persistedSecret(dataDir: string): string {
  const file = path.join(dataDir, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

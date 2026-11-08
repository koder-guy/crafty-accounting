import { APP_NAME, APP_VERSION } from '@crafty/shared';
import { createApp } from './app';
import { startAutoBackupScheduler } from './autoBackup';
import { loadConfig } from './config';
import { createContext } from './context';
import { startNotificationChecks } from './notifications';
import { writeTlsFiles } from './tlsCertificate';
import { startUpdateChecker } from './updates';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);

// Caddy reads the HTTPS certificate from files, kept in step with the database.
try {
  writeTlsFiles(ctx);
} catch (err) {
  console.error((err as Error).message);
}

const stopScheduler = startAutoBackupScheduler(ctx);
const stopUpdateChecker = startUpdateChecker(ctx);
const stopNotificationChecks = startNotificationChecks(ctx);
// Carry on reading any scanned documents left waiting, or mid-read when the server stopped.
ctx.scans.resume();

const listening = () => {
  const where = config.host ? `${config.host}:${config.port}` : `port ${config.port}`;
  console.log(`${APP_NAME} v${APP_VERSION} listening on ${where} (data: ${config.dataDir})`);
  if (!config.clientDist) console.log('Client build not found; serving the API only.');
};
// Without a host, Node picks all addresses (IPv6 and IPv4 where it can).
const server = config.host ? app.listen(config.port, config.host, listening) : app.listen(config.port, listening);

const shutdown = () => {
  stopScheduler();
  stopUpdateChecker();
  stopNotificationChecks();
  ctx.liveUpdates.closeAll();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

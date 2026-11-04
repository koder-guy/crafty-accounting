import { APP_NAME, APP_VERSION } from '@crafty/shared';
import { createApp } from './app';
import { startAutoBackupScheduler } from './autoBackup';
import { loadConfig } from './config';
import { createContext } from './context';
import { startUpdateChecker } from './updates';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);

const stopScheduler = startAutoBackupScheduler(ctx);
const stopUpdateChecker = startUpdateChecker(ctx);

const server = app.listen(config.port, () => {
  console.log(`${APP_NAME} v${APP_VERSION} listening on port ${config.port} (data: ${config.dataDir})`);
  if (!config.clientDist) console.log('Client build not found; serving the API only.');
});

const shutdown = () => {
  stopScheduler();
  stopUpdateChecker();
  ctx.liveUpdates.closeAll();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

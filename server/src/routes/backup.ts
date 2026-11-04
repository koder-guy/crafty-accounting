import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { autoBackupSettingsSchema, type AutoBackupStatus } from '@crafty/shared';
import {
  backupDirWritable,
  diskSpace,
  getAutoBackupSettings,
  isAutoBackupName,
  lastAutoBackup,
  listAutoBackups,
  nextAutoBackup,
  runAutoBackup,
  sameDisk,
  saveAutoBackupSettings,
} from '../autoBackup';
import type { AppContext } from '../context';
import { getSetting, setSetting } from '../db';
import { dumpSql, extractZipBackup, resetToEmpty, restoreBackup, writeZipBackup } from '../backup';
import { decodeUploadName } from '../documents';
import { HttpError, parseWith } from '../http';

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

export function backupRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = multer({ dest: ctx.paths.tmpDir, limits: { fileSize: 4 * 1024 ** 3, files: 1 } });

  router.get('/backup.sql', (_req, res) => {
    res.attachment(`crafty-accounting-${stamp()}.sql`).type('application/sql').send(dumpSql(ctx.db));
  });

  router.get('/backup.zip', async (_req, res) => {
    res.attachment(`crafty-accounting-${stamp()}.zip`).type('application/zip');
    await writeZipBackup(ctx, res);
  });

  const restoreZip = async (zipFile: string) => {
    const { sql, uploadsDir } = await extractZipBackup(ctx, zipFile);
    try {
      restoreBackup(ctx, sql, uploadsDir);
    } finally {
      // Moved into place on success; left behind only if the restore failed.
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    }
  };

  router.post('/restore', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Choose a backup file to restore');
    try {
      const name = decodeUploadName(file.originalname).toLowerCase();
      if (name.endsWith('.zip')) {
        await restoreZip(file.path);
      } else if (name.endsWith('.sql')) {
        restoreBackup(ctx, fs.readFileSync(file.path, 'utf8'));
      } else {
        throw new HttpError(400, 'Choose a .sql or .zip backup file');
      }
      res.json({ restored: true });
    } finally {
      fs.rmSync(file.path, { force: true });
    }
  });

  // ---- Automatic backups ----

  const autoStatus = (): AutoBackupStatus => {
    const settings = getAutoBackupSettings(ctx.db);
    return {
      ...settings,
      folder: ctx.paths.backupDir,
      folderWritable: backupDirWritable(ctx.paths.backupDir),
      nextRunAt: nextAutoBackup(settings, new Date(), getSetting(ctx.db, 'auto_backup_last_run_date')),
      lastRun: lastAutoBackup(ctx.db),
      backups: listAutoBackups(ctx.paths.backupDir),
      storage: {
        data: diskSpace(ctx.config.dataDir),
        backups: diskSpace(ctx.paths.backupDir),
        sameDisk: sameDisk(ctx.config.dataDir, ctx.paths.backupDir),
      },
    };
  };

  router.get('/backup/auto', (_req, res) => {
    res.json(autoStatus());
  });

  router.put('/backup/auto', (req, res) => {
    saveAutoBackupSettings(ctx.db, parseWith(autoBackupSettingsSchema, req.body));
    res.json(autoStatus());
  });

  router.post('/backup/auto/run', async (_req, res) => {
    const result = await runAutoBackup(ctx, { force: true });
    if (result.status === 'failed') throw new HttpError(500, `The backup failed: ${result.error}`);
    res.json(autoStatus());
  });

  const autoBackupFile = (name: string) => {
    const file = path.join(ctx.paths.backupDir, name);
    if (!isAutoBackupName(name) || !fs.existsSync(file)) throw new HttpError(404, 'Backup not found');
    return file;
  };

  router.get('/backup/auto/files/:name', (req, res) => {
    res.download(autoBackupFile(req.params.name), req.params.name);
  });

  // Restores a saved automatic backup in place, without downloading and uploading it.
  router.post('/backup/auto/files/:name/restore', async (req, res) => {
    await restoreZip(autoBackupFile(req.params.name));
    res.json({ restored: true });
  });

  router.delete('/backup/auto/files/:name', (req, res) => {
    const newest = listAutoBackups(ctx.paths.backupDir)[0]?.name;
    fs.rmSync(autoBackupFile(req.params.name));
    // Without the newest backup, the next daily run mustn't be skipped as "nothing changed".
    if (req.params.name === newest) setSetting(ctx.db, 'auto_backup_fingerprint', null);
    res.json(autoStatus());
  });

  router.post('/reset', (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== 'RESET') {
      throw new HttpError(400, 'Type RESET to confirm');
    }
    resetToEmpty(ctx);
    res.json({ reset: true });
  });

  return router;
}

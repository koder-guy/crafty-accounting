import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { autoBackupSettingsSchema, type AutoBackupStatus } from '@crafty/shared';
import {
  backupDirWritable,
  getAutoBackupSettings,
  isAutoBackupName,
  lastAutoBackup,
  listAutoBackups,
  nextAutoBackup,
  runAutoBackup,
  saveAutoBackupSettings,
} from '../autoBackup';
import type { AppContext } from '../context';
import { getSetting } from '../db';
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

  router.post('/restore', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Choose a backup file to restore');
    let extractedUploads: string | undefined;
    try {
      const name = decodeUploadName(file.originalname).toLowerCase();
      if (name.endsWith('.zip')) {
        const { sql, uploadsDir } = await extractZipBackup(ctx, file.path);
        extractedUploads = uploadsDir;
        restoreBackup(ctx, sql, uploadsDir);
        extractedUploads = undefined;
      } else if (name.endsWith('.sql')) {
        restoreBackup(ctx, fs.readFileSync(file.path, 'utf8'));
      } else {
        throw new HttpError(400, 'Choose a .sql or .zip backup file');
      }
      res.json({ restored: true });
    } finally {
      fs.rmSync(file.path, { force: true });
      if (extractedUploads) fs.rmSync(extractedUploads, { recursive: true, force: true });
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

  router.get('/backup/auto/files/:name', (req, res) => {
    const name = req.params.name;
    const file = path.join(ctx.paths.backupDir, name);
    if (!isAutoBackupName(name) || !fs.existsSync(file)) throw new HttpError(404, 'Backup not found');
    res.download(file, name);
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

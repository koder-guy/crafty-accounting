import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import type { AppContext } from '../context';
import { dumpSql, extractZipBackup, resetToEmpty, restoreBackup, writeZipBackup } from '../backup';
import { decodeUploadName } from '../documents';
import { HttpError } from '../http';

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

  router.post('/reset', (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== 'RESET') {
      throw new HttpError(400, 'Type RESET to confirm');
    }
    resetToEmpty(ctx);
    res.json({ reset: true });
  });

  return router;
}

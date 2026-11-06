// Documents scanned in bulk, waiting to be checked (Expenses → Scan documents). The list stays
// available without a Claude key, so what's there can still be checked; adding and retrying need one.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import type { ScanList } from '@crafty/shared';
import type { AppContext } from '../context';
import { getClaudeSettings } from '../claudeSettings';
import { ALLOWED_EXTENSIONS, createUploader, decodeUploadName, documentPath, ensureSpaceFor, uploadSpace } from '../documents';
import { HttpError, parseId } from '../http';
import { addScan, deleteScan, fillFingerprints, getScan, getScanRow, listScans, unreadableReason } from '../scans';

export function scansRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = createUploader(ctx);
  const needsKey: RequestHandler = (_req, _res, next) => (getClaudeSettings(ctx.db).apiKey ? next() : next(new HttpError(404, 'Not found')));

  router.get('/', (_req, res) => {
    // Picks up anything left waiting, e.g. after a key was saved again.
    ctx.scans.kick();
    fillFingerprints(ctx);
    const list: ScanList = {
      scans: listScans(ctx.db),
      claudeConfigured: getClaudeSettings(ctx.db).apiKey !== null,
      maxUploadBytes: ctx.config.maxUploadMb * 1024 * 1024,
      space: uploadSpace(ctx),
    };
    res.json(list);
  });

  router.get('/:id', (req, res) => {
    const scan = getScan(ctx.db, parseId(req.params.id));
    if (!scan) throw new HttpError(404, 'That document has already been saved or discarded');
    res.json(scan);
  });

  router.get('/:id/file', (req, res) => {
    const row = getScanRow(ctx.db, parseId(req.params.id));
    if (!row) throw new HttpError(404, 'That document has already been saved or discarded');
    const file = documentPath(ctx, row.filename);
    if (!fs.existsSync(file)) throw new HttpError(404, 'The file is missing from storage');
    res.setHeader('Content-Type', ALLOWED_EXTENSIONS[path.extname(row.filename)] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    fs.createReadStream(file).pipe(res);
  });

  // One file per request, so the page can show progress and carry on past a file that fails.
  router.post('/', needsKey, upload.single('document'), (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Choose a document to scan');
    // The upload is already in the temporary folder on the same disk; moving it in takes no more room.
    ensureSpaceFor(ctx, 0);
    const scan = addScan(ctx, { path: file.path, originalName: decodeUploadName(file.originalname), size: file.size }, req.user!.name);
    ctx.scans.kick();
    res.status(201).json(scan);
  });

  router.post('/:id/retry', needsKey, (req, res) => {
    const row = getScanRow(ctx.db, parseId(req.params.id));
    if (!row) throw new HttpError(404, 'That document has already been saved or discarded');
    if (row.status !== 'failed') throw new HttpError(409, 'Only a document that couldn\'t be read can be read again');
    const problem = unreadableReason(row.original_name, row.size_bytes);
    if (problem) throw new HttpError(422, problem);
    ctx.db.prepare("UPDATE scans SET status = 'waiting', error = NULL WHERE id = ?").run(row.id);
    ctx.scans.kick();
    res.json(getScan(ctx.db, row.id));
  });

  router.delete('/:id', (req, res) => {
    deleteScan(ctx, parseId(req.params.id));
    res.status(204).end();
  });

  return router;
}

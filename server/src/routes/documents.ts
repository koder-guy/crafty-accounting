import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context';
import { ALLOWED_EXTENSIONS, documentNameProblem, documentPath } from '../documents';
import { HttpError } from '../http';
import { isDocumentNameInUse } from '../repo';

export function documentsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/:filename', (req, res) => {
    const name = req.params.filename;
    // Only serve files that a transaction actually references.
    if (documentNameProblem(name) || !isDocumentNameInUse(ctx.db, name)) throw new HttpError(404, 'Document not found');
    const file = documentPath(ctx, name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'The document file is missing from storage');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', ALLOWED_EXTENSIONS[path.extname(name).toLowerCase()]);
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
    fs.createReadStream(file).pipe(res);
  });

  return router;
}

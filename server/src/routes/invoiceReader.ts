// Reading an invoice with Claude to fill in a new expense. 404 until a key is saved in Settings → Claude Integration.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { CASH_BASIS_UNUSED_CODE } from '@crafty/shared';
import type { AppContext } from '../context';
import { getClaudeSettings } from '../claudeSettings';
import { createUploader, decodeUploadName } from '../documents';
import { HttpError } from '../http';
import { MAX_INVOICE_IMAGE_BYTES, type InvoiceMediaType } from '../invoiceReader';
import { listCategories } from '../repo';

const READABLE: Record<string, InvoiceMediaType> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function invoiceReaderRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = createUploader(ctx);

  router.post('/read', (_req, _res, next) => (getClaudeSettings(ctx.db).apiKey ? next() : next(new HttpError(404, 'Not found'))), upload.single('document'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Choose an invoice to read');
    const mediaType = READABLE[path.extname(decodeUploadName(file.originalname)).toLowerCase()];
    if (!mediaType) throw new HttpError(422, 'Claude can read PDF, JPG, PNG and WebP files. Save a HEIC photo as JPG first.');
    if (mediaType !== 'application/pdf' && file.size > MAX_INVOICE_IMAGE_BYTES) {
      throw new HttpError(413, 'That image is too large for Claude to read (the most is 5 MB).');
    }
    // Depreciation isn't offered for new lines (cash basis).
    const categories = listCategories(ctx.db)
      .filter((c) => c.type === 'EXPENSE' && c.hmrcCode !== CASH_BASIS_UNUSED_CODE)
      .map(({ id, name, hmrcCode }) => ({ id, name, hmrcCode }));
    const data = await fs.promises.readFile(file.path);
    // Read again: the key may have been removed while the file was arriving.
    const { apiKey, model } = getClaudeSettings(ctx.db);
    if (!apiKey) throw new HttpError(404, 'Not found');
    res.json(await ctx.claude.readInvoice(apiKey, model, { data, mediaType, categories }));
  });

  return router;
}

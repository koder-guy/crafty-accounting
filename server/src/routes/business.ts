// Settings → Business Details, and the first screen of a new install: who the business is, and its logo.
import { Router } from 'express';
import multer from 'multer';
import { businessSaveSchema, logoTypeOf, MAX_LOGO_BYTES } from '@crafty/shared';
import { getBusiness, getBusinessLogo, saveBusiness } from '../businessDetails';
import type { AppContext } from '../context';
import { ensureSpaceFor } from '../documents';
import { HttpError, parseWith, readPayload } from '../http';
import { nextTimestamp } from '../repo';

export function businessRouter(ctx: AppContext): Router {
  const router = Router();
  // Logos are small (the browser shrinks them first), so they're kept in memory and go straight into the database.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1 } });

  router.get('/', (_req, res) => {
    res.json(getBusiness(ctx.db));
  });

  // The details as JSON, or multipart with them in "data" and a new logo in "logo".
  router.put('/', upload.single('logo'), (req, res) => {
    const input = parseWith(businessSaveSchema, readPayload(req));
    const current = getBusiness(ctx.db);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
      throw new HttpError(
        409,
        `${current.updatedBy ?? 'Someone else'} changed the business details while you were editing them, so yours weren't saved. Load their version, then make yours again.`,
      );
    }
    let logo: { data: Buffer; type: 'image/png' | 'image/jpeg' } | null | undefined;
    if (req.file) {
      const type = logoTypeOf(req.file.buffer);
      if (!type) throw new HttpError(400, 'The logo must be a PNG or JPEG image');
      ensureSpaceFor(ctx, req.file.size);
      logo = { data: req.file.buffer, type };
    } else if (input.removeLogo) {
      logo = null;
    }
    saveBusiness(ctx.db, input.details, { by: req.user!.name, logo, updatedAt: nextTimestamp(current.updatedAt) });
    res.json(getBusiness(ctx.db));
  });

  router.get('/logo', (req, res) => {
    const logo = getBusinessLogo(ctx.db);
    if (!logo) throw new HttpError(404, 'There is no logo');
    // Its address changes with every save, so it can be kept; without the version it's checked each time.
    res.setHeader('Cache-Control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    res.type(logo.type).send(logo.data);
  });

  return router;
}

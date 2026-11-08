// Settings → HTTPS Certificate: upload a .pfx/.p12 file (with its password, used once and not
// kept), see what's saved, or remove it to go back to Caddy's own certificate.
import { Router } from 'express';
import multer from 'multer';
import { MAX_PFX_BYTES, type TlsChangeResult } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError } from '../http';
import { checkCertificateExpiry } from '../notifications';
import { readPfx, removeCertificate, restartCaddyAfter, saveCertificate, tlsStatus } from '../tlsCertificate';

export function tlsRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PFX_BYTES, files: 1, fields: 2 } });

  const unavailable = () =>
    new HttpError(409, "This install doesn't serve HTTPS through Caddy, so there's nowhere to use a certificate.");

  router.get('/', (_req, res) => {
    res.json(tlsStatus(ctx));
  });

  router.put('/', upload.single('certificate'), (req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    if (!req.file) throw new HttpError(400, 'Choose a .pfx or .p12 file.');
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const pem = readPfx(req.file.buffer, password);
    saveCertificate(ctx, pem, req.user!.name, req.file.originalname || null);
    checkCertificateExpiry(ctx);
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: !ctx.config.tls.disabled && restartCaddyAfter(ctx, res) };
    res.json(result);
  });

  router.delete('/', (_req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    removeCertificate(ctx);
    checkCertificateExpiry(ctx);
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: !ctx.config.tls.disabled && restartCaddyAfter(ctx, res) };
    res.json(result);
  });

  return router;
}

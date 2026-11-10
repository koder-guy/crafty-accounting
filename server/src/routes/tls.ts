// Settings → HTTPS Certificate: upload a .pfx/.p12 file (with its password, used once and not
// kept), see what's saved, or remove it to go back to Caddy's own certificate; and set up a domain
// on Cloudflare that Caddy gets a Let's Encrypt certificate for.
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { MAX_PFX_BYTES, type TlsChangeResult } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { checkCertificateExpiry } from '../notifications';
import { readPfx, removeCertificate, restartCaddyAfter, saveCertificate, tlsStatus, writeTlsFiles } from '../tlsCertificate';
import { probeDomain, removeDomain, restoreDomain, saveDomain, savedDomainRow } from '../tlsDomain';

const domainSchema = z.object({
  domain: z.string().max(253),
  token: z.string().max(200).optional(),
  pointAt: z.string().max(45).nullable(),
});

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

  router.get('/domain/certificate', async (_req, res) => {
    res.json(await probeDomain(ctx));
  });

  router.put('/domain', async (req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    const before = savedDomainRow(ctx.db);
    const warning = await saveDomain(ctx, parseWith(domainSchema, req.body), req.user!.name);
    try {
      writeTlsFiles(ctx);
    } catch (err) {
      restoreDomain(ctx.db, before);
      throw err;
    }
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: restartCaddyAfter(ctx, res), warning };
    res.json(result);
  });

  router.delete('/domain', async (_req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    const warning = await removeDomain(ctx);
    writeTlsFiles(ctx);
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: restartCaddyAfter(ctx, res), warning };
    res.json(result);
  });

  return router;
}

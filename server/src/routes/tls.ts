// Settings → HTTPS Certificate: choose how the app is served (Caddy's own certificate, a domain on
// Cloudflare that Caddy gets a Let's Encrypt certificate for, or an uploaded one); upload a
// .pfx/.p12 file (with its password, used once and not kept); set up the domain. Each method's
// settings stay saved while another is in use; saving one's settings starts using it.
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { isDomainName, MAX_PFX_BYTES, MAX_TLS_ADDRESSES, TLS_METHODS, type TlsChangeResult } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseWith } from '../http';
import { checkCertificateExpiry } from '../notifications';
import { changeTls, cleanAddress, readPfx, setAddresses, siteHost, removeCertificate, restartCaddyAfter, saveCertificate, savedCertificatePem, setTlsMethod, tlsMethod, tlsStatus } from '../tlsCertificate';
import { checkDomain, probeDomain, removeDomain, savedDomainRow, storeDomain } from '../tlsDomain';

const methodSchema = z.object({ method: z.enum(TLS_METHODS) });
const addressesSchema = z.object({ addresses: z.array(z.string().max(253)).max(MAX_TLS_ADDRESSES) });

const domainSchema = z.object({
  domain: z.string().max(253),
  token: z.string().max(200).optional(),
});

export function tlsRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PFX_BYTES, files: 1, fields: 2 } });

  const unavailable = () =>
    new HttpError(409, "This install doesn't serve HTTPS itself, so there's nowhere to use a certificate.");

  router.get('/', (_req, res) => {
    res.json(tlsStatus(ctx));
  });

  // Switches to a method whose settings are saved (Caddy's own needs none).
  // The addresses added in the app, beside SITE_ADDRESS: the whole list, replacing the one saved.
  router.put('/addresses', (req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    const install = new Set(ctx.config.tls.siteAddresses.map(siteHost));
    const names: string[] = [];
    for (const entry of parseWith(addressesSchema, req.body).addresses) {
      const name = cleanAddress(entry);
      if (!name || names.includes(name)) continue;
      if (!isDomainName(name)) {
        throw new HttpError(400, `"${entry}" isn't a name the app can be served at, such as books.example.co.uk or crafty.local. IP addresses go in SITE_ADDRESS.`);
      }
      if (install.has(name)) throw new HttpError(400, `${name} is served already, from the install's settings.`);
      names.push(name);
    }
    changeTls(ctx, () => setAddresses(ctx.db, names, req.user!.name));
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: restartCaddyAfter(ctx, res) };
    res.json(result);
  });

  router.put('/method', (req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    const { method } = parseWith(methodSchema, req.body);
    if (method === 'cloudflare' && !savedDomainRow(ctx.db)) throw new HttpError(400, 'Set up the domain first.');
    if (method === 'custom' && !savedCertificatePem(ctx.db)) throw new HttpError(400, 'Upload a certificate first.');
    const before = tlsMethod(ctx.db);
    changeTls(ctx, () => setTlsMethod(ctx.db, method));
    checkCertificateExpiry(ctx);
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: before !== method && restartCaddyAfter(ctx, res) };
    res.json(result);
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
    const wasInUse = tlsMethod(ctx.db) === 'custom';
    removeCertificate(ctx);
    checkCertificateExpiry(ctx);
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: wasInUse && !ctx.config.tls.disabled && restartCaddyAfter(ctx, res) };
    res.json(result);
  });

  // The uploaded certificate and its intermediates (what Caddy sends every browser anyway), to
  // install on devices when it's self-signed. Caddy's own authority is at /crafty-root.crt.
  router.get('/certificate.crt', (_req, res) => {
    const pem = savedCertificatePem(ctx.db);
    if (!pem) throw new HttpError(404, 'No certificate has been uploaded.');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="crafty-certificate.crt"');
    res.send(pem);
  });

  router.get('/domain/certificate', async (_req, res) => {
    res.json(tlsMethod(ctx.db) === 'cloudflare' ? await probeDomain(ctx) : { state: 'none' });
  });

  router.put('/domain', async (req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    const checked = await checkDomain(ctx, parseWith(domainSchema, req.body));
    changeTls(ctx, () => {
      storeDomain(ctx.db, checked, req.user!.name);
      setTlsMethod(ctx.db, 'cloudflare');
    });
    checkCertificateExpiry(ctx);
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: restartCaddyAfter(ctx, res) };
    res.json(result);
  });

  router.delete('/domain', (_req, res) => {
    if (!ctx.config.tls.dir) throw unavailable();
    const wasInUse = tlsMethod(ctx.db) === 'cloudflare';
    changeTls(ctx, () => removeDomain(ctx.db));
    const result: TlsChangeResult = { ...tlsStatus(ctx), restarting: wasInUse && restartCaddyAfter(ctx, res) };
    res.json(result);
  });

  return router;
}

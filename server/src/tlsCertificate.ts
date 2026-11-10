// Settings → HTTPS Certificate: a certificate of the owner's own, uploaded as a .pfx/.p12 file.
// The file is opened here (node-forge: Node can use a PFX but not take it apart), checked, and
// kept as PEM in tls_certificate; the password isn't kept. Caddy can't read the database, so the
// app writes cert.pem and key.pem to a folder it reads (config.tls.dir) on starting and after each
// change, and Caddy is restarted to pick them up: by the app on the quick install, by hand on Docker.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import forge from 'node-forge';
import type { TlsCertificateInfo, TlsStatus } from '@crafty/shared';
import type { AppContext } from './context';
import type { Db } from './db';
import { HttpError } from './http';
import { DOMAIN_FILE, domainCaddyfile, savedDomain, savedDomainRow } from './tlsDomain';

export const CERT_FILE = 'cert.pem';
export const KEY_FILE = 'key.pem';

export interface TlsPem {
  /** The certificate, then its intermediates. */
  certPem: string;
  keyPem: string;
}

interface Row {
  cert_pem: string;
  key_pem: string;
  file_name: string | null;
  added_by: string;
  added_at: string;
}

const der = (value: forge.asn1.Asn1) => Buffer.from(forge.asn1.toDer(value).getBytes(), 'binary');

/** Takes a .pfx/.p12 file apart: its one private key, the certificate for it, and that certificate's intermediates. */
export function readPfx(file: Buffer, password: string): TlsPem {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(file.toString('binary'))), false, password);
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/MAC could not be verified|wrong password|Invalid password/i.test(message)) {
      throw new HttpError(400, password ? "That password doesn't open this file." : 'This file needs its password.');
    }
    throw new HttpError(400, "This isn't a .pfx or .p12 file that can be read. Export the certificate again, including its private key.");
  }

  const keys: crypto.KeyObject[] = [];
  const certs: crypto.X509Certificate[] = [];
  for (const contents of p12.safeContents) {
    for (const bag of contents.safeBags) {
      try {
        if (bag.type === forge.pki.oids.certBag) {
          // forge only understands RSA certificates; others come back as ASN.1, which Node reads.
          const asn1 = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1;
          if (asn1) certs.push(new crypto.X509Certificate(der(asn1)));
        } else if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag) {
          const asn1 = bag.key ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key)) : bag.asn1;
          if (asn1) keys.push(crypto.createPrivateKey({ key: der(asn1), format: 'der', type: 'pkcs8' }));
        }
      } catch {
        throw new HttpError(400, "Something in this file couldn't be read. Export the certificate again, including its private key.");
      }
    }
  }
  if (!keys.length) throw new HttpError(400, 'This file has no private key. Export the certificate again, including its private key.');
  if (keys.length > 1) throw new HttpError(400, 'This file has more than one private key. Export just the one certificate, with its key.');
  const key = keys[0];
  const leaf = certs.find((c) => c.checkPrivateKey(key));
  if (!leaf) throw new HttpError(400, "None of the certificates in this file is for its private key.");

  const now = Date.now();
  if (new Date(leaf.validTo).getTime() <= now) throw new HttpError(400, `This certificate expired on ${displayDate(leaf.validTo)}.`);
  if (new Date(leaf.validFrom).getTime() > now) throw new HttpError(400, `This certificate isn't valid until ${displayDate(leaf.validFrom)}.`);

  // The intermediates, in order up from the certificate. Roots (issued by themselves) are left
  // out, as browsers have their own; anything else in the file is ignored.
  const chain = [leaf];
  const others = certs.filter((c) => c !== leaf && !selfIssued(c));
  for (let next = issuerOf(chain[chain.length - 1], others); next && !chain.includes(next); next = issuerOf(chain[chain.length - 1], others)) {
    chain.push(next);
  }

  const certPem = chain.map((c) => c.toString().trim()).join('\n') + '\n';
  const keyPem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  // The same check a TLS server makes: if Node takes the pair, so will Caddy.
  try {
    tls.createSecureContext({ cert: certPem, key: keyPem });
  } catch (err) {
    throw new HttpError(400, `This certificate can't be used for HTTPS: ${(err as Error).message}`);
  }
  return { certPem, keyPem };
}

const selfIssued = (c: crypto.X509Certificate) => c.subject === c.issuer && c.checkIssued(c);
const issuerOf = (c: crypto.X509Certificate, among: crypto.X509Certificate[]) => among.find((o) => c.checkIssued(o) && c.verify(o.publicKey));
const displayDate = (date: string) => new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

/** The host part of a SITE_ADDRESS entry: "https://crafty.local:8443" → "crafty.local". */
export function siteHost(address: string): string {
  let host = address.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  // One colon is a port; more is an IPv6 address.
  if ((host.match(/:/g) ?? []).length === 1) host = host.slice(0, host.indexOf(':'));
  return host.toLowerCase();
}

/** Addresses the certificate isn't for. */
export function uncoveredAddresses(cert: crypto.X509Certificate, addresses: string[]): string[] {
  return addresses.filter((address) => {
    const host = siteHost(address);
    if (!host) return false;
    return net.isIP(host) ? !cert.checkIP(host) : !cert.checkHost(host);
  });
}

function names(cert: crypto.X509Certificate): string[] {
  const alt = cert.subjectAltName
    ?.split(/,\s*/)
    .map((entry) => entry.replace(/^(DNS|IP Address):/, '').replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (alt?.length) return alt;
  const cn = /^CN=(.*)$/m.exec(cert.subject)?.[1];
  return cn ? [cn] : [];
}

function keyType(cert: crypto.X509Certificate): string {
  const key = cert.publicKey;
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === 'rsa' || key.asymmetricKeyType === 'rsa-pss') return `RSA ${details.modulusLength ?? ''}`.trim();
  if (key.asymmetricKeyType === 'ec') {
    const curve = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' }[details.namedCurve ?? ''] ?? details.namedCurve;
    return `EC ${curve ?? ''}`.trim();
  }
  return (key.asymmetricKeyType ?? 'unknown').toUpperCase();
}

/** What the page shows about a certificate; never the key. */
export function describeCertificate(certPem: string, siteAddresses: string[]): Omit<TlsCertificateInfo, 'fileName' | 'addedBy' | 'addedAt'> {
  const all = splitPem(certPem).map((pem) => new crypto.X509Certificate(pem));
  const leaf = all[0];
  return {
    subject: leaf.subject,
    issuer: leaf.issuer,
    names: names(leaf),
    validFrom: new Date(leaf.validFrom).toISOString(),
    validTo: new Date(leaf.validTo).toISOString(),
    fingerprint: leaf.fingerprint256,
    selfSigned: selfIssued(leaf),
    intermediates: all.length - 1,
    keyType: keyType(leaf),
    uncovered: uncoveredAddresses(leaf, siteAddresses),
  };
}

const splitPem = (pem: string) => pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];

const savedRow = (db: Db) =>
  db.prepare('SELECT cert_pem, key_pem, file_name, added_by, added_at FROM tls_certificate WHERE id = 1').get() as Row | undefined;

export function savedCertificate(ctx: AppContext): TlsCertificateInfo | null {
  const row = savedRow(ctx.db);
  if (!row) return null;
  return { ...describeCertificate(row.cert_pem, ctx.config.tls.siteAddresses), fileName: row.file_name, addedBy: row.added_by, addedAt: row.added_at };
}

export function tlsStatus(ctx: AppContext): TlsStatus {
  const { setup, restartCommand, disabled, serverIp } = ctx.config.tls;
  return { setup, restartCommand, disabled, certificate: savedCertificate(ctx), domain: savedDomain(ctx), serverIp };
}

/** Saves a certificate (replacing any before) and writes it out for Caddy; on failure, the one before stays. */
export function saveCertificate(ctx: AppContext, pem: TlsPem, by: string, fileName: string | null): void {
  const before = savedRow(ctx.db);
  ctx.db
    .prepare(
      `INSERT INTO tls_certificate (id, cert_pem, key_pem, file_name, added_by) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET cert_pem = excluded.cert_pem, key_pem = excluded.key_pem, file_name = excluded.file_name,
         added_by = excluded.added_by, added_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(pem.certPem, pem.keyPem, fileName, by);
  try {
    writeTlsFiles(ctx);
  } catch (err) {
    ctx.db.prepare('DELETE FROM tls_certificate').run();
    if (before) {
      ctx.db
        .prepare('INSERT INTO tls_certificate (id, cert_pem, key_pem, file_name, added_by, added_at) VALUES (1, ?, ?, ?, ?, ?)')
        .run(before.cert_pem, before.key_pem, before.file_name, before.added_by, before.added_at);
    }
    throw err;
  }
}

export function removeCertificate(ctx: AppContext): void {
  ctx.db.prepare('DELETE FROM tls_certificate').run();
  writeTlsFiles(ctx);
}

/**
 * Brings Caddy's folder in step with the database: the saved certificate's files and the
 * Cloudflare domain's site block (which holds its API token), or none. Each file is written
 * beside the old one and moved into place, so Caddy never reads half of one.
 */
export function writeTlsFiles(ctx: AppContext): void {
  const dir = ctx.config.tls.dir;
  if (!dir) return;
  const row = savedRow(ctx.db);
  const domain = savedDomainRow(ctx.db);
  const files: [string, string | null][] = [
    [CERT_FILE, row?.cert_pem ?? null],
    [KEY_FILE, row?.key_pem ?? null],
    [DOMAIN_FILE, domain ? domainCaddyfile(ctx, domain) : null],
  ];
  try {
    if (files.some(([, content]) => content !== null)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, content] of files) {
      const file = path.join(dir, name);
      if (content === null) {
        fs.rmSync(file, { force: true });
        continue;
      }
      fs.writeFileSync(`${file}.new`, content, { mode: 0o600 });
      fs.renameSync(`${file}.new`, file);
    }
  } catch (err) {
    throw new HttpError(500, `The HTTPS settings couldn't be written to ${dir} for Caddy: ${(err as Error).message}`);
  }
}

/** Restarts Caddy so it serves the files now in its folder. Tests replace it. */
export type CaddyRestarter = (ctx: AppContext) => Promise<void>;

/** The quick install's crafty script restarts the Caddy service (the account can't use systemctl, so it stops it and systemd starts it again). */
export const restartCaddyService: CaddyRestarter = (ctx) =>
  new Promise((resolve, reject) => {
    const installDir = ctx.config.updates.installDir;
    if (!installDir) return reject(new Error('no install folder'));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(path.join(installDir, 'crafty'), ['restart-caddy'], { cwd: installDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(output.trim() || `exit code ${code}`))));
  });

/**
 * After the answer has gone back (through Caddy, which is about to stop), restarts Caddy on an
 * install where the app can. Returns whether it will.
 */
export function restartCaddyAfter(ctx: AppContext, res: { on(event: 'finish', listener: () => void): unknown }): boolean {
  if (ctx.config.tls.setup !== 'restarts-itself') return false;
  res.on('finish', () => {
    setTimeout(() => {
      ctx.restartCaddy(ctx).catch((err: Error) => console.error(`Restarting Caddy with the HTTPS certificate failed: ${err.message}`));
    }, 300).unref();
  });
  return true;
}

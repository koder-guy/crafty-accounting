// Settings → HTTPS Certificate: a domain whose DNS is on Cloudflare, for which Caddy gets a Let's
// Encrypt certificate by the DNS challenge, so nothing has to be reachable from the internet.
// The app checks the API token with Cloudflare, can point the domain at this server (a DNS-only
// A or AAAA record it made, removed again with the domain), and keeps both in tls_domain. Caddy
// can't read the database, so writeTlsFiles writes a site block for the domain (DOMAIN_FILE) to
// the folder the Caddyfile imports *.caddy from. Calls go through ctx.fetch, which tests replace.
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { apiKeyHint, isCloudflareToken, isDomainName, type TlsDomainCertificate, type TlsDomainInfo, type TlsDomainRequest } from '@crafty/shared';
import type { AppContext } from './context';
import type { Db } from './db';
import { HttpError } from './http';

export const DOMAIN_FILE = 'domain.caddy';
const API = 'https://api.cloudflare.com/client/v4';

interface Row {
  domain: string;
  zone_id: string;
  zone_name: string;
  api_token: string;
  dns_record_id: string | null;
  pointed_at: string | null;
  added_by: string;
  added_at: string;
}

export const savedDomainRow = (db: Db) => db.prepare('SELECT * FROM tls_domain WHERE id = 1').get() as Row | undefined;

export function savedDomain(ctx: AppContext): TlsDomainInfo | null {
  const row = savedDomainRow(ctx.db);
  if (!row) return null;
  return {
    domain: row.domain,
    zone: row.zone_name,
    tokenHint: apiKeyHint(row.api_token),
    pointedAt: row.pointed_at,
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

interface CloudflareReply<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function callCloudflare<T>(ctx: AppContext, token: string, method: string, path: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await ctx.fetch(`${ctx.config.cloudflareApiUrl ?? API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Cloudflare. Check the server is online.");
  }
  const reply = (await res.json().catch(() => null)) as CloudflareReply<T> | null;
  if (res.ok && reply?.success !== false && reply) return reply.result as T;
  const message = reply?.errors?.map((e) => e.message).filter(Boolean).join('; ');
  // Never 401 to the browser, which would sign the person out.
  if (res.status === 401 || reply?.errors?.some((e) => e.code === 1000 || e.code === 6003 || e.code === 6111)) {
    throw new HttpError(422, "Cloudflare didn't accept the API token. Check you copied all of it.");
  }
  if (res.status === 403) {
    throw new HttpError(422, `The API token isn't allowed to do that. It needs Zone → Zone → Read and Zone → DNS → Edit for the domain's zone.${message ? ` (${message})` : ''}`);
  }
  if (res.status === 429) throw new HttpError(503, 'Cloudflare is busy. Try again in a minute.');
  throw new HttpError(502, `Cloudflare gave an error${message ? `: ${message}` : ` (${res.status})`}.`);
}

interface Zone {
  id: string;
  name: string;
}

/** The zone the token can see that the domain is in: the domain itself, or the nearest name above it. */
async function findZone(ctx: AppContext, token: string, domain: string): Promise<Zone> {
  for (let name = domain; name.includes('.'); name = name.slice(name.indexOf('.') + 1)) {
    const zones = await callCloudflare<Zone[]>(ctx, token, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    if (zones?.length) return zones[0];
  }
  throw new HttpError(
    422,
    `The API token can't see a Cloudflare zone for ${domain}. Check the domain's DNS is on this Cloudflare account, and that the token has Zone → Zone → Read for it.`,
  );
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

/**
 * Points the domain at `ip` with a DNS-only record, unless it already does. Returns the id of the
 * record if it's one made here (`ours`, the one made before, is changed rather than made again; null
 * when the person's own record already points there), and refuses to change one pointing elsewhere.
 */
async function pointDomain(ctx: AppContext, token: string, zone: Zone, domain: string, ip: string, ours: string | null): Promise<string | null> {
  const type = net.isIPv6(ip) ? 'AAAA' : 'A';
  const records = await callCloudflare<DnsRecord[]>(ctx, token, 'GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(domain)}`);
  const existing = (records ?? []).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
  const same = existing.find((r) => r.type === type && r.content === ip);
  if (same?.proxied) {
    throw new HttpError(
      409,
      `${domain} is proxied by Cloudflare (the orange cloud), which can't reach a server on your network. Set it to DNS only in Cloudflare and try again.`,
    );
  }
  if (same) return same.id === ours ? ours : null;
  const mine = existing.find((r) => r.id === ours);
  if (mine && existing.length === 1) {
    await callCloudflare(ctx, token, 'PATCH', `/zones/${zone.id}/dns_records/${mine.id}`, { type, content: ip, proxied: false });
    return mine.id;
  }
  if (existing.length) {
    throw new HttpError(
      409,
      `${domain} already points at ${existing.map((r) => r.content).join(' and ')} in Cloudflare. Change it there, or untick pointing it at this server to leave it as it is.`,
    );
  }
  const made = await callCloudflare<DnsRecord>(ctx, token, 'POST', `/zones/${zone.id}/dns_records`, {
    type,
    name: domain,
    content: ip,
    ttl: 1,
    proxied: false,
    comment: 'Crafty Accounting (Settings → HTTPS Certificate)',
  });
  return made.id;
}

/** Removes a record made here; a failure only matters as a warning, as the domain goes either way. */
async function removeRecord(ctx: AppContext, row: Row): Promise<string | null> {
  if (!row.dns_record_id) return null;
  try {
    await callCloudflare(ctx, row.api_token, 'DELETE', `/zones/${row.zone_id}/dns_records/${row.dns_record_id}`);
    return null;
  } catch (err) {
    return `The DNS record for ${row.domain} couldn't be removed from Cloudflare (${(err as Error).message}). Remove it there if it's no longer wanted.`;
  }
}

/** Checks the request with Cloudflare, points the domain at this server if asked, and saves it. Returns any warning. */
export async function saveDomain(ctx: AppContext, request: TlsDomainRequest, by: string): Promise<string | null> {
  const domain = request.domain.trim().toLowerCase().replace(/\.$/, '');
  if (!isDomainName(domain)) throw new HttpError(400, `"${request.domain}" isn't a domain name, such as books.example.co.uk.`);
  if (ctx.config.tls.siteAddresses.some((a) => a.replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, '').toLowerCase() === domain)) {
    throw new HttpError(400, `${domain} is also in SITE_ADDRESS, which uses the other certificate. Take it out of the install's .env file first.`);
  }
  const before = savedDomainRow(ctx.db);
  const token = request.token?.trim() || before?.api_token;
  if (!token) throw new HttpError(400, 'Enter the Cloudflare API token.');
  if (!isCloudflareToken(token)) throw new HttpError(400, "That doesn't look like a Cloudflare API token, which is 40 letters, digits, hyphens and underscores.");
  const pointAt = request.pointAt?.trim() || null;
  if (pointAt && (!net.isIP(pointAt) || pointAt.startsWith('127.') || pointAt === '::1')) {
    throw new HttpError(400, `"${pointAt}" isn't this server's address on your network, such as 192.168.1.50.`);
  }

  const zone = await findZone(ctx, token, domain);
  // Also checks the token can read the zone's DNS, which Caddy needs along with editing it.
  let recordId: string | null = null;
  if (pointAt) {
    const ours = before?.domain === domain && before.zone_id === zone.id ? before.dns_record_id : null;
    recordId = await pointDomain(ctx, token, zone, domain, pointAt, ours);
  } else {
    await callCloudflare(ctx, token, 'GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(domain)}`);
  }

  const warning = before && before.dns_record_id && before.dns_record_id !== recordId ? await removeRecord(ctx, before) : null;
  ctx.db
    .prepare(
      `INSERT INTO tls_domain (id, domain, zone_id, zone_name, api_token, dns_record_id, pointed_at, added_by) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET domain = excluded.domain, zone_id = excluded.zone_id, zone_name = excluded.zone_name,
         api_token = excluded.api_token, dns_record_id = excluded.dns_record_id, pointed_at = excluded.pointed_at,
         added_by = excluded.added_by, added_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(domain, zone.id, zone.name, token, recordId, recordId ? pointAt : null, by);
  return warning;
}

/** Puts back the domain saved before a change that couldn't be written out for Caddy. */
export function restoreDomain(db: Db, row: Row | undefined): void {
  db.prepare('DELETE FROM tls_domain').run();
  if (!row) return;
  db.prepare(
    `INSERT INTO tls_domain (id, domain, zone_id, zone_name, api_token, dns_record_id, pointed_at, added_by, added_at)
     VALUES (1, @domain, @zone_id, @zone_name, @api_token, @dns_record_id, @pointed_at, @added_by, @added_at)`,
  ).run(row);
}

/** Forgets the domain, removing the DNS record made for it. Returns any warning. */
export async function removeDomain(ctx: AppContext): Promise<string | null> {
  const row = savedDomainRow(ctx.db);
  if (!row) return null;
  const warning = await removeRecord(ctx, row);
  ctx.db.prepare('DELETE FROM tls_domain').run();
  return warning;
}

/** The site block Caddy imports for the domain: Let's Encrypt by Cloudflare's DNS, serving the app. */
export function domainCaddyfile(ctx: AppContext, row: Pick<Row, 'domain' | 'api_token'>): string {
  const { domainPort, acmeCa } = ctx.config.tls;
  return [
    '# Written by Crafty Accounting from Settings → HTTPS Certificate, and again each time it starts.',
    `${row.domain}${domainPort ? `:${domainPort}` : ''} {`,
    '\ttls {',
    ...(acmeCa ? [`\t\tca ${acmeCa}`] : []),
    `\t\tdns cloudflare ${row.api_token}`,
    "\t\t# Asked whether the challenge record is out yet: a home network's own DNS may answer for the domain itself.",
    '\t\tresolvers 1.1.1.1 1.0.0.1',
    '\t}',
    '\timport app',
    '}',
    '',
  ].join('\n');
}

/** "CN=R11\nO=Let's Encrypt\nC=US" → "Let's Encrypt (R11)". */
function issuerName(cert: crypto.X509Certificate): string {
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(cert.issuer)?.[1];
  const [o, cn] = [field('O'), field('CN')];
  return o && cn ? `${o} (${cn})` : (o ?? cn ?? cert.issuer.replace(/\n/g, ', '));
}

/** Asks Caddy, as a browser would, which certificate it serves for the domain. */
export function probeDomain(ctx: AppContext): Promise<TlsDomainCertificate> {
  const row = savedDomainRow(ctx.db);
  if (!row) return Promise.resolve({ state: 'none' });
  const address = ctx.config.tls.caddyAddress;
  if (!address) return Promise.resolve({ state: 'unreachable', message: "This install doesn't say where Caddy answers, so its certificate can't be checked from here." });
  return new Promise((resolve) => {
    const socket = tls.connect({ host: address.host, port: address.port, servername: row.domain, rejectUnauthorized: false, timeout: 8000 }, () => {
      const peer = socket.getPeerX509Certificate();
      const authorized = socket.authorized;
      socket.end();
      // Until it has one, Caddy answers with another of its certificates (or none).
      if (!peer || !peer.checkHost(row.domain)) return resolve({ state: 'waiting' });
      resolve({
        state: 'issued',
        issuer: issuerName(peer),
        validFrom: new Date(peer.validFrom).toISOString(),
        validTo: new Date(peer.validTo).toISOString(),
        trusted: authorized,
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ state: 'unreachable', message: `Caddy didn't answer at ${address.host}:${address.port}.` });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // A TLS alert means Caddy is there but has nothing to offer for the name yet.
      if (/alert|handshake|SSL/i.test(`${err.code ?? ''} ${err.message}`)) return resolve({ state: 'waiting' });
      resolve({ state: 'unreachable', message: `Caddy didn't answer at ${address.host}:${address.port} (${err.code ?? err.message}).` });
    });
  });
}

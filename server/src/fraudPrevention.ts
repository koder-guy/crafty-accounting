// The fraud prevention headers HMRC requires on every Making Tax Digital call,
// for the WEB_APP_VIA_SERVER connection method. The browser sends what only it
// knows in X-Fraud-Prevention (see client/src/lib/fraudPrevention.ts); the
// rest comes from the request.
// https://developer.service.hmrc.gov.uk/guides/fraud-prevention/connection-method/web-app-via-server/
//
// HMRC says never to guess or send placeholders. A value that can't be known
// is left out: there's no multi-factor sign-in or licence, and on a home
// network neither the browser's nor the server's public IP address is visible
// here. HMRC asks to be told about values that can't be collected.
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Request } from 'express';
import { APP_NAME, APP_VERSION } from '@crafty/shared';

/** The software name in Gov-Vendor-Version and Gov-Client-User-IDs. */
const SOFTWARE = 'crafty-accounting';

const PRIVATE_RANGES = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE_RANGES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE_RANGES.addSubnet(address, prefix, 'ipv6');
}

/** An IPv4 address written as IPv6 (::ffff:1.2.3.4) is treated as the IPv4 one. */
const plainIp = (ip: string) => ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');

/** A public internet address, rather than a private network, loopback or link-local one. */
export function publicIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const plain = plainIp(ip);
  const family = net.isIP(plain);
  if (!family) return null;
  return PRIVATE_RANGES.check(plain, family === 4 ? 'ipv4' : 'ipv6') ? null : plain;
}

const enc = encodeURIComponent;

/** The browser's part, checked against HMRC's formats so nothing malformed is passed on. */
export interface BrowserData {
  deviceId: string | null;
  userAgent: string | null;
  screens: string | null;
  windowSize: string | null;
  timezone: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCREEN = /^width=\d+&height=\d+&scaling-factor=\d+(\.\d+)?&colour-depth=\d+$/;
const WINDOW = /^width=\d+&height=\d+$/;
const TIMEZONE = /^UTC[+-]\d{2}:\d{2}$/;

export function parseBrowserData(header: string | undefined): BrowserData {
  const data = new URLSearchParams(header ?? '');
  const matching = (key: string, pattern: RegExp) => {
    const value = data.get(key);
    return value && pattern.test(value) ? value : null;
  };
  const userAgent = data.get('user-agent');
  return {
    deviceId: matching('device-id', UUID),
    // Only printable ASCII can go in a header.
    userAgent: userAgent && /^[\x20-\x7e]{1,1000}$/.test(userAgent) ? userAgent : null,
    screens: matching('screens', SCREEN),
    windowSize: matching('window-size', WINDOW),
    timezone: matching('timezone', TIMEZONE),
  };
}

export interface FraudPreventionInput {
  browser: BrowserData;
  /** The browser's address as this server sees it (after any trusted proxy). */
  clientIp: string | null;
  clientPort: number | null;
  /** When the request carrying the client's address arrived. */
  receivedAt: Date;
  userName: string;
  /** This server's public address, if it has one. */
  vendorIp: string | null;
}

export function fraudPreventionHeaders(input: FraudPreventionInput): Record<string, string> {
  const { browser } = input;
  const headers: Record<string, string> = {
    'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER',
    'Gov-Client-User-IDs': `${SOFTWARE}=${enc(input.userName)}`,
    'Gov-Vendor-Product-Name': enc(APP_NAME),
    'Gov-Vendor-Version': `${SOFTWARE}=${enc(APP_VERSION)}`,
  };
  if (browser.userAgent) headers['Gov-Client-Browser-JS-User-Agent'] = browser.userAgent;
  if (browser.deviceId) headers['Gov-Client-Device-ID'] = browser.deviceId;
  if (browser.screens) headers['Gov-Client-Screens'] = browser.screens;
  if (browser.windowSize) headers['Gov-Client-Window-Size'] = browser.windowSize;
  if (browser.timezone) headers['Gov-Client-Timezone'] = browser.timezone;

  const clientIp = publicIp(input.clientIp);
  const vendorIp = publicIp(input.vendorIp);
  if (clientIp) {
    headers['Gov-Client-Public-IP'] = clientIp;
    headers['Gov-Client-Public-IP-Timestamp'] = input.receivedAt.toISOString();
    if (input.clientPort && input.clientPort > 0 && input.clientPort <= 65535) {
      headers['Gov-Client-Public-Port'] = String(input.clientPort);
    }
  }
  if (vendorIp) {
    headers['Gov-Vendor-Public-IP'] = vendorIp;
    if (clientIp) headers['Gov-Vendor-Forwarded'] = `by=${enc(vendorIp)}&for=${enc(clientIp)}`;
  }
  return headers;
}

const vendorIpCache = new Map<string, { ip: string | null; until: number }>();

/** The public address of the name the browser used to reach this server, looked up in DNS. */
async function vendorIp(hostname: string): Promise<string | null> {
  if (net.isIP(hostname)) return publicIp(hostname);
  const cached = vendorIpCache.get(hostname);
  if (cached && cached.until > Date.now()) return cached.ip;
  let ip: string | null = null;
  try {
    ip = publicIp((await dns.lookup(hostname)).address);
  } catch {
    // A name only the home network knows (crafty.local): no public address.
  }
  vendorIpCache.set(hostname, { ip, until: Date.now() + 10 * 60 * 1000 });
  return ip;
}

/** Everything HMRC needs about the browser and server behind this request. */
export async function fraudPreventionForRequest(req: Request, trustProxy: boolean): Promise<Record<string, string>> {
  // Behind Caddy the socket's port is Caddy's, so Caddy passes on the browser's (see Caddyfile).
  const forwardedPort = trustProxy ? Number(req.get('X-Client-Port')) : NaN;
  return fraudPreventionHeaders({
    browser: parseBrowserData(req.get('X-Fraud-Prevention')),
    clientIp: req.ip ?? null,
    clientPort: Number.isInteger(forwardedPort) ? forwardedPort : trustProxy ? null : (req.socket.remotePort ?? null),
    receivedAt: new Date(),
    userName: req.user!.name,
    vendorIp: await vendorIp(req.hostname),
  });
}

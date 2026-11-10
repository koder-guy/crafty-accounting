// Settings → HTTPS Certificate: a certificate and private key of the owner's own, uploaded as a
// .pfx/.p12 file, which Caddy serves for SITE_ADDRESS instead of its own private certificate; and
// a domain whose DNS is on Cloudflare, for which Caddy gets a Let's Encrypt certificate.

/** Largest .pfx/.p12 file accepted; real ones are a few kilobytes. */
export const MAX_PFX_BYTES = 1024 * 1024;

/** File extensions offered when choosing one. */
export const PFX_EXTENSIONS = ['.pfx', '.p12'];

/** Days before expiry that the bell warns, then warns again. */
export const CERTIFICATE_WARN_DAYS = [30, 7] as const;

/**
 * How a new certificate reaches Caddy on this install: the Linux quick install restarts Caddy
 * itself; Docker needs `docker compose restart caddy`; other installs have no Caddy the app knows of.
 */
export type TlsSetup = 'restarts-itself' | 'restart-command' | 'unavailable';

export interface TlsCertificateInfo {
  /** The certificate's subject and issuer, as "CN=…" and so on, one per line. */
  subject: string;
  issuer: string;
  /** The names and IP addresses it's for. */
  names: string[];
  validFrom: string;
  validTo: string;
  /** SHA-256, as AB:CD:… */
  fingerprint: string;
  selfSigned: boolean;
  /** Intermediate certificates sent with it. */
  intermediates: number;
  /** "RSA 2048", "EC P-256" and so on. */
  keyType: string;
  /** Addresses in SITE_ADDRESS the certificate isn't for: browsers warn there. */
  uncovered: string[];
  /**
   * Names it's for that aren't in SITE_ADDRESS, which Caddy serves with it too, while it's in
   * use. Domain names only: not wildcards (which name no one address) or IP addresses.
   */
  added: string[];
  fileName: string | null;
  addedBy: string;
  addedAt: string;
}

/** A domain on Cloudflare that Caddy gets a Let's Encrypt certificate for, by Cloudflare's DNS. */
export interface TlsDomainInfo {
  domain: string;
  /** The Cloudflare zone it's in, such as example.co.uk. */
  zone: string;
  /** The start and end of the API token; it's never sent back whole. */
  tokenHint: string;
  addedBy: string;
  addedAt: string;
}

/**
 * How SITE_ADDRESS and the domain are served: Caddy's own private certificate authority, a domain
 * on Cloudflare with Let's Encrypt, or an uploaded certificate. Each keeps its settings while
 * another is in use, so switching back needs nothing entering again.
 */
export const TLS_METHODS = ['internal', 'cloudflare', 'custom'] as const;
export type TlsMethod = (typeof TLS_METHODS)[number];

export interface TlsStatus {
  /** The method in use: one whose settings are saved, else `internal`. */
  method: TlsMethod;
  /** The addresses in SITE_ADDRESS that Caddy serves, without a domain on Cloudflare in use (which has its own block). */
  addresses: string[];
  setup: TlsSetup;
  /** For `restart-command`: what to run where the install lives. */
  restartCommand: string | null;
  /** TLS_CUSTOM=off in .env: the saved certificate is ignored. */
  disabled: boolean;
  certificate: TlsCertificateInfo | null;
  domain: TlsDomainInfo | null;
  /** This server's address (SITE_IP, or the first IP in SITE_ADDRESS), which a domain should point at. */
  serverIp: string | null;
}

/** Setting up a domain on Cloudflare. */
export interface TlsDomainRequest {
  domain: string;
  /** Leave out to keep the saved token. */
  token?: string;
}

/** What Caddy serves for the domain just now. */
export type TlsDomainCertificate =
  | { state: 'none' }
  /** Caddy answers, but has no certificate for the domain yet. */
  | { state: 'waiting' }
  /** `trusted`: by the server's own list of authorities, as browsers would (Let's Encrypt's staging ones aren't). */
  | { state: 'issued'; issuer: string; validFrom: string; validTo: string; trusted: boolean }
  /** Let's Encrypt hasn't issued one yet, so Caddy serves the domain with its own private certificate meanwhile. */
  | { state: 'fallback' }
  | { state: 'unreachable'; message: string };

/** A domain name such as books.example.co.uk: letters, digits and hyphens, in two or more parts, not an IP address. */
export function isDomainName(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value) &&
    /[a-z]/.test(value.slice(value.lastIndexOf('.') + 1))
  );
}

/** Cloudflare API tokens are 40 letters, digits, hyphens and underscores; anything else is a slip when pasting. */
export const isCloudflareToken = (value: string) => /^[A-Za-z0-9_-]{30,80}$/.test(value);

/** After uploading or removing: whether Caddy is restarting by itself, so the page should reload. */
export interface TlsChangeResult extends TlsStatus {
  restarting: boolean;
}

/** Whole days from `now` until `date` (negative once it's passed). */
export function daysUntil(date: string, now = new Date()): number {
  return Math.floor((new Date(date).getTime() - now.getTime()) / 86_400_000);
}

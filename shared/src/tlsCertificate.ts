// Settings → HTTPS Certificate: a certificate and private key of the owner's own, uploaded as a
// .pfx/.p12 file, which Caddy serves instead of its own private certificate or Let's Encrypt's.

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
  fileName: string | null;
  addedBy: string;
  addedAt: string;
}

export interface TlsStatus {
  setup: TlsSetup;
  /** For `restart-command`: what to run where the install lives. */
  restartCommand: string | null;
  /** TLS_CUSTOM=off in .env: the saved certificate is ignored. */
  disabled: boolean;
  certificate: TlsCertificateInfo | null;
}

/** After uploading or removing: whether Caddy is restarting by itself, so the page should reload. */
export interface TlsChangeResult extends TlsStatus {
  restarting: boolean;
}

/** Whole days from `now` until `date` (negative once it's passed). */
export function daysUntil(date: string, now = new Date()): number {
  return Math.floor((new Date(date).getTime() - now.getTime()) / 86_400_000);
}

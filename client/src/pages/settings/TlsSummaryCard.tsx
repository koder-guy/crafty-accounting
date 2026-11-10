import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { daysUntil, formatDisplayDate, type TlsStatus } from '@crafty/shared';
import { Alert, Badge, Card, CardHeader, buttonClasses } from '../../components/ui';
import { useTlsDomainCertificate } from '../../lib/queries';
import { CertificateState } from './TlsDomainCard';
import { METHOD_INFO } from './tlsMethods';

/** Caddy serves its own certificate authority here, beside the app (see the Caddyfile). */
const CADDY_ROOT = '/crafty-root.crt';

const date = (iso: string) => formatDisplayDate(iso.slice(0, 10));

/** SHA-256 of a PEM certificate, as AB:CD:… (what Keychain Access and openssl show). */
async function fingerprint(pem: string): Promise<string> {
  const base64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** Caddy's certificate authority as this browser reaches it, or null where Caddy doesn't serve it (an uploaded certificate in use, or no Caddy in front). */
function useCaddyRoot(enabled: boolean) {
  return useQuery({
    queryKey: ['tls', 'caddy-root'],
    enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const res = await fetch(CADDY_ROOT, { credentials: 'same-origin' });
      const text = res.ok ? await res.text() : '';
      const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0];
      return pem ? { fingerprint: await fingerprint(pem) } : null;
    },
  });
}

function TrustSteps() {
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer text-accent-soft select-none hover:underline">How to trust it on a device</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
        <li>
          <span className="text-ink">Mac:</span> open it to add it to the System keychain, then in Keychain Access set Trust → When using this certificate to Always
          Trust.
        </li>
        <li>
          <span className="text-ink">Windows:</span> open it, then Install Certificate → Local Machine → Trusted Root Certification Authorities.
        </li>
        <li>
          <span className="text-ink">iPhone or iPad:</span> install the profile in Settings → General → VPN & Device Management, then turn it on in Settings → General →
          About → Certificate Trust Settings.
        </li>
        <li>
          <span className="text-ink">Android:</span> Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
        </li>
      </ul>
    </details>
  );
}

const list = (items: string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Where SITE_ADDRESS is served, for the sentences below. */
function Addresses({ status, other, own }: { status: TlsStatus; other?: boolean; own?: boolean }) {
  // `own`: with the app's own certificate, which also serves addresses added in the app that the method doesn't cover.
  const addresses = own ? [...status.addresses, ...status.ownCertificateAddresses] : status.addresses;
  if (addresses.length === 0) return <>{other ? 'any other address' : 'this server'}</>;
  return (
    <>
      {other ? 'the other address' : 'the address'}
      {addresses.length === 1 ? ' ' : 'es '}
      <span className="text-ink">{list(addresses)}</span>
    </>
  );
}

/** Caddy's certificate authority: its fingerprint and download, with how to trust it. */
function CaddyRootDownload({ intro }: { intro: ReactNode }) {
  const root = useCaddyRoot(true);
  if (root.isLoading) return <p className="text-sm text-muted">{intro}</p>;
  if (!root.data) {
    return (
      <p className="text-sm text-muted">
        {intro} It isn't served at this address, so it can't be downloaded here: open the app at one of the addresses in SITE_ADDRESS to download it.
      </p>
    );
  }
  return (
    <>
      <p className="text-sm text-muted">{intro} Before trusting it, check the fingerprint on the device matches this one:</p>
      <p className="font-mono text-xs break-all text-ink">SHA-256 {root.data.fingerprint}</p>
      <div>
        <a href={CADDY_ROOT} download="crafty-root.crt" className={buttonClasses()}>
          <Download className="size-4" aria-hidden />
          Download crafty-root.crt
        </a>
      </div>
      <TrustSteps />
    </>
  );
}

/** At the top of Settings → HTTPS Certificate: how the app is served just now, and the certificate devices need for it. */
export function TlsSummaryCard({ status }: { status: TlsStatus }) {
  // TLS_CUSTOM=off: Caddy ignores the uploaded certificate, so its own is in use.
  const switchedOff = status.method === 'custom' && status.disabled;
  const method = switchedOff ? 'internal' : status.method;
  const info = METHOD_INFO[method];
  const cert = status.certificate;
  const domain = status.domain;
  const { data: domainCert } = useTlsDomainCertificate(method === 'cloudflare');
  const days = cert ? daysUntil(cert.validTo) : 0;

  return (
    <Card>
      <CardHeader icon={<ShieldCheck className="size-5 text-accent-soft" />} title="How the app is secured" action={<Badge tone="ok">{info.name}</Badge>} />
      <div className="space-y-4 px-5 pb-6 sm:px-6">
        {switchedOff && (
          <Alert tone="warning">
            Your uploaded certificate is chosen, but <code className="font-mono">TLS_CUSTOM=off</code> in the install's .env file switches it off, so the app uses its own.
            Remove that line and restart to use yours.
          </Alert>
        )}

        {method === 'internal' && (
          <CaddyRootDownload
            intro={
              <>
                The app serves <Addresses status={status} own /> with a certificate from its own private certificate authority. Download the authority and install it on each
                device once, and browsers stop warning about this app.
              </>
            }
          />
        )}

        {method === 'cloudflare' && domain && (
          <>
            <p className="text-sm text-muted">
              The app gets a certificate from Let's Encrypt for <span className="text-ink">{domain.domain}</span>, through Cloudflare's DNS. Every browser already trusts
              it, so there's nothing to install on devices for the domain.
            </p>
            <CertificateState cert={domainCert} domain={domain.domain} />
            <CaddyRootDownload
              intro={
                <>
                  The app's own certificate authority covers <Addresses status={status} other own />
                  {domainCert?.state === 'fallback' ? ", and stands in for the domain until Let's Encrypt issues its certificate" : ''}. Devices that open the
                  app there need to trust it once.
                </>
              }
            />
          </>
        )}

        {method === 'custom' && cert && (
          <>
            <p className="text-sm text-muted">
              The app serves <Addresses status={status} />
              {cert.added.length > 0 && (
                <>
                  , and <span className="text-ink">{list(cert.added)}</span> (on the certificate, though not in SITE_ADDRESS),
                </>
              )}{' '}
              with the certificate you uploaded, valid to {date(cert.validTo)}
              {days < 0 ? <span className="text-out-soft"> (expired)</span> : days < 30 ? <span className="text-warn"> ({days} days left)</span> : ''}.{' '}
              {status.ownCertificateAddresses.length > 0 && (
                <>
                  It serves <span className="text-ink">{list(status.ownCertificateAddresses)}</span>, added here but not on the certificate, with its own.{' '}
                </>
              )}
              {cert.selfSigned
                ? "It's self-signed, so each device has to trust it once: download it, then install it."
                : 'It comes from a certificate authority, so devices that trust that authority need nothing more; download it to keep a copy.'}
            </p>
            <div>
              <a href="/api/tls/certificate.crt" download="crafty-certificate.crt" className={buttonClasses()}>
                <Download className="size-4" aria-hidden />
                Download certificate
              </a>
            </div>
            {cert.selfSigned && <TrustSteps />}
          </>
        )}
      </div>
    </Card>
  );
}

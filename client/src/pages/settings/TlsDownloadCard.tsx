import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { TlsStatus } from '@crafty/shared';
import { Alert, Card, CardHeader, buttonClasses } from '../../components/ui';

/** Caddy serves its own certificate authority here, beside the app (see the Caddyfile). */
const CADDY_ROOT = '/crafty-root.crt';

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
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
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
  );
}

/** The certificate devices need to trust to open the app at the addresses in SITE_ADDRESS without a warning. */
export function TlsDownloadCard({ status }: { status: TlsStatus }) {
  const uploaded = status.certificate && !status.disabled ? status.certificate : null;
  const root = useCaddyRoot(!uploaded);
  const onDomain = !!status.domain && window.location.hostname === status.domain.domain;

  return (
    <Card>
      <CardHeader icon={<Download className="size-5 text-accent-soft" />} title="Download certificate" />
      <div className="space-y-4 px-5 pb-6 sm:px-6">
        {onDomain && (
          <Alert tone="info">
            You're on {status.domain!.domain}, whose Let's Encrypt certificate browsers trust already. This is for the other addresses, in SITE_ADDRESS.
          </Alert>
        )}

        {uploaded ? (
          <>
            <p className="text-sm text-muted">
              The addresses in SITE_ADDRESS use the certificate uploaded above.{' '}
              {uploaded.selfSigned
                ? "It's self-signed, so each device has to trust it once: download it, then install it as below."
                : 'It comes from a certificate authority, so devices that trust that authority need nothing more; download it to keep a copy.'}
            </p>
            <div>
              <a href="/api/tls/certificate.crt" download="crafty-certificate.crt" className={buttonClasses()}>
                <Download className="size-4" aria-hidden />
                Download certificate
              </a>
            </div>
            {uploaded.selfSigned && <TrustSteps />}
          </>
        ) : root.isLoading ? null : root.data ? (
          <>
            <p className="text-sm text-muted">
              The addresses in SITE_ADDRESS use Caddy's own certificate authority. Download it and install it on each device once, and browsers stop warning about this
              app. Before trusting it, check the fingerprint on the device matches this one:
            </p>
            <p className="font-mono text-xs break-all text-ink">SHA-256 {root.data.fingerprint}</p>
            <div>
              <a href={CADDY_ROOT} download="crafty-root.crt" className={buttonClasses()}>
                <Download className="size-4" aria-hidden />
                Download crafty-root.crt
              </a>
            </div>
            <TrustSteps />
          </>
        ) : (
          <p className="text-sm text-muted">
            Caddy's certificate authority isn't served at this address, so it can't be downloaded here. Open the app at one of the addresses in SITE_ADDRESS to
            download it.
          </p>
        )}
      </div>
    </Card>
  );
}

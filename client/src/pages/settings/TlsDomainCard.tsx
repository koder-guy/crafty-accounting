import { useId, useState, type FormEvent } from 'react';
import { ExternalLink, Globe, LoaderCircle } from 'lucide-react';
import { daysUntil, formatDisplayDate, isDomainName, type TlsDomainCertificate, type TlsStatus } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field } from '../../components/ui';
import { useTlsDomainCertificate, useTlsDomainMutations } from '../../lib/queries';

const API_TOKENS = 'https://dash.cloudflare.com/profile/api-tokens';
const date = (iso: string) => formatDisplayDate(iso.slice(0, 10));
const linkClass = 'text-accent-soft underline-offset-2 hover:underline';

function DomainForm({ status, onDone, onCancel }: { status: TlsStatus; onDone: (result: { warning?: string | null; restarting: boolean }) => void; onCancel?: () => void }) {
  const { save } = useTlsDomainMutations();
  const saved = status.domain;
  const ids = { domain: useId(), token: useId(), point: useId(), ip: useId() };
  const [domain, setDomain] = useState(saved?.domain ?? '');
  const [token, setToken] = useState('');
  const [point, setPoint] = useState(saved ? saved.pointedAt !== null : true);
  const [ip, setIp] = useState(saved?.pointedAt ?? status.serverIp ?? '');
  const [touched, setTouched] = useState(false);
  const cleanDomain = domain.trim().toLowerCase().replace(/\.$/, '');
  const domainProblem = touched && cleanDomain && !isDomainName(cleanDomain) ? 'Enter a domain name, such as books.example.co.uk.' : undefined;
  const ready = isDomainName(cleanDomain) && (token.trim() !== '' || !!saved) && (!point || ip.trim() !== '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    save.mutate(
      { domain: cleanDomain, token: token.trim() || undefined, pointAt: point ? ip.trim() : null },
      {
        onSuccess: (result) => {
          setToken('');
          onDone({ warning: result.warning, restarting: result.restarting });
        },
      },
    );
  };
  const change = <T,>(set: (v: T) => void) => (value: T) => {
    save.reset();
    set(value);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Domain" htmlFor={ids.domain} error={domainProblem} hint="The name you'll browse to. Its DNS must be on your Cloudflare account.">
        <input
          id={ids.domain}
          className="field"
          value={domain}
          placeholder="books.example.co.uk"
          autoComplete="off"
          spellCheck={false}
          onBlur={() => setTouched(true)}
          onChange={(e) => change(setDomain)(e.target.value)}
        />
      </Field>
      <Field
        label="Cloudflare API token"
        htmlFor={ids.token}
        hint={
          <>
            {saved ? `Leave it empty to keep the one saved (${saved.tokenHint}). ` : ''}
            Create one in{' '}
            <a href={API_TOKENS} target="_blank" rel="noreferrer" className={linkClass}>
              Cloudflare → My Profile → API Tokens
            </a>{' '}
            from the <span className="text-ink">Edit zone DNS</span> template, for this domain's zone only. It needs Zone → DNS → Edit and Zone → Zone → Read.
          </>
        }
      >
        <input id={ids.token} type="password" className="field font-mono" value={token} autoComplete="off" spellCheck={false} onChange={(e) => change(setToken)(e.target.value)} />
      </Field>
      <div className="space-y-3">
        <div className="flex gap-3">
          <input id={ids.point} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" checked={point} onChange={(e) => change(setPoint)(e.target.checked)} />
          <label htmlFor={ids.point} className="cursor-pointer text-sm">
            <span className="font-medium text-ink">Point the domain at this server</span>
            <span className="mt-0.5 block text-muted">
              Adds a DNS-only record in Cloudflare, so devices find this server by the domain. Leave it unticked if the domain already points here.
            </span>
          </label>
        </div>
        {point && (
          <Field label="This server's address on your network" htmlFor={ids.ip} className="pl-7">
            <input id={ids.ip} className="field max-w-60 font-mono" value={ip} placeholder="192.168.1.50" autoComplete="off" spellCheck={false} onChange={(e) => change(setIp)(e.target.value)} />
          </Field>
        )}
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!ready}>
          {save.isPending ? 'Checking with Cloudflare…' : saved ? 'Save changes' : 'Set up domain'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function CertificateState({ cert, domain }: { cert: TlsDomainCertificate | undefined; domain: string }) {
  if (!cert || cert.state === 'none') return null;
  if (cert.state === 'waiting') {
    return (
      <Alert tone="info">
        <span className="flex items-center gap-2">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden /> Waiting for Let's Encrypt. Caddy asks for the certificate once it has restarted, which usually takes a minute or two.
        </span>
      </Alert>
    );
  }
  if (cert.state === 'unreachable') return <Alert tone="warning">{cert.message} The certificate's progress can't be shown here.</Alert>;
  if (!cert.trusted) {
    return (
      <Alert tone="warning">
        Caddy serves {domain} with a certificate from {cert.issuer}, which browsers don't trust (Let's Encrypt's staging authority, set by ACME_CA, is one such).
      </Alert>
    );
  }
  const days = daysUntil(cert.validTo);
  return (
    <Alert tone="success">
      {domain} has its certificate from {cert.issuer}, valid to {date(cert.validTo)}
      {days < 30 ? ` (${days} days left)` : ''}. Caddy renews it by itself before then.
    </Alert>
  );
}

function badgeFor(cert: TlsDomainCertificate | undefined, configured: boolean) {
  if (!configured) return <Badge>Not set up</Badge>;
  if (!cert) return null;
  if (cert.state === 'issued') return cert.trusted ? <Badge tone="ok">In use</Badge> : <Badge tone="warn">Not trusted</Badge>;
  if (cert.state === 'waiting') return <Badge tone="warn">Waiting</Badge>;
  if (cert.state === 'unreachable') return <Badge tone="warn">Unknown</Badge>;
  return null;
}

/** A domain on Cloudflare that Caddy gets a Let's Encrypt certificate for. */
export function TlsDomainCard({ status, canEdit }: { status: TlsStatus; canEdit: boolean }) {
  const { remove } = useTlsDomainMutations();
  const saved = status.domain;
  const { data: cert } = useTlsDomainCertificate(!!saved);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [applied, setApplied] = useState<{ warning?: string | null; restarting: boolean } | null>(null);
  const url = saved ? `https://${saved.domain}${typeof window !== 'undefined' && window.location.port ? `:${window.location.port}` : ''}` : '';

  return (
    <Card>
      <CardHeader icon={<Globe className="size-5 text-accent-soft" />} title="Domain on Cloudflare" action={badgeFor(cert, !!saved)} />
      <div className="space-y-5 px-5 pb-6 sm:px-6">
        {!saved && (
          <p className="text-sm text-muted">
            If your domain's DNS is on Cloudflare, Caddy can get a certificate for it from Let's Encrypt, which every browser already trusts, with nothing to install
            on devices. It proves the domain is yours through Cloudflare's DNS, so the server needn't be reachable from the internet.
          </p>
        )}

        {saved && !editing && (
          <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[160px_1fr]">
            <dt className="text-muted">Domain</dt>
            <dd>
              <a href={url} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 break-all ${linkClass}`}>
                {saved.domain}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </dd>
            <dt className="text-muted">Cloudflare zone</dt>
            <dd>{saved.zone}</dd>
            <dt className="text-muted">API token</dt>
            <dd className="font-mono text-xs">{saved.tokenHint}</dd>
            <dt className="text-muted">DNS</dt>
            <dd>{saved.pointedAt ? `Points at ${saved.pointedAt}, a record this app made` : 'Left as it was in Cloudflare'}</dd>
            <dt className="text-muted">Set up</dt>
            <dd>
              {date(saved.addedAt)} by {saved.addedBy}
            </dd>
          </dl>
        )}

        {saved && !editing && <CertificateState cert={cert} domain={saved.domain} />}
        {applied?.warning && <Alert tone="warning">{applied.warning}</Alert>}
        {applied && !applied.restarting && status.restartCommand && (
          <Alert tone="info">
            Caddy changes over once restarted: <code className="font-mono break-all text-ink">{status.restartCommand}</code>
          </Alert>
        )}
        {saved && !editing && (
          <p className="text-sm text-muted">
            If the domain doesn't open at home, your router may refuse DNS answers that point at home addresses (DNS rebinding protection). Allow the domain in its
            settings, or add it to the router's own DNS.
          </p>
        )}

        {!canEdit ? (
          !saved && <p className="text-sm text-muted">An editor can set one up.</p>
        ) : !saved || editing ? (
          <DomainForm
            status={status}
            onCancel={editing ? () => setEditing(false) : undefined}
            onDone={(result) => {
              setEditing(false);
              setApplied(result);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={() => {
                setApplied(null);
                setEditing(true);
              }}
            >
              Change domain
            </Button>
            <Button type="button" variant="softDanger" onClick={() => setConfirmRemove(true)}>
              Remove domain
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the domain?"
        confirmLabel="Remove"
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          const result = await remove.mutateAsync();
          setApplied({ warning: result.warning, restarting: result.restarting });
        }}
      >
        <p>
          Caddy stops serving {saved?.domain}, and the API token is forgotten.
          {saved?.pointedAt ? ' The DNS record this app made for it in Cloudflare is removed too.' : ''} The addresses in SITE_ADDRESS carry on as they are.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

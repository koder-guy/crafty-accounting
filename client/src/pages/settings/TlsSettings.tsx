import { useRef, useState, type FormEvent } from 'react';
import { FileKey, FileUp, LockKeyhole } from 'lucide-react';
import { daysUntil, formatDisplayDate, MAX_PFX_BYTES, PFX_EXTENSIONS, type TlsCertificateInfo, type TlsStatus } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useCanEdit, useTls, useTlsMutations } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

const date = (iso: string) => formatDisplayDate(iso.slice(0, 10));

/** "CN=Example\nO=Example Ltd\nC=GB" → "Example, Example Ltd". */
const distinguishedName = (dn: string) =>
  dn
    .split('\n')
    .filter((part) => /^(CN|O)=/.test(part))
    .map((part) => part.slice(part.indexOf('=') + 1))
    .join(', ') || dn.replace(/\n/g, ', ');

/** What happens next on this install once a certificate is saved or removed. */
function Applying({ status, restarting }: { status: TlsStatus; restarting: boolean }) {
  if (status.disabled) return null;
  if (restarting) {
    return (
      <Alert tone="success">
        Caddy is restarting to change over. This page reloads in a moment. If the browser then warns about the certificate, it doesn't trust it yet.
      </Alert>
    );
  }
  return (
    <Alert tone="info">
      Caddy changes over once restarted
      {status.restartCommand ? (
        <>
          : <code className="font-mono break-all text-ink">{status.restartCommand}</code>
        </>
      ) : (
        '.'
      )}
    </Alert>
  );
}

function UploadForm({ replacing, onDone, onCancel }: { replacing: boolean; onDone: (restarting: boolean) => void; onCancel?: () => void }) {
  const { upload } = useTlsMutations();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const tooLarge = !!file && file.size > MAX_PFX_BYTES;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || tooLarge) return;
    upload.mutate(
      { file, password },
      {
        onSuccess: (result) => {
          setFile(null);
          setPassword('');
          if (fileInput.current) fileInput.current.value = '';
          onDone(result.restarting);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label={replacing ? 'New certificate file' : 'Certificate file'}
        htmlFor="tls-file"
        error={tooLarge ? "That's too large for a certificate file." : undefined}
        hint="A .pfx or .p12 file holding the certificate and its private key, with any intermediate certificates."
      >
        <div className="flex items-center gap-3">
          <input
            id="tls-file"
            ref={fileInput}
            type="file"
            accept={PFX_EXTENSIONS.join(',')}
            className="sr-only"
            onChange={(e) => {
              upload.reset();
              setFile(e.target.files?.[0] ?? null);
            }}
          />
          <Button type="button" onClick={() => fileInput.current?.click()}>
            <FileUp className="size-4" aria-hidden />
            Choose file
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{file ? file.name : 'No file chosen'}</span>
        </div>
      </Field>
      <Field label="File password" htmlFor="tls-password" error={upload.error?.message} hint="Used only to open the file; it isn't saved. Leave it empty if the file has none.">
        <input
          id="tls-password"
          type="password"
          className="field"
          value={password}
          autoComplete="off"
          onChange={(e) => {
            upload.reset();
            setPassword(e.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" busy={upload.isPending} disabled={!file || tooLarge}>
          {upload.isPending ? 'Checking certificate…' : 'Use this certificate'}
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

function Details({ cert }: { cert: TlsCertificateInfo }) {
  const days = daysUntil(cert.validTo);
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[160px_1fr]">
      <dt className="text-muted">For</dt>
      <dd className="break-all">{cert.names.join(', ') || distinguishedName(cert.subject)}</dd>
      <dt className="text-muted">Issued by</dt>
      <dd>
        {cert.selfSigned ? 'Itself (self-signed)' : distinguishedName(cert.issuer)}
        {cert.intermediates > 0 && <span className="text-muted"> · with {cert.intermediates} intermediate certificate{cert.intermediates === 1 ? '' : 's'}</span>}
      </dd>
      <dt className="text-muted">Valid</dt>
      <dd>
        {date(cert.validFrom)} to {date(cert.validTo)}
        {days < 0 ? (
          <span className="text-out-soft"> · expired</span>
        ) : days < 30 ? (
          <span className="text-warn"> · {days === 0 ? 'expires today' : `${days} day${days === 1 ? '' : 's'} left`}</span>
        ) : null}
      </dd>
      <dt className="text-muted">Key</dt>
      <dd>{cert.keyType}</dd>
      <dt className="text-muted">SHA-256 fingerprint</dt>
      <dd className="font-mono text-xs break-all">{cert.fingerprint}</dd>
      <dt className="text-muted">Added</dt>
      <dd>
        {date(cert.addedAt)} by {cert.addedBy}
        {cert.fileName && <span className="text-muted"> · from {cert.fileName}</span>}
      </dd>
    </dl>
  );
}

function CertificateCard({ status, canEdit }: { status: TlsStatus; canEdit: boolean }) {
  const { remove } = useTlsMutations();
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [applied, setApplied] = useState<{ restarting: boolean } | null>(null);
  const cert = status.certificate;
  const days = cert ? daysUntil(cert.validTo) : null;

  const badge = !cert ? (
    <Badge>Caddy's own</Badge>
  ) : status.disabled ? (
    <Badge tone="warn">Switched off</Badge>
  ) : days! < 0 ? (
    <Badge tone="out">Expired</Badge>
  ) : days! < 30 ? (
    <Badge tone="warn">Expires soon</Badge>
  ) : (
    <Badge tone="ok">In use</Badge>
  );

  return (
    <Card>
      <CardHeader icon={<FileKey className="size-5 text-accent-soft" />} title="Certificate" action={badge} />
      <div className="space-y-5 px-5 pb-6 sm:px-6">
        {cert ? (
          <Details cert={cert} />
        ) : (
          <p className="text-sm text-muted">
            None uploaded, so Caddy uses the certificate set by <code className="font-mono text-ink">TLS_ISSUER</code> in the install's .env file: its own private
            one (which each device has to trust), or one from Let's Encrypt for a public domain.
          </p>
        )}

        {cert && cert.uncovered.length > 0 && (
          <Alert tone="warning">
            It isn't for {cert.uncovered.join(', ')}, which {cert.uncovered.length === 1 ? 'is' : 'are'} in <code className="font-mono">SITE_ADDRESS</code>. Browsers warn there;
            browse by one of the names it's for instead.
          </Alert>
        )}
        {cert?.selfSigned && (
          <Alert tone="info">This certificate is self-signed, so each device has to trust it, as with Caddy's own.</Alert>
        )}
        {cert && status.disabled && (
          <Alert tone="warning">
            <code className="font-mono">TLS_CUSTOM=off</code> in the install's .env file switches it off, so Caddy uses its own. Remove that line and restart to use this one.
          </Alert>
        )}

        {applied && <Applying status={status} restarting={applied.restarting} />}

        {!canEdit ? (
          !cert && <p className="text-sm text-muted">An editor can upload one.</p>
        ) : !cert || replacing ? (
          <UploadForm
            replacing={replacing}
            onCancel={replacing ? () => setReplacing(false) : undefined}
            onDone={(restarting) => {
              setReplacing(false);
              setApplied({ restarting });
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={() => {
                setApplied(null);
                setReplacing(true);
              }}
            >
              Replace certificate
            </Button>
            <Button type="button" variant="softDanger" onClick={() => setConfirmRemove(true)}>
              Remove certificate
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the certificate?"
        confirmLabel="Remove"
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          const result = await remove.mutateAsync();
          setApplied({ restarting: result.restarting });
        }}
      >
        <p>
          Caddy goes back to the certificate set by <code className="font-mono">TLS_ISSUER</code>. If that's its own private one, devices that don't trust it yet will warn
          before opening the app.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

export function TlsSettings() {
  const { data: status, isLoading, error } = useTls();
  const canEdit = useCanEdit();
  return (
    <div className="space-y-6">
      <SettingsHeading
        title="HTTPS Certificate"
        description="Serve the app with a certificate of your own, such as one from your organisation or a certificate authority, instead of Caddy's."
      />
      {isLoading ? (
        <Spinner />
      ) : error || !status ? (
        <Alert>{error?.message ?? "The certificate settings couldn't be loaded."}</Alert>
      ) : status.setup === 'unavailable' ? (
        <Card>
          <CardHeader icon={<LockKeyhole className="size-5 text-accent-soft" />} title="Not available on this install" />
          <p className="px-5 pb-6 text-sm text-muted sm:px-6">
            A certificate can be uploaded here on the Linux quick install and the Docker install, which serve HTTPS through Caddy. This copy of the app isn't run
            by either, so set up HTTPS wherever it's served from.
          </p>
        </Card>
      ) : (
        <CertificateCard status={status} canEdit={canEdit} />
      )}
    </div>
  );
}

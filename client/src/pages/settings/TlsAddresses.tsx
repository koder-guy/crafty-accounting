import { useId, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { isDomainName, MAX_TLS_ADDRESSES, type TlsStatus } from '@crafty/shared';
import { Alert, Button, IconButton } from '../../components/ui';
import { useTlsMutations } from '../../lib/queries';

/** "https://crafty.local:8443" → "crafty.local", as the server compares them. */
const host = (address: string) => address.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();

const clean = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');

function Row({ name, note, onRemove, busy }: { name: string; note: string; onRemove?: () => void; busy?: boolean }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm break-all text-ink">{name}</span>
        <span className="block text-xs text-muted">{note}</span>
      </span>
      {onRemove && (
        <IconButton label={`Remove ${name}`} tone="danger" disabled={busy} onClick={onRemove}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      )}
    </li>
  );
}

/**
 * Every address the app is served at: those from the install (SITE_ADDRESS, and the local IP
 * address the quick install adds), then those added here, which editors can change.
 */
export function TlsAddresses({ status, canEdit }: { status: TlsStatus; canEdit: boolean }) {
  const { setAddresses } = useTlsMutations();
  const inputId = useId();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const saved = status.extraAddresses.map((a) => a.name);
  const cloudflare = status.method === 'cloudflare' ? status.domain?.domain : undefined;
  const install = status.installAddresses.filter((a) => host(a) !== 'localhost');
  const full = saved.length >= MAX_TLS_ADDRESSES;

  const save = (names: string[]) => {
    setProblem(null);
    setAddresses.mutate(names, { onSuccess: () => setName('') });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const value = clean(name);
    if (!value) return;
    if (!isDomainName(value)) return setProblem('Enter a name such as books.example.co.uk or crafty.local. IP addresses go in SITE_ADDRESS.');
    if (saved.includes(value) || install.some((a) => host(a) === value)) return setProblem(`${value} is served already.`);
    save([...saved, value]);
  };

  const noteFor = (address: string) => {
    if (host(address) === cloudflare) return "From the install's settings · on Let's Encrypt, with Cloudflare";
    if (status.localIp && host(address) === status.localIp) return "This server's IP address on its network, found each time it starts";
    return "From the install's settings (SITE_ADDRESS in .env)";
  };
  const noteForAdded = (added: string) => {
    if (added === cloudflare) return "Added here · on Let's Encrypt, with Cloudflare";
    if (status.ownCertificateAddresses.includes(added)) return status.method === 'internal' ? 'Added here' : "Added here · with the app's own certificate";
    return 'Added here · your uploaded certificate covers it';
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-ink">Addresses</h3>
      <ul className="divide-y divide-line rounded-lg border border-line-strong">
        {install.map((address) => (
          <Row key={`install-${address}`} name={address} note={noteFor(address)} />
        ))}
        {saved.map((added) => (
          <Row
            key={added}
            name={added}
            note={noteForAdded(added)}
            busy={setAddresses.isPending}
            onRemove={canEdit ? () => save(saved.filter((n) => n !== added)) : undefined}
          />
        ))}
        {install.length === 0 && saved.length === 0 && <li className="px-4 py-2.5 text-sm text-muted">Only localhost, on the server itself.</li>}
      </ul>

      {canEdit && (
        <form onSubmit={add} noValidate className="flex flex-wrap items-start gap-3">
          <label htmlFor={inputId} className="sr-only">
            Address to add
          </label>
          <input
            id={inputId}
            className="field min-w-0 flex-1 basis-56"
            value={name}
            placeholder="books.example.co.uk"
            autoComplete="off"
            spellCheck={false}
            disabled={full}
            onChange={(e) => {
              setProblem(null);
              setAddresses.reset();
              setName(e.target.value);
            }}
          />
          <Button type="submit" busy={setAddresses.isPending} disabled={!name.trim() || full}>
            <Plus className="size-4" aria-hidden />
            Add address
          </Button>
        </form>
      )}
      {(problem ?? setAddresses.error?.message) && <Alert>{problem ?? setAddresses.error?.message}</Alert>}
      {setAddresses.isSuccess && status.restartCommand && (
        <Alert tone="info">
          The app changes over once its web server is restarted: <code className="font-mono break-all text-ink">{status.restartCommand}</code>
        </Alert>
      )}
      <p className="text-sm text-muted">
        Addresses added here are served whichever certificate method is in use: with the app's own certificate unless that method covers them. Devices find each
        one only once your DNS, or your router, points it at this server{status.serverIp ? <> (<span className="font-mono text-ink">{status.serverIp}</span>)</> : ''}.
        {full ? ` That's the most there can be (${MAX_TLS_ADDRESSES}).` : ''}
      </p>
    </div>
  );
}

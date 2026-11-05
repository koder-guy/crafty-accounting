import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Cpu, FileText, KeyRound } from 'lucide-react';
import {
  CLAUDE_MODELS,
  DEFAULT_FILENAME_PATTERN,
  EXAMPLE_INVOICE,
  FILENAME_FIELDS,
  filenamePatternProblem,
  formatDisplayDate,
  invoiceFilename,
  MAX_FILENAME_PATTERN_LENGTH,
  type ClaudeStatus,
} from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useCanEdit, useClaude, useClaudeMutations } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';

/** Entering a key: Anthropic checks it before it's saved, and it's never shown again in full. */
function KeyForm({ replacing, onDone }: { replacing: boolean; onDone: () => void }) {
  const { save } = useClaudeMutations();
  const [key, setKey] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    save.mutate({ apiKey: key.trim() }, { onSuccess: () => { setKey(''); onDone(); } });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <Field
        label={replacing ? 'New API key' : 'Anthropic API key'}
        htmlFor="claude-key"
        error={save.error?.message}
        hint={
          <>
            Create one in the{' '}
            <a href={CONSOLE_KEYS} target="_blank" rel="noreferrer" className="text-accent-soft underline-offset-2 hover:underline">
              Anthropic Console
            </a>
            . Anthropic bills it per use, separately from a Claude subscription.
          </>
        }
      >
        <input
          id="claude-key"
          type="password"
          className="field font-mono"
          value={key}
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!key.trim()}>
          {save.isPending ? 'Checking key…' : 'Save key'}
        </Button>
        {replacing && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function KeyCard({ status, canEdit }: { status: ClaudeStatus; canEdit: boolean }) {
  const { removeKey } = useClaudeMutations();
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="size-5 text-accent-soft" />}
        title="API key"
        action={status.configured ? <Badge tone="ok">Connected</Badge> : <Badge>Not set</Badge>}
      />
      <div className="space-y-5 px-5 pb-6 sm:px-6">
        {status.configured && (
          <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
            <dt className="text-muted">Key</dt>
            <dd className="font-mono break-all">{status.keyHint}</dd>
            {status.keyAddedAt && (
              <>
                <dt className="text-muted">Added</dt>
                <dd>
                  {formatDisplayDate(status.keyAddedAt.slice(0, 10))}
                  {status.keyAddedBy && ` by ${status.keyAddedBy}`}
                </dd>
              </>
            )}
          </dl>
        )}

        {saved && <Alert tone="success" onDismiss={() => setSaved(false)}>Key checked with Anthropic and saved. Read an invoice now shows when you add an expense.</Alert>}

        {!canEdit ? (
          !status.configured && <p className="text-sm text-muted">Ask an editor to add an API key.</p>
        ) : !status.configured || replacing ? (
          <KeyForm
            replacing={replacing}
            onDone={() => {
              setSaved(true);
              setReplacing(false);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => { setSaved(false); setReplacing(true); }}>
              Replace key
            </Button>
            <Button type="button" variant="softDanger" onClick={() => setConfirmRemove(true)}>
              Remove key
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the API key?"
        confirmLabel="Remove"
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setSaved(false);
          await removeKey.mutateAsync();
        }}
      >
        <p>Read an invoice won't be offered until a key is added again. The key stays valid at Anthropic; delete it in the Anthropic Console if you no longer need it.</p>
      </ConfirmDialog>
    </Card>
  );
}

function ModelCard({ status, canEdit }: { status: ClaudeStatus; canEdit: boolean }) {
  const { save } = useClaudeMutations();
  // Shows the choice straight away while it saves.
  const chosen = save.isPending ? save.variables?.model : status.model;
  return (
    <Card>
      <CardHeader icon={<Cpu className="size-5 text-accent-soft" />} title="Model" />
      <fieldset className="space-y-2 px-5 pb-6 sm:px-6" disabled={!canEdit || save.isPending}>
        <legend className="sr-only">The Claude model that reads invoices</legend>
        {CLAUDE_MODELS.map((m) => (
          <label
            key={m.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors has-disabled:cursor-default ${
              chosen === m.id ? 'border-accent-soft/60 bg-accent-bg' : 'border-line-strong bg-surface-2/60 hover:border-accent-soft/40'
            }`}
          >
            <input
              type="radio"
              name="claude-model"
              value={m.id}
              checked={chosen === m.id}
              onChange={() => save.mutate({ model: m.id })}
              className="mt-1 size-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-ink">{m.name}</span>
              <span className="block text-sm text-muted">{m.note}</span>
            </span>
          </label>
        ))}
        {save.error && <Alert>{save.error.message}</Alert>}
        <p className="pt-1 text-xs text-faint">Prices are rough guides for a one or two page invoice, at Anthropic's prices.</p>
      </fieldset>
    </Card>
  );
}

/** How documents Claude read are named, from fields of what it read. Other documents keep their names. */
function FilenameCard({ status, canEdit }: { status: ClaudeStatus; canEdit: boolean }) {
  const { save } = useClaudeMutations();
  // Null until something is typed, so a change saved elsewhere shows.
  const [draft, setDraft] = useState<string | null>(null);
  const pattern = draft ?? status.filenamePattern;
  const setPattern = (value: string) => setDraft(value === status.filenamePattern ? null : value);
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const problem = filenamePatternProblem(pattern);
  const changed = pattern !== status.filenamePattern;
  const example = problem ? null : invoiceFilename(EXAMPLE_INVOICE, '.pdf', pattern);
  const withoutInvoice = problem ? null : invoiceFilename({ ...EXAMPLE_INVOICE, invoiceNumber: '', orderNumber: '' }, '.pdf', pattern);

  // Where the caret goes once an added field is in the box.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [pattern]);

  // A field goes where the caret is, or at the end when the box isn't being edited.
  const insert = (token: string) => {
    const el = input.current;
    const text = `{${token}}`;
    const focused = el !== null && document.activeElement === el;
    const start = focused ? (el.selectionStart ?? pattern.length) : pattern.length;
    const end = focused ? (el.selectionEnd ?? pattern.length) : pattern.length;
    caret.current = start + text.length;
    setPattern(pattern.slice(0, start) + text + pattern.slice(end));
    setSaved(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !changed) return;
    save.mutate({ filenamePattern: pattern }, { onSuccess: () => { setDraft(null); setSaved(true); } });
  };

  return (
    <Card>
      <CardHeader icon={<FileText className="size-5 text-accent-soft" />} title="Document names" />
      <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6">
        <p className="text-sm text-muted">
          An invoice or receipt Claude reads is attached to the expense under a name made from what it read. Documents added any other way keep their own names, and any name can still be changed before saving.
        </p>
        <Field
          label="Pattern"
          htmlFor="claude-filename-pattern"
          error={problem ?? save.error?.message}
          hint="A field the invoice doesn't show is left out, along with the text just before it. The file's extension is added at the end."
        >
          <input
            ref={input}
            id="claude-filename-pattern"
            className="field font-mono"
            value={pattern}
            maxLength={MAX_FILENAME_PATTERN_LENGTH}
            readOnly={!canEdit}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setPattern(e.target.value);
              setSaved(false);
            }}
          />
        </Field>

        {canEdit && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Add a field</p>
            <div className="flex flex-wrap gap-2">
              {FILENAME_FIELDS.map((f) => (
                <button
                  key={f.token}
                  type="button"
                  // Keeps the caret in the pattern, so the field goes where it was.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(f.token)}
                  title={`{${f.token}}, such as ${f.example}`}
                  className="rounded-md border border-line-strong bg-surface-2/60 px-2.5 py-1 text-xs text-ink transition-colors hover:border-accent-soft/60 hover:bg-accent-bg"
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {example && (
          <dl className="space-y-1 rounded-lg border border-line-strong bg-surface-2/60 px-4 py-3 text-sm">
            <dt className="text-muted">For example</dt>
            <dd className="font-mono break-all">{example}</dd>
            {withoutInvoice && withoutInvoice !== example && (
              <>
                <dt className="pt-2 text-muted">Without an invoice number</dt>
                <dd className="font-mono break-all">{withoutInvoice}</dd>
              </>
            )}
          </dl>
        )}

        {saved && !changed && <Alert tone="success" onDismiss={() => setSaved(false)}>Saved. Invoices read from now on are named this way.</Alert>}

        {canEdit && (
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="primary" busy={save.isPending} disabled={!!problem || !changed}>
              Save pattern
            </Button>
            {changed && (
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Undo changes
              </Button>
            )}
            {pattern !== DEFAULT_FILENAME_PATTERN && (
              <Button type="button" variant="ghost" onClick={() => { setPattern(DEFAULT_FILENAME_PATTERN); setSaved(false); }}>
                Use the default
              </Button>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

export function ClaudeSettings() {
  const { data: status, isLoading, error } = useClaude();
  const canEdit = useCanEdit();
  return (
    <div className="space-y-6">
      <SettingsHeading
        title="Claude Integration"
        description="Let Claude read invoices and receipts and fill in new expenses for you to check. Each invoice read is sent to Anthropic."
      />
      {isLoading ? (
        <Spinner />
      ) : error || !status ? (
        <Alert>{error?.message ?? 'Could not load the Claude settings'}</Alert>
      ) : (
        <>
          <KeyCard status={status} canEdit={canEdit} />
          <ModelCard status={status} canEdit={canEdit} />
          <FilenameCard status={status} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}

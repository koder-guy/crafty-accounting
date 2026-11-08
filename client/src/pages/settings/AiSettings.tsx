import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Cpu, FileText, KeyRound, Sparkles } from 'lucide-react';
import {
  AI_PROVIDER_INFO,
  AI_PROVIDERS,
  DEFAULT_FILENAME_PATTERN,
  EXAMPLE_INVOICE,
  FILENAME_FIELDS,
  filenamePatternProblem,
  formatDisplayDate,
  invoiceFilename,
  MAX_FILENAME_PATTERN_LENGTH,
  type AiProvider,
  type AiStatus,
} from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useAi, useAiMutations, useCanEdit } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

/** The radio cards for providers and models. */
const optionClass = (chosen: boolean) =>
  `flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors has-disabled:cursor-default ${
    chosen ? 'border-accent-soft/60 bg-accent-bg' : 'border-line-strong bg-surface-2/60 hover:border-accent-soft/40'
  }`;

/** Which AI reads documents. Each keeps its own key and model, so switching back loses neither. */
function ProviderCard({ status, canEdit }: { status: AiStatus; canEdit: boolean }) {
  const { save } = useAiMutations();
  // Shows the choice straight away while it saves.
  const chosen = save.isPending ? save.variables?.provider : status.provider;
  return (
    <Card>
      <CardHeader icon={<Sparkles className="size-5 text-accent-soft" />} title="AI provider" />
      <fieldset className="space-y-2 px-5 pb-6 sm:px-6" disabled={!canEdit || save.isPending}>
        <legend className="sr-only">The AI that reads documents</legend>
        {AI_PROVIDERS.map((p) => {
          const info = AI_PROVIDER_INFO[p];
          return (
            <label key={p} className={optionClass(chosen === p)}>
              <input
                type="radio"
                name="ai-provider"
                value={p}
                checked={chosen === p}
                onChange={() => save.mutate({ provider: p })}
                className="mt-1 size-4 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{info.name}</span>
                  <span className="text-sm text-muted">by {info.company}</span>
                  {status.providers[p].configured && <Badge tone="ok">Key saved</Badge>}
                </span>
                <span className="block text-sm text-muted">{info.privacy}</span>
              </span>
            </label>
          );
        })}
        {save.error && <Alert>{save.error.message}</Alert>}
      </fieldset>
    </Card>
  );
}

/** Entering a key: the provider checks it before it's saved, and it's never shown again in full. */
function KeyForm({ provider, replacing, onDone }: { provider: AiProvider; replacing: boolean; onDone: () => void }) {
  const { saveProvider } = useAiMutations();
  const info = AI_PROVIDER_INFO[provider];
  const [key, setKey] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    saveProvider.mutate({ provider, apiKey: key.trim() }, { onSuccess: () => { setKey(''); onDone(); } });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <Field
        label={replacing ? 'New API key' : `${info.company} API key`}
        htmlFor="ai-key"
        error={saveProvider.error?.message}
        hint={
          <>
            Create one in{' '}
            <a href={info.console.url} target="_blank" rel="noreferrer" className="text-accent-soft underline-offset-2 hover:underline">
              {info.console.name}
            </a>
            . {info.billing}
          </>
        }
      >
        <input
          id="ai-key"
          type="password"
          className="field font-mono"
          value={key}
          placeholder={info.keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" busy={saveProvider.isPending} disabled={!key.trim()}>
          {saveProvider.isPending ? 'Checking key…' : 'Save key'}
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

function KeyCard({ provider, status, canEdit }: { provider: AiProvider; status: AiStatus; canEdit: boolean }) {
  const { removeKey } = useAiMutations();
  const info = AI_PROVIDER_INFO[provider];
  const key = status.providers[provider];
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="size-5 text-accent-soft" />}
        title={`${info.name} API key`}
        action={key.configured ? <Badge tone="ok">Connected</Badge> : <Badge>Not set</Badge>}
      />
      <div className="space-y-5 px-5 pb-6 sm:px-6">
        {key.configured && (
          <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
            <dt className="text-muted">Key</dt>
            <dd className="font-mono break-all">{key.keyHint}</dd>
            {key.keyAddedAt && (
              <>
                <dt className="text-muted">Added</dt>
                <dd>
                  {formatDisplayDate(key.keyAddedAt.slice(0, 10))}
                  {key.keyAddedBy && ` by ${key.keyAddedBy}`}
                </dd>
              </>
            )}
          </dl>
        )}

        {saved && <Alert tone="success" onDismiss={() => setSaved(false)}>Key checked with {info.company} and saved. Scan documents on the Expenses page can read invoices now.</Alert>}

        {!canEdit ? (
          !key.configured && <p className="text-sm text-muted">Ask an editor to add an API key.</p>
        ) : !key.configured || replacing ? (
          <KeyForm
            provider={provider}
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
          await removeKey.mutateAsync(provider);
        }}
      >
        <p>
          Documents won't be read with {info.name} until a key is added again. The key stays valid at {info.company}; delete it in {info.console.name} if you no longer
          need it.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function ModelCard({ provider, status, canEdit }: { provider: AiProvider; status: AiStatus; canEdit: boolean }) {
  const { saveProvider } = useAiMutations();
  const info = AI_PROVIDER_INFO[provider];
  // Shows the choice straight away while it saves.
  const chosen = saveProvider.isPending ? saveProvider.variables?.model : status.providers[provider].model;
  return (
    <Card>
      <CardHeader icon={<Cpu className="size-5 text-accent-soft" />} title="Model" />
      <fieldset className="space-y-2 px-5 pb-6 sm:px-6" disabled={!canEdit || saveProvider.isPending}>
        <legend className="sr-only">The {info.name} model that reads invoices</legend>
        {info.models.map((m) => (
          <label key={m.id} className={optionClass(chosen === m.id)}>
            <input
              type="radio"
              name="ai-model"
              value={m.id}
              checked={chosen === m.id}
              onChange={() => saveProvider.mutate({ provider, model: m.id })}
              className="mt-1 size-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-ink">{m.name}</span>
              <span className="block text-sm text-muted">{m.note}</span>
            </span>
          </label>
        ))}
        {saveProvider.error && <Alert>{saveProvider.error.message}</Alert>}
        <p className="pt-1 text-xs text-faint">Prices are rough guides for a one or two page invoice, at {info.company}'s prices.</p>
      </fieldset>
    </Card>
  );
}

/** How documents the AI read are named, from fields of what it read. Other documents keep their names. */
function FilenameCard({ status, canEdit }: { status: AiStatus; canEdit: boolean }) {
  const { save } = useAiMutations();
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
          An invoice or receipt the AI reads is attached to the expense under a name made from what it read. Documents added any other way keep their own names, and any name can still be changed before saving.
        </p>
        <Field
          label="Pattern"
          htmlFor="ai-filename-pattern"
          error={problem ?? save.error?.message}
          hint="A field the invoice doesn't show is left out, along with the text just before it. The file's extension is added at the end."
        >
          <input
            ref={input}
            id="ai-filename-pattern"
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

export function AiSettings() {
  const { data: status, isLoading, error } = useAi();
  const canEdit = useCanEdit();
  return (
    <div className="space-y-6">
      <SettingsHeading
        title="AI Document Scanning"
        description="Let an AI, Claude or Gemini, read invoices and receipts and fill in new expenses for you to check. Each document read is sent to the provider chosen."
      />
      {isLoading ? (
        <Spinner />
      ) : error || !status ? (
        <Alert>{error?.message ?? 'Could not load the AI settings'}</Alert>
      ) : (
        <>
          <ProviderCard status={status} canEdit={canEdit} />
          {/* Remounted per provider, so a half-typed key or a notice doesn't carry over. */}
          <KeyCard key={`key-${status.provider}`} provider={status.provider} status={status} canEdit={canEdit} />
          <ModelCard key={`model-${status.provider}`} provider={status.provider} status={status} canEdit={canEdit} />
          <FilenameCard status={status} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}

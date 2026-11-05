import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, FileUp, TriangleAlert, Upload } from 'lucide-react';
import { displayTaxYear, formatGBP, type ImportSummary } from '@crafty/shared';
import { useImportTransactions, type Kind } from '../lib/queries';
import { SubmittedFiguresNotice } from './SubmittedFiguresNotice';
import { Alert, Button } from './ui';

const transactions = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'transaction' : 'transactions'}`;
const PAGE: Record<Kind, string> = { incomes: 'income', expenses: 'expense' };

type Stage =
  | { step: 'failed'; fileName: string; message: string }
  | { step: 'preview'; fileName: string; file: unknown; summary: ImportSummary }
  | { step: 'done'; fileName: string; summary: ImportSummary };

/**
 * Imports transactions from a JSON export (this page's Export → JSON, from this
 * install or another), after showing what it would add.
 */
export function ImportButton({ kind, iconOnly = false }: { kind: Kind; iconOnly?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { run, preview } = useImportTransactions(kind);
  const [stage, setStage] = useState<Stage | null>(null);

  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    const fileName = chosen.name;
    let file: unknown;
    try {
      file = JSON.parse(await chosen.text());
    } catch {
      setStage({ step: 'failed', fileName, message: `This isn't a JSON file. Choose one saved from Export → JSON on the ${kind === 'incomes' ? 'Income' : 'Expenses'} page.` });
      return;
    }
    try {
      setStage({ step: 'preview', fileName, file, summary: await preview.mutateAsync(file) });
    } catch (err) {
      setStage({ step: 'failed', fileName, message: (err as Error).message });
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          void choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        busy={preview.isPending}
        aria-label={iconOnly ? 'Import' : undefined}
        title={iconOnly ? 'Import' : undefined}
        className={iconOnly ? 'size-9 shrink-0 !p-0' : ''}
      >
        {!preview.isPending && <Upload className="size-4" aria-hidden />}
        {!iconOnly && 'Import'}
      </Button>
      <ImportDialog
        kind={kind}
        stage={stage}
        busy={run.isPending}
        onClose={() => {
          setStage(null);
          run.reset();
        }}
        onImport={async () => {
          if (stage?.step !== 'preview') return;
          const summary = await run.mutateAsync(stage.file);
          setStage({ step: 'done', fileName: stage.fileName, summary });
        }}
        error={run.error?.message ?? null}
      />
    </>
  );
}

function ImportDialog({
  kind,
  stage,
  busy,
  error,
  onClose,
  onImport,
}: {
  kind: Kind;
  stage: Stage | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onImport: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Kept while the dialog closes, so its content doesn't vanish first.
  const [shown, setShown] = useState(stage);
  if (stage && stage !== shown) setShown(stage);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (stage && !dialog.open) {
      dialog.showModal();
      contentRef.current?.focus();
    } else if (!stage && dialog.open) {
      dialog.close();
    }
  }, [stage]);

  let icon: ReactNode = <FileUp className="size-5" aria-hidden />;
  let tone = 'bg-accent-bg text-accent-soft';
  let title = '';
  let body: ReactNode = null;
  let canImport = false;

  if (shown?.step === 'failed') {
    title = `Can’t import ${shown.fileName}`;
    icon = <TriangleAlert className="size-5" aria-hidden />;
    tone = 'bg-out-bg text-out-soft';
    body = <p>{shown.message}</p>;
  } else if (shown?.step === 'done') {
    const { summary } = shown;
    title = `Imported ${transactions(summary.adding)}`;
    icon = <CircleCheck className="size-5" aria-hidden />;
    tone = 'bg-ok/10 text-in-soft';
    body = (
      <>
        <p>
          {transactions(summary.adding)} totalling <strong className="text-ink">{formatGBP(summary.addingPence)}</strong> from {shown.fileName}{' '}
          {summary.adding === 1 ? 'is' : 'are'} now in your books.
        </p>
        {summary.documentsLeftOut > 0 && <p>Attach their documents by editing each transaction.</p>}
      </>
    );
  } else if (shown?.step === 'preview') {
    const { summary, fileName } = shown;
    if (summary.problems.length > 0) {
      title = `Can’t import ${fileName}`;
      icon = <TriangleAlert className="size-5" aria-hidden />;
      tone = 'bg-out-bg text-out-soft';
      body = (
        <>
          <p>Nothing has been imported. Fix {summary.problems.length === 1 ? 'this' : 'these'} in the file, or add the missing tax years or categories, then try again.</p>
          <ul className="max-h-64 list-disc space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-2 py-2 pr-3 pl-7 text-ink">
            {summary.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </>
      );
    } else if (summary.adding === 0) {
      title = 'Nothing new to import';
      body = (
        <p>
          {summary.inFile === 0
            ? `${fileName} has no ${PAGE[kind]} transactions in it.`
            : `Your books already have ${summary.inFile === 1 ? 'the transaction' : `all ${transactions(summary.inFile)}`} in ${fileName}.`}
        </p>
      );
    } else {
      canImport = true;
      title = `Import ${transactions(summary.adding)}?`;
      const years = summary.years.map((y) => `${displayTaxYear(y.label)}${summary.years.length > 1 ? ` (${y.adding})` : ''}`);
      body = (
        <>
          <p>
            {transactions(summary.adding)} totalling <strong className="text-ink">{formatGBP(summary.addingPence)}</strong> from {fileName} will be added to{' '}
            {years.length === 1 ? `tax year ${years[0]}` : `tax years ${years.slice(0, -1).join(', ')} and ${years.at(-1)}`}, by their dates.
          </p>
          {summary.alreadyThere > 0 && (
            <p>
              {transactions(summary.alreadyThere)} your books already have (same date, {kind === 'incomes' ? 'description' : 'payee'}, amount and payment method){' '}
              will be left out.
            </p>
          )}
          {summary.documentsLeftOut > 0 && (
            <Alert tone="info">
              The file names {summary.documentsLeftOut === 1 ? 'a document' : `${summary.documentsLeftOut} documents`}, but an export doesn’t hold the files
              themselves, so they won’t be attached.
            </Alert>
          )}
          {summary.years.map((y) => (
            <SubmittedFiguresNotice key={y.taxYearId} taxYearId={y.taxYearId} dates={[y.firstDate]} />
          ))}
        </>
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[calc(100%-32px)] max-w-xl rounded-[var(--radius-card)] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div ref={contentRef} tabIndex={-1} className="p-6 outline-none">
        <div className="flex gap-4">
          <div className={`flex size-10 shrink-0 items-center justify-center rounded-full ${tone}`}>{icon}</div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold break-words">
              {title}
            </h2>
            <div className="mt-2 space-y-2 text-sm text-muted">{body}</div>
          </div>
        </div>

        {error && canImport && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          {canImport ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" variant="primary" onClick={() => void onImport().catch(() => {})} busy={busy}>
                Import
              </Button>
            </>
          ) : (
            <Button type="button" variant="primary" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}

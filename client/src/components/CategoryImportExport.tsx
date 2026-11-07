import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, Download, FileUp, TriangleAlert, Upload } from 'lucide-react';
import type { CategoryImportSummary } from '@crafty/shared';
import { CATEGORIES_EXPORT_URL, useCategoryMutations } from '../lib/queries';
import { Alert, Badge, Button, buttonClasses } from './ui';

const categories = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'category' : 'categories'}`;
const ICON_ONLY = 'size-9 shrink-0 !p-0';

type Stage =
  | { step: 'failed'; fileName: string; message: string }
  | { step: 'preview'; fileName: string; file: unknown; summary: CategoryImportSummary }
  | { step: 'done'; fileName: string; summary: CategoryImportSummary };

/** Downloads the custom categories as JSON, for importing into another install. */
export function ExportCategoriesButton({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="inline-flex" title="Nothing to export">
        <button type="button" disabled aria-label="Export" className={`${buttonClasses()} ${ICON_ONLY}`}>
          <Download className="size-4" aria-hidden />
        </button>
      </span>
    );
  }
  return (
    <a href={CATEGORIES_EXPORT_URL} download aria-label="Export" title="Export" className={`${buttonClasses()} ${ICON_ONLY}`}>
      <Download className="size-4" aria-hidden />
    </a>
  );
}

/** Imports custom categories from a JSON export (this one's Export, from this install or another), after showing what it would add. */
export function ImportCategoriesButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { importRun: run, importPreview: preview } = useCategoryMutations();
  const [stage, setStage] = useState<Stage | null>(null);

  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    const fileName = chosen.name;
    let file: unknown;
    try {
      file = JSON.parse(await chosen.text());
    } catch {
      setStage({ step: 'failed', fileName, message: 'This isn’t a JSON file. Choose one saved with Export on this page.' });
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
      <Button type="button" onClick={() => inputRef.current?.click()} busy={preview.isPending} aria-label="Import" title="Import" className={ICON_ONLY}>
        {!preview.isPending && <Upload className="size-4" aria-hidden />}
      </Button>
      <ImportDialog
        stage={stage}
        busy={run.isPending}
        error={run.error?.message ?? null}
        onClose={() => {
          setStage(null);
          run.reset();
        }}
        onImport={async () => {
          if (stage?.step !== 'preview') return;
          const summary = await run.mutateAsync(stage.file);
          setStage({ step: 'done', fileName: stage.fileName, summary });
        }}
      />
    </>
  );
}

function CategoryList({ summary }: { summary: CategoryImportSummary }) {
  return (
    <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface-2">
      {summary.adding.map((c) => (
        <li key={`${c.type}|${c.name}`} className="flex items-center justify-between gap-3 py-2 pr-6 pl-3">
          <span className="min-w-0">
            <span className="font-medium text-ink">{c.name}</span>
            <span className="block truncate text-xs text-faint">→ {c.mapsTo}</span>
          </span>
          <Badge tone={c.type === 'INCOME' ? 'ok' : 'out'}>{c.type === 'INCOME' ? 'Income' : 'Expense'}</Badge>
        </li>
      ))}
    </ul>
  );
}

function ImportDialog({
  stage,
  busy,
  error,
  onClose,
  onImport,
}: {
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
    title = `Imported ${categories(shown.summary.adding.length)}`;
    icon = <CircleCheck className="size-5" aria-hidden />;
    tone = 'bg-ok/10 text-in-soft';
    body = <p>They’re now in the category menus, grouped under the MTD category each maps to.</p>;
  } else if (shown?.step === 'preview') {
    const { summary, fileName } = shown;
    if (summary.problems.length > 0) {
      title = `Can’t import ${fileName}`;
      icon = <TriangleAlert className="size-5" aria-hidden />;
      tone = 'bg-out-bg text-out-soft';
      body = (
        <>
          <p>Nothing has been imported. Fix {summary.problems.length === 1 ? 'this' : 'these'} in the file, or rename your own categories, then try again.</p>
          <ul className="max-h-64 list-disc space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-2 py-2 pr-3 pl-7 text-ink">
            {summary.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </>
      );
    } else if (summary.adding.length === 0) {
      title = 'Nothing new to import';
      body = (
        <p>
          {summary.inFile === 0
            ? `${fileName} has no custom categories in it.`
            : `You already have ${summary.inFile === 1 ? 'the category' : `all ${categories(summary.inFile)}`} in ${fileName}.`}
        </p>
      );
    } else {
      canImport = true;
      title = `Import ${categories(summary.adding.length)}?`;
      body = (
        <>
          <p>From {fileName}, each mapped to the MTD category shown:</p>
          <CategoryList summary={summary} />
          {summary.alreadyThere > 0 && <p>{categories(summary.alreadyThere)} you already have will be left out.</p>}
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

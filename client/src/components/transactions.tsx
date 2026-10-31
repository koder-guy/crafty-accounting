// Building blocks shared by the Incoming and Outgoing pages.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { Camera, ChevronDown, ChevronsUpDown, ChevronUp, Download, Eye, FileText, Paperclip, Pencil, Search, Trash2 } from 'lucide-react';
import {
  MAX_DOCUMENTS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  photoFilename,
  startYearFromLabel,
  taxMonths,
  type Category,
  type CategoryType,
  type PaymentMethod,
  type TaxYear,
  type TransactionDocument,
  type TransactionFilters,
} from '@crafty/shared';
import { documentUrl } from '../lib/api';
import { dismissWithoutClicking } from '../lib/menus';
import { compressPhoto } from '../lib/compressPhoto';
import { useCanEdit } from '../lib/queries';
import { CameraDialog, useCameraOption } from './CameraDialog';
import { CategoryOptions } from './CategoryOptions';
import { IconButton, PaymentBadge, SOFT_DANGER } from './ui';

// ---- Filters (kept in the URL so they survive navigation) ----

const FILTER_KEYS = ['search', 'taxMonth', 'categoryId', 'paymentMethod'] as const;

export function useTransactionFilters(taxYear: TaxYear | null) {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? '';
  const startYear = taxYear && startYearFromLabel(taxYear.label);
  const months = useMemo(() => (startYear ? taxMonths(startYear) : []), [startYear]);
  // Kept as an index, so the same month stays picked when the tax year changes.
  const month = params.get('taxMonth') ? months[Number(params.get('taxMonth'))] : undefined;

  const filters: TransactionFilters | null = useMemo(() => {
    if (!taxYear) return null;
    const method = params.get('paymentMethod');
    return {
      taxYearId: taxYear.id,
      search: params.get('search') || undefined,
      from: month?.startDate,
      to: month?.endDate,
      categoryId: Number(params.get('categoryId')) || undefined,
      paymentMethod: PAYMENT_METHODS.includes(method as PaymentMethod) ? (method as PaymentMethod) : undefined,
    };
  }, [params, taxYear, month]);

  const set = (key: (typeof FILTER_KEYS)[number], value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const active = FILTER_KEYS.some((k) => params.get(k));
  return { filters, months, month, get, set, active };
}

/** The text search, then the payment method, category and tax month menus. */
export function FilterBar({
  filterState,
  categories,
  type,
}: {
  filterState: ReturnType<typeof useTransactionFilters>;
  categories: Category[];
  type: CategoryType;
}) {
  const { months, month, get, set } = filterState;
  const [search, setSearch] = useState(get('search'));
  const first = useRef(true);

  // Debounce typing into the search box.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => set('search', search.trim()), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <div className="grid gap-3 border-b border-line px-5 pb-5 sm:grid-cols-2 sm:px-6 xl:flex">
      <div className="relative xl:w-64">
        <label htmlFor="f-search" className="sr-only">
          Search
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          id="f-search"
          type="search"
          className="field pl-9"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <FilterSelect label="Payment method" className="xl:w-44" value={get('paymentMethod')} onChange={(v) => set('paymentMethod', v)}>
        <option value="">All payment types</option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Category" className="min-w-0 xl:w-72" value={get('categoryId')} onChange={(v) => set('categoryId', v)}>
        <option value="">All categories</option>
        <CategoryOptions categories={categories} type={type} />
      </FilterSelect>
      <FilterSelect label="Tax month" tooltip={month?.range} className="xl:w-44" value={get('taxMonth')} onChange={(v) => set('taxMonth', v)}>
        <option value="">All tax months</option>
        {months.map((m) => (
          <option key={m.index} value={m.index}>
            {m.name}
          </option>
        ))}
      </FilterSelect>
    </div>
  );
}

function FilterSelect({
  label,
  tooltip = label,
  value,
  onChange,
  className = '',
  children,
}: {
  label: string;
  tooltip?: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <select
      aria-label={label}
      title={tooltip}
      className={`field ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

// ---- Sorting ----

export type SortDir = 'asc' | 'desc';

export function useSort<T, K extends string>(rows: T[] | undefined, accessors: Record<K, (row: T) => string | number>, initial: NoInfer<K>) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>({ key: initial, dir: 'desc' });
  const sorted = useMemo(() => {
    if (!rows) return [];
    const get = accessors[sort.key];
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key: K) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === initial ? 'desc' : 'asc' }));
  return { sorted, sort, toggle };
}

export function SortTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: K;
  sort: { key: K; dir: SortDir };
  onSort: (key: K) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-4 py-3 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-ink ${active ? 'text-ink' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        <Icon className="size-3.5" aria-hidden />
      </button>
    </th>
  );
}

export function RowActions({ viewTo, editTo, onDelete }: { viewTo: string; editTo: string; onDelete: () => void }) {
  const canEdit = useCanEdit();
  return (
    <div className="flex justify-end gap-0.5">
      <IconLink to={viewTo} label="View">
        <Eye className="size-4" />
      </IconLink>
      {canEdit && (
        <>
          <IconLink to={editTo} label="Edit">
            <Pencil className="size-4" />
          </IconLink>
          <IconButton label="Delete" tone="danger" onClick={onDelete}>
            <Trash2 className="size-4" />
          </IconButton>
        </>
      )}
    </div>
  );
}

function IconLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft"
    >
      {children}
    </Link>
  );
}

export function ExportCsvButton({ href }: { href: string }) {
  return (
    <a
      href={href}
      download
      className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-3.5 py-2 text-sm font-medium whitespace-nowrap text-ink transition-colors hover:border-accent-soft/60 hover:text-white"
    >
      <Download className="size-4" aria-hidden />
      Export CSV
    </a>
  );
}

/** "its attached document" / "its 3 attached documents", for delete confirmations. */
export const attachedDocuments = (count: number) => (count === 1 ? 'its attached document' : `its ${count} attached documents`);

/** The documents on a transaction page, each a download link. */
export function DocumentLinks({ documents }: { documents: TransactionDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {documents.map((d) => (
        <li key={d.id}>
          <a href={documentUrl(d.filename, true)} className="inline-flex items-center gap-1.5 break-all text-accent-soft hover:underline">
            <Download className="size-4 shrink-0" aria-hidden />
            {d.filename}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** One transaction on a phone, where the table's columns don't fit: tap to open it. */
export function TransactionCard({
  to,
  title,
  sub,
  amount,
  amountClass,
  method,
  documents,
}: {
  to: string;
  title: string;
  sub: string;
  amount: string;
  amountClass: string;
  method: PaymentMethod;
  documents: TransactionDocument[];
}) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/60">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium text-ink">
            <span className="truncate">{title}</span>
            <DocIndicator documents={documents} />
          </div>
          <div className="truncate text-xs text-muted">{sub}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`tabular font-semibold ${amountClass}`}>{amount}</span>
          <PaymentBadge method={method} />
        </div>
      </Link>
    </li>
  );
}

export function DocIndicator({ documents }: { documents: TransactionDocument[] }) {
  if (documents.length === 0) return null;
  const label = documents.length === 1 ? `Document: ${documents[0].filename}` : `${documents.length} documents`;
  return <Paperclip className="inline size-3.5 shrink-0 text-accent-soft" aria-label={label} />;
}

// Same box and hover as a row's action icons; the negative margin keeps the row height unchanged.
const paperclipBox =
  '-my-2 inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-accent-soft transition-colors hover:bg-accent-bg hover:text-accent-soft';

/**
 * A paperclip (with a count if there are several) that opens a menu of the transaction's documents,
 * each one a download. The menu is drawn over the page (so the table's
 * scrolling can't clip it) and closes on a click elsewhere, Esc, or scrolling.
 */
function DocumentMenu({ documents }: { documents: TransactionDocument[] }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (refocus = false) => {
    setAnchor(null);
    setPosition(null);
    if (refocus) buttonRef.current?.focus();
  };

  // Below the button (or above it near the bottom of the window), kept on screen.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const gap = 4;
    const margin = 8;
    const below = anchor.bottom + gap + menu.offsetHeight <= window.innerHeight - margin;
    setPosition({
      top: below ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - menu.offsetHeight),
      left: Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - menu.offsetWidth)),
    });
  }, [anchor]);

  // Once it's placed (and visible), start keyboard users on the first document.
  const placed = position !== null;
  useEffect(() => {
    if (placed) menuRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    if (!anchor) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) dismissWithoutClicking(e, () => close());
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
      }
    };
    const onMove = () => close();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [anchor]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={documents.length === 1 ? '1 document' : `${documents.length} documents`}
        title={documents.length === 1 ? documents[0].filename : `${documents.length} documents`}
        className={`${paperclipBox} ${anchor ? 'bg-accent-bg' : ''}`}
        onClick={() => (anchor ? close() : setAnchor(buttonRef.current!.getBoundingClientRect()))}
      >
        <Paperclip className="size-4" aria-hidden />
        {documents.length > 1 && <span className="tabular text-xs">{documents.length}</span>}
      </button>
      {anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Download a document"
            // Clicks inside mustn't reach the table row (which would open the transaction).
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', top: position?.top ?? anchor.bottom + 4, left: position?.left ?? anchor.left }}
            className={`z-50 w-max max-w-80 min-w-56 rounded-lg border border-line-strong bg-surface p-1 shadow-2xl ${position ? '' : 'invisible'}`}
          >
            <div className="px-3 pt-1.5 pb-1 text-xs text-muted">Download a document</div>
            {documents.map((d) => (
              <a
                key={d.id}
                role="menuitem"
                href={documentUrl(d.filename, true)}
                download={d.filename}
                onClick={() => close(true)}
                className="flex items-start gap-2 rounded-md px-3 py-2 text-sm text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <Download className="mt-0.5 size-4 shrink-0 text-accent-soft" aria-hidden />
                <span className="min-w-0 break-words">{d.filename}</span>
              </a>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The paperclip in a list row: a menu of the transaction's documents to download. */
export function DocDownloadLink({ documents }: { documents: TransactionDocument[] }) {
  if (documents.length === 0) return null;
  return <DocumentMenu documents={documents} />;
}

// ---- Payment method picker ----

// Picked colours match the payment badges: cash amber, card teal, bank transfer indigo.
const PICKED: Record<PaymentMethod, string> = {
  cash: 'has-checked:border-amber-400/60 has-checked:bg-amber-400/15 has-checked:text-amber-300',
  card: 'has-checked:border-teal/60 has-checked:bg-teal-bg has-checked:text-teal',
  bank_transfer: 'has-checked:border-indigo-400/60 has-checked:bg-indigo-400/15 has-checked:text-indigo-300',
};

/** Cash / Card / Bank transfer as one tap each (a row of radio buttons); the first has id "paymentMethod" for its label. */
export function PaymentMethodPicker({ registration }: { registration: UseFormRegisterReturn }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup">
      {PAYMENT_METHODS.map((m, i) => (
        <label
          key={m}
          className={`flex cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-2 px-2 py-2.5 text-center text-sm font-medium text-muted transition-colors hover:text-ink has-focus-visible:ring-2 has-focus-visible:ring-accent-soft ${PICKED[m]}`}
        >
          <input type="radio" value={m} id={i === 0 ? 'paymentMethod' : undefined} className="sr-only" {...registration} />
          {PAYMENT_METHOD_LABELS[m]}
        </label>
      ))}
    </div>
  );
}

// ---- Documents ----

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';
const ALLOWED = /\.(pdf|jpe?g|png|webp|heic|heif)$/i;

export function documentProblem(name: string): string | null {
  if (!ALLOWED.test(name)) return 'Only PDF and image files (JPG, PNG, WebP, HEIC) can be attached';
  if (name.startsWith('.') || /[\\/]/.test(name) || name.includes('..')) {
    return 'Rename the file: it must not start with a dot or contain slashes or ".."';
  }
  if (name.length > 200) return 'Rename the file: the name must be 200 characters or fewer';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'Rename the file: the name contains control characters';
  if (name !== name.trim()) return 'Rename the file: the name must not start or end with spaces';
  return null;
}

const asPhoto = (file: File) => new File([file], photoFilename(file), { type: file.type, lastModified: file.lastModified });

// What an iPhone calls every photo taken from the file picker, which would clash with the last one.
const CAMERA_DEFAULT_NAME = /^image\.\w+$/i;

const fileExtension = (name: string) => /\.[^.]+$/.exec(name)?.[0] ?? '';

// A File's name can't change, so renaming makes a new File. This keeps its row and the name to go
// back to if the box is cleared.
const newFileInfo = new WeakMap<File, { key: number; firstName: string }>();
let nextFileKey = 0;
function fileInfo(file: File) {
  let info = newFileInfo.get(file);
  if (!info) {
    info = { key: nextFileKey++, firstName: file.name };
    newFileInfo.set(file, info);
  }
  return info;
}
function renamedFile(file: File, name: string) {
  const renamed = new File([file], name, { type: file.type, lastModified: file.lastModified });
  newFileInfo.set(renamed, fileInfo(file));
  return renamed;
}

/** The filename a name box means: its extension is fixed, typing it is harmless, and blank is the first name. */
function nameFromDraft(file: File, draft: string) {
  const { firstName } = fileInfo(file);
  const extension = fileExtension(firstName);
  let stem = draft.trim();
  if (stem.toLowerCase().endsWith(extension.toLowerCase())) stem = stem.slice(0, stem.length - extension.length).trimEnd();
  return stem ? `${stem}${extension}` : firstName;
}

/**
 * The documents on a transaction: the ones already attached (each can be marked
 * for removal) and new files picked to add when it's saved.
 */
export function DocumentField({
  current,
  files,
  removeIds,
  onFiles,
  onRemoveIds,
  onPreparing,
  onBadNames,
}: {
  current: TransactionDocument[];
  files: File[];
  removeIds: number[];
  onFiles: (files: File[]) => void;
  onRemoveIds: (ids: number[]) => void;
  /** Photos are being compressed: saving now would leave them out. */
  onPreparing: (preparing: boolean) => void;
  /** A new document's name needs fixing before it can be saved. */
  onBadNames: (bad: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  // What's in each new document's name box, once edited; a file takes the name when all of them are valid.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const cameraOption = useCameraOption();
  const kept = current.length - removeIds.length;
  const room = MAX_DOCUMENTS - kept - files.length;
  const canAdd = room > 0 && !preparing;
  const addButton = `inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink ${
    canAdd ? 'cursor-pointer hover:border-accent-soft/60' : 'cursor-not-allowed opacity-50'
  }`;

  const choose = (chosen: File[]) => {
    if (chosen.length === 0) return;
    const taken = new Set([...current.map((d) => d.filename), ...files.map((f) => f.name)]);
    for (const file of chosen) {
      const problem = documentProblem(file.name) ?? (taken.has(file.name) ? 'A document with this name is already attached' : null);
      if (problem) return setError(`${file.name}: ${problem}`);
      taken.add(file.name);
    }
    if (chosen.length > room) return setError(`A transaction can have at most ${MAX_DOCUMENTS} documents`);
    onFiles([...files, ...chosen]);
  };
  // Compressing takes a moment, and the list can change meanwhile.
  const chooseLatest = useRef(choose);
  chooseLatest.current = choose;

  const add = async (picked: File[], isPhoto: (file: File) => boolean) => {
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
    if (photoInputRef.current) photoInputRef.current.value = '';
    if (!picked.some(isPhoto)) return choose(picked);
    setPreparing(true);
    onPreparing(true);
    const prepared: File[] = [];
    for (const file of picked) prepared.push(isPhoto(file) ? asPhoto(await compressPhoto(file)) : file);
    setPreparing(false);
    onPreparing(false);
    chooseLatest.current(prepared);
  };

  const newNames = files.map((file) => {
    const draft = drafts[fileInfo(file).key];
    return draft === undefined ? file.name : nameFromDraft(file, draft);
  });
  const nameProblems = newNames.map((name, i) => {
    const problem = documentProblem(name);
    if (problem) return problem.replace('Rename the file: it', 'The name').replace('Rename the file: the name', 'The name');
    const clash = current.some((d) => d.filename === name) || newNames.some((other, j) => j !== i && other === name);
    return clash ? 'A document with this name is already attached' : null;
  });
  const badNames = nameProblems.some(Boolean);

  useEffect(() => {
    onBadNames(badNames);
    if (!badNames && newNames.some((name, i) => name !== files[i].name)) {
      onFiles(files.map((file, i) => (newNames[i] === file.name ? file : renamedFile(file, newNames[i]))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badNames, newNames.join('/')]);

  const toggleRemove = (docId: number) =>
    onRemoveIds(removeIds.includes(docId) ? removeIds.filter((x) => x !== docId) : [...removeIds, docId]);

  return (
    <div>
      <ul className="divide-y divide-line rounded-lg border border-dashed border-line-strong bg-surface-2/60">
        {current.map((doc) => {
          const removing = removeIds.includes(doc.id);
          return (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <FileText className="size-5 shrink-0 text-faint" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                {removing ? (
                  <span className="break-all text-muted line-through">{doc.filename}</span>
                ) : (
                  <a href={documentUrl(doc.filename)} target="_blank" rel="noreferrer" className="break-all text-accent-soft hover:underline">
                    {doc.filename}
                  </a>
                )}
                {removing && <span className="ml-2 text-xs text-out-soft">Removed when you save</span>}
              </div>
              <button
                type="button"
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  removing ? 'border border-line-strong bg-surface text-ink hover:border-accent-soft/60' : SOFT_DANGER
                }`}
                onClick={() => toggleRemove(doc.id)}
              >
                {removing ? 'Keep' : 'Remove'}
              </button>
            </li>
          );
        })}
        {files.map((file, i) => {
          const { key, firstName } = fileInfo(file);
          const extension = fileExtension(firstName);
          const problem = nameProblems[i];
          return (
            <li key={key} className="px-4 py-2.5">
              <div className="flex items-center gap-3">
                <FileText className="size-5 shrink-0 text-accent-soft" aria-hidden />
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                  <input
                    aria-label={`Name for ${firstName}`}
                    aria-invalid={problem ? true : undefined}
                    autoComplete="off"
                    className="field min-w-0 flex-1 py-1.5"
                    value={drafts[key] ?? file.name.slice(0, file.name.length - extension.length)}
                    onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                    onBlur={() => {
                      if (drafts[key] !== undefined) setDrafts({ ...drafts, [key]: newNames[i].slice(0, newNames[i].length - extension.length) });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                  />
                  <span className="shrink-0 text-muted">{extension}</span>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent-soft/60"
                  onClick={() => onFiles(files.filter((_, j) => j !== i))}
                >
                  Undo
                </button>
              </div>
              {problem && <p className="mt-1 ml-8 text-xs text-out-soft">{problem}</p>}
            </li>
          );
        })}
        <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="min-w-max flex-1 text-sm text-muted">
            {preparing
              ? 'Preparing photo…'
              : current.length === 0 && files.length === 0
              ? 'No documents attached'
              : `${kept + files.length} of ${MAX_DOCUMENTS} documents`}
          </span>
          {cameraOption === 'phone' && (
            <>
              <input
                ref={photoInputRef}
                id="document-photo"
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={!canAdd}
                onChange={(e) => add([...(e.target.files ?? [])], () => true)}
              />
              <label htmlFor="document-photo" className={addButton}>
                <Camera className="size-4" aria-hidden />
                Take photo
              </label>
            </>
          )}
          {(cameraOption === 'webcam' || cameraOption === 'needsHttps') && (
            <button type="button" className={addButton} disabled={!canAdd} onClick={() => setCameraOpen(true)}>
              <Camera className="size-4" aria-hidden />
              Take photo
            </button>
          )}
          <input
            ref={inputRef}
            id="document"
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            disabled={!canAdd}
            onChange={(e) => add([...(e.target.files ?? [])], (f) => CAMERA_DEFAULT_NAME.test(f.name))}
          />
          <label htmlFor="document" className={addButton}>
            {current.length || files.length ? 'Add more' : 'Choose files'}
          </label>
        </li>
      </ul>
      {error && <p className="mt-1.5 text-xs text-out-soft">{error}</p>}
      {cameraOpen && <CameraDialog onPhoto={(photo) => add([photo], () => true)} onClose={() => setCameraOpen(false)} />}
    </div>
  );
}

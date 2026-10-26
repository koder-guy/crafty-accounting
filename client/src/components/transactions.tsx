// Building blocks shared by the Incoming and Outgoing pages.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronDown, ChevronsUpDown, ChevronUp, Download, Eye, FileText, Paperclip, Pencil, Search, Trash2 } from 'lucide-react';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type Category,
  type CategoryType,
  type PaymentMethod,
  type TaxYear,
  type TransactionFilters,
} from '@crafty/shared';
import { documentUrl } from '../lib/api';
import { CategoryOptions } from './CategoryOptions';
import { Button, IconButton } from './ui';

// ---- Filters (kept in the URL so they survive navigation) ----

const FILTER_KEYS = ['search', 'categoryId', 'paymentMethod'] as const;

export function useTransactionFilters(taxYear: TaxYear | null) {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? '';

  const filters: TransactionFilters | null = useMemo(() => {
    if (!taxYear) return null;
    const method = params.get('paymentMethod');
    return {
      taxYearId: taxYear.id,
      search: params.get('search') || undefined,
      categoryId: Number(params.get('categoryId')) || undefined,
      paymentMethod: PAYMENT_METHODS.includes(method as PaymentMethod) ? (method as PaymentMethod) : undefined,
    };
  }, [params, taxYear]);

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
  return { filters, get, set, active };
}

/** Category and payment method menus, then the text search on the right. */
export function FilterBar({
  filterState,
  categories,
  type,
}: {
  filterState: ReturnType<typeof useTransactionFilters>;
  categories: Category[];
  type: CategoryType;
}) {
  const { get, set } = filterState;
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
    <div className="flex flex-col gap-3 border-b border-line px-5 pb-5 sm:flex-row sm:justify-end sm:px-6">
      <FilterSelect label="Category" className="sm:w-72" value={get('categoryId')} onChange={(v) => set('categoryId', v)}>
        <option value="">All categories</option>
        <CategoryOptions categories={categories} type={type} />
      </FilterSelect>
      <FilterSelect label="Payment method" className="sm:w-44" value={get('paymentMethod')} onChange={(v) => set('paymentMethod', v)}>
        <option value="">All payment types</option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </FilterSelect>
      <div className="relative sm:w-64">
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
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  className = '',
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <select
      aria-label={label}
      title={label}
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
  return (
    <div className="flex justify-end gap-0.5">
      <IconLink to={viewTo} label="View">
        <Eye className="size-4" />
      </IconLink>
      <IconLink to={editTo} label="Edit">
        <Pencil className="size-4" />
      </IconLink>
      <IconButton label="Delete" tone="danger" onClick={onDelete}>
        <Trash2 className="size-4" />
      </IconButton>
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

export function DocIndicator({ filename }: { filename: string | null }) {
  if (!filename) return null;
  return <Paperclip className="inline size-3.5 shrink-0 text-accent-soft" aria-label={`Document: ${filename}`} />;
}

/** Paperclip that downloads the attached document (for table rows that aren't links themselves). */
export function DocDownloadLink({ filename }: { filename: string | null }) {
  if (!filename) return null;
  return (
    <a
      href={documentUrl(filename, true)}
      download={filename}
      title={`Download ${filename}`}
      aria-label={`Download ${filename}`}
      // Same box and hover as the row's action icons; the negative margin keeps the row height unchanged.
      className="-my-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-accent-soft transition-colors hover:bg-accent-bg hover:text-accent-soft"
    >
      <Paperclip className="size-4" aria-hidden />
    </a>
  );
}

// ---- Payment method picker ----

export function PaymentMethodOptions() {
  return (
    <>
      <option value="">Choose…</option>
      {PAYMENT_METHODS.map((m) => (
        <option key={m} value={m}>
          {PAYMENT_METHOD_LABELS[m]}
        </option>
      ))}
    </>
  );
}

// ---- Documents ----

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';
const ALLOWED = /\.(pdf|jpe?g|png|webp|heic|heif)$/i;

export function documentProblem(file: File): string | null {
  if (!ALLOWED.test(file.name)) return 'Only PDF and image files (JPG, PNG, WebP, HEIC) can be attached';
  if (file.name.startsWith('.') || /[\\/]/.test(file.name) || file.name.includes('..')) {
    return 'Rename the file: it must not start with a dot or contain slashes or ".."';
  }
  return null;
}

/** Picks a new document, or keeps/removes the current one. */
export function DocumentField({
  current,
  file,
  remove,
  onFile,
  onRemove,
}: {
  current: string | null;
  file: File | null;
  remove: boolean;
  onFile: (file: File | null) => void;
  onRemove: (remove: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (picked: File | undefined) => {
    setError(null);
    if (!picked) return;
    const problem = documentProblem(picked);
    if (problem) {
      setError(problem);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    onFile(picked);
  };

  const showCurrent = current && !file && !remove;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface-2/60 px-4 py-3">
        <FileText className="size-5 text-faint" aria-hidden />
        <div className="min-w-0 flex-1 text-sm">
          {file ? (
            <span className="break-all text-ink">{file.name}</span>
          ) : showCurrent ? (
            <a href={documentUrl(current)} target="_blank" rel="noreferrer" className="break-all text-accent-soft hover:underline">
              {current}
            </a>
          ) : (
            <span className="text-muted">{remove ? 'Document will be removed when you save' : 'No document attached'}</span>
          )}
        </div>
        <input
          ref={inputRef}
          id="document"
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => choose(e.target.files?.[0])}
        />
        <label
          htmlFor="document"
          className="cursor-pointer rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink hover:border-accent-soft/60"
        >
          {file || showCurrent ? 'Replace' : 'Choose file'}
        </label>
        {file && (
          <Button
            type="button"
            variant="ghost"
            className="px-2 py-1.5"
            onClick={() => {
              onFile(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
          >
            Undo
          </Button>
        )}
        {!file && current && (
          <Button type="button" variant="ghost" className="px-2 py-1.5" onClick={() => onRemove(!remove)}>
            {remove ? 'Keep' : 'Remove'}
          </Button>
        )}
      </div>
      {error && <p className="mt-1.5 text-xs text-out-soft">{error}</p>}
    </div>
  );
}

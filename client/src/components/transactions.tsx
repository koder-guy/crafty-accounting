// Building blocks shared by the Incoming and Outgoing pages.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronDown, ChevronsUpDown, ChevronUp, Download, Eye, FileText, Paperclip, Pencil, Search, Trash2, X } from 'lucide-react';
import {
  parsePoundsToPence,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type Category,
  type PaymentMethod,
  type TaxYear,
  type TransactionFilters,
} from '@crafty/shared';
import { documentUrl } from '../lib/api';
import { Button, IconButton } from './ui';

// ---- Filters (kept in the URL so they survive navigation) ----

const FILTER_KEYS = ['search', 'from', 'to', 'categoryId', 'paymentMethod', 'min', 'max'] as const;

export function useTransactionFilters(taxYear: TaxYear | null) {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? '';

  const filters: TransactionFilters | null = useMemo(() => {
    if (!taxYear) return null;
    const min = parsePoundsToPence(params.get('min') ?? '');
    const max = parsePoundsToPence(params.get('max') ?? '');
    const method = params.get('paymentMethod');
    return {
      taxYearId: taxYear.id,
      search: params.get('search') || undefined,
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
      categoryId: Number(params.get('categoryId')) || undefined,
      paymentMethod: PAYMENT_METHODS.includes(method as PaymentMethod) ? (method as PaymentMethod) : undefined,
      minPence: min !== null && min >= 0 ? min : undefined,
      maxPence: max !== null && max >= 0 ? max : undefined,
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

  const clear = () => setParams({}, { replace: true });
  const active = FILTER_KEYS.some((k) => params.get(k));
  return { filters, get, set, clear, active };
}

export function FilterBar({
  filterState,
  categories,
  taxYear,
}: {
  filterState: ReturnType<typeof useTransactionFilters>;
  categories: Category[];
  taxYear: TaxYear;
}) {
  const { get, set, clear, active } = filterState;
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

  const reset = () => {
    setSearch('');
    clear();
  };

  return (
    <div className="flex flex-wrap gap-3 border-b border-line px-5 pb-5 sm:px-6 [&>*]:min-w-0">
      <div className="relative flex-[3_1_240px]">
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
      <FilterInput
        label="From date"
        type="date"
        className="flex-[1_1_150px]"
        value={get('from')}
        onChange={(v) => set('from', v)}
        min={taxYear.startDate}
        max={taxYear.endDate}
      />
      <FilterInput
        label="To date"
        type="date"
        className="flex-[1_1_150px]"
        value={get('to')}
        onChange={(v) => set('to', v)}
        min={taxYear.startDate}
        max={taxYear.endDate}
      />
      <FilterSelect label="Category" className="flex-[2_1_200px]" value={get('categoryId')} onChange={(v) => set('categoryId', v)}>
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Payment method" className="flex-[1_1_150px]" value={get('paymentMethod')} onChange={(v) => set('paymentMethod', v)}>
        <option value="">All methods</option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </FilterSelect>
      <FilterInput label="Minimum amount (£)" className="flex-[1_1_90px]" inputMode="decimal" placeholder="Min £" value={get('min')} onChange={(v) => set('min', v)} />
      <FilterInput label="Maximum amount (£)" className="flex-[1_1_90px]" inputMode="decimal" placeholder="Max £" value={get('max')} onChange={(v) => set('max', v)} />
      <Button variant="ghost" onClick={reset} disabled={!active && !search} className="flex-none">
        <X className="size-4" aria-hidden />
        Clear
      </Button>
    </div>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  className = '',
  ...props
}: { label: string; value: string; onChange: (v: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  return (
    <input
      aria-label={label}
      title={label}
      className={`field ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...props}
    />
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

// ---- Payment method picker ----

export function PaymentMethodPicker({ value, onChange }: { value: PaymentMethod | ''; onChange: (m: PaymentMethod) => void }) {
  return (
    <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-3 gap-2">
      {PAYMENT_METHODS.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
            value === m
              ? 'border-accent bg-accent-bg font-medium text-accent-soft'
              : 'border-line-strong bg-surface-2 text-muted hover:text-ink'
          }`}
        >
          {PAYMENT_METHOD_LABELS[m]}
        </button>
      ))}
    </div>
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
      <p className={`mt-1.5 text-xs ${error ? 'text-out-soft' : 'text-muted'}`}>
        {error ?? 'PDF or image. The filename is kept as it is, so it must not match a document already stored.'}
      </p>
    </div>
  );
}

export function DocumentPreview({ filename }: { filename: string }) {
  const url = documentUrl(filename);
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return <iframe src={url} title={filename} className="h-[70vh] w-full rounded-lg border border-line bg-white" />;
  }
  if (/\.(jpe?g|png|webp)$/.test(lower)) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={filename} className="max-h-[70vh] w-auto rounded-lg border border-line" />
      </a>
    );
  }
  return <p className="text-sm text-muted">This file type can't be previewed in the browser. Use Download to open it.</p>;
}

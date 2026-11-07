// Building blocks shared by the Income and Expenses pages.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useSearchParams } from 'react-router';
import {
  ArrowLeftRight,
  Banknote,
  Camera,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  CreditCard,
  Download,
  ExternalLink,
  FileBraces,
  FileSpreadsheet,
  FileText,
  NotebookPen,
  ListFilter,
  Pencil,
  Search,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
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
import { openInDocumentWindow } from '../lib/documentWindow';
import { dismissWithoutClicking } from '../lib/menus';
import { compressPhoto } from '../lib/compressPhoto';
import { CameraDialog, useCameraOption } from './CameraDialog';
import { CategoryOptions } from './CategoryOptions';
import { Button, buttonClasses, IconButton, PaymentBadge, SOFT_DANGER } from './ui';

// ---- Filters (kept in the URL so they survive navigation) ----

const FILTER_KEYS = ['search', 'taxMonth', 'categoryId', 'paymentMethod'] as const;

const TABLE_SEARCH_PREFIX = 'crafty.tableSearch.';

/**
 * The Income or Expenses table as it was last left in this tab (filters and page),
 * for links and saves that go back to it.
 */
export function tableUrl(path: '/income' | '/expenses'): string {
  try {
    return path + (sessionStorage.getItem(TABLE_SEARCH_PREFIX + path) ?? '');
  } catch {
    return path;
  }
}

export function useTransactionFilters(taxYear: TaxYear | null) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  useEffect(() => {
    try {
      sessionStorage.setItem(TABLE_SEARCH_PREFIX + location.pathname, location.search);
    } catch {
      // Blocked storage: going back opens the table unfiltered.
    }
  }, [location.pathname, location.search]);
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
        // Nothing changed (such as the search box settling on load): keep the page too.
        if ((prev.get(key) ?? '') === value) return prev;
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        // A different set of rows starts again from its first page.
        next.delete('page');
        return next;
      },
      { replace: true },
    );

  /** Every filter back to all, and the table back to its first page. */
  const clearAll = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of FILTER_KEYS) next.delete(k);
        next.delete('page');
        return next;
      },
      { replace: true },
    );

  const active = FILTER_KEYS.some((k) => params.get(k));
  return { filters, months, month, get, set, clearAll, active };
}

/** The text search, then the payment method, category and tax month menus, and Clear all. */
export function FilterBar({
  filterState,
  categories,
  type,
  id,
  shown = true,
}: {
  filterState: ReturnType<typeof useTransactionFilters>;
  categories: Category[];
  type: CategoryType;
  /** For the FilterToggle that shows and hides it. */
  id?: string;
  shown?: boolean;
}) {
  const { months, month, get, set, clearAll, active } = filterState;
  const [search, setSearch] = useState(get('search'));
  // Skips the search effect on load and after Clear all, which has already emptied it in the URL.
  // (Running it then would write back the filters from before the clear, as its `set` can be from that render.)
  const skipSearchEffect = useRef(true);

  // Debounce typing into the search box.
  useEffect(() => {
    if (skipSearchEffect.current) {
      skipSearchEffect.current = false;
      return;
    }
    const timer = setTimeout(() => set('search', search.trim()), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    // The line under it stays when the filters are hidden, to separate the header from the table.
    <div className="border-b border-line">
      <div id={id} hidden={!shown} className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-6 xl:flex">
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
          {/* The picked month shows its dates in the closed menu; the rest stay as names. */}
          {months.map((m) => (
            <option key={m.index} value={m.index}>
              {m.index === month?.index ? m.shortRange : m.name}
            </option>
          ))}
        </FilterSelect>
        <span className="hidden h-6 w-px shrink-0 self-center bg-line-strong xl:block" aria-hidden />
        <Button
          className="justify-self-start"
          disabled={!active && !search}
          onClick={() => {
            if (search) {
              skipSearchEffect.current = true;
              setSearch('');
            }
            clearAll();
          }}
        >
          Clear all
        </Button>
      </div>
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

const FILTERS_PREFIX = 'crafty.filters.';

/** Whether a table's filters are showing: hidden at first, then remembered per table for this browser tab (sessionStorage). */
export function useFiltersShown(table: string) {
  const [shown, setShown] = useState(() => {
    try {
      return sessionStorage.getItem(FILTERS_PREFIX + table) === 'shown';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(FILTERS_PREFIX + table, shown ? 'shown' : 'hidden');
    } catch {
      // Blocked storage: it just isn't remembered.
    }
  }, [table, shown]);
  return [shown, setShown] as const;
}

/** Icon-only, bordered button that shows and hides a FilterBar; marked while hidden filters are in use. */
export function FilterToggle({
  shown,
  onToggle,
  controls,
  active,
}: {
  shown: boolean;
  onToggle: () => void;
  controls: string;
  active: boolean;
}) {
  const label = shown ? 'Hide filters' : active ? 'Show filters (filters in use)' : 'Show filters';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={shown}
      aria-controls={controls}
      aria-label={label}
      title={label}
      className={`relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
        shown
          ? 'border-accent-soft/60 bg-accent-bg text-accent-soft'
          : 'border-line-strong bg-surface-2 text-muted hover:border-accent-soft/60 hover:text-white'
      }`}
    >
      <ListFilter className="size-4" aria-hidden />
      {!shown && active && <span className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-surface bg-out" aria-hidden />}
    </button>
  );
}

const SORT_PREFIX = 'crafty.sort.';

/**
 * Sorts a table's rows by the column chosen, which this browser remembers under
 * `storageKey` (localStorage), so the table opens sorted the same way next time.
 */
export function useSort<T, K extends string>(
  rows: T[] | undefined,
  accessors: Record<K, (row: T) => string | number>,
  initial: NoInfer<K>,
  storageKey: string,
) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_PREFIX + storageKey) ?? 'null') as { key?: unknown; dir?: unknown } | null;
      if (saved && typeof saved.key === 'string' && saved.key in accessors && (saved.dir === 'asc' || saved.dir === 'desc')) {
        return { key: saved.key as K, dir: saved.dir };
      }
    } catch {
      // Unreadable or blocked storage: use the default.
    }
    return { key: initial, dir: 'desc' };
  });
  useEffect(() => {
    try {
      localStorage.setItem(SORT_PREFIX + storageKey, JSON.stringify(sort));
    } catch {
      // Blocked storage: the sort just isn't remembered.
    }
  }, [storageKey, sort]);
  const sorted = useMemo(() => {
    if (!rows) return [];
    const get = accessors[sort.key];
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      // Blanks (such as no invoice number) stay at the bottom whichever way round.
      if (va === '' || vb === '') return va === vb ? 0 : va === '' ? 1 : -1;
      // Numbers within text by value, so INV-9 comes before INV-10.
      const cmp =
        typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
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
      className={`px-4 py-3 font-medium whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
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

/** Edit and Delete at the end of an Income or Expenses row, for editors. Clicking the row (or its description) opens it. */
export function RowActions({ editTo, onDelete }: { editTo: string; onDelete: () => void }) {
  return (
    <div className="flex justify-end gap-0.5">
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

export type ExportFormat = 'csv' | 'json';

const EXPORT_FORMATS: { format: ExportFormat; label: string; hint: string; icon: LucideIcon }[] = [
  { format: 'csv', label: 'CSV', hint: 'For a spreadsheet', icon: FileSpreadsheet },
  { format: 'json', label: 'JSON', hint: 'Full detail, for other software', icon: FileBraces },
];

/**
 * The Export button: a menu of the formats to download, each a link to `href(format)`.
 * Drawn over the page, right-aligned under the button (or above it near the bottom
 * of the window), and closed by a click elsewhere, Esc, Tab or scrolling.
 */
export function ExportMenu({
  href,
  iconOnly = false,
  count,
  noun = ['transaction', 'transactions'],
}: {
  href: (format: ExportFormat) => string;
  iconOnly?: boolean;
  /** How many rows the export holds, shown under the title when known. */
  count?: number;
  noun?: [singular: string, plural: string];
}) {
  // Nothing to export: greyed out, with the reason on hover.
  const empty = count === 0;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = () => setAnchor(buttonRef.current!.getBoundingClientRect());
  const close = (refocus = false) => {
    setAnchor(null);
    setPosition(null);
    if (refocus) buttonRef.current?.focus();
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const gap = 4;
    const margin = 8;
    const below = anchor.bottom + gap + menu.offsetHeight <= window.innerHeight - margin;
    setPosition({
      top: below ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - menu.offsetHeight),
      left: Math.max(margin, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - margin - menu.offsetWidth)),
    });
  }, [anchor]);

  // Once it's placed (and visible), start keyboard users on the first format.
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
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const focus = (i: number) => items[(i + items.length) % items.length]?.focus({ preventScroll: true });
      if (e.key === 'Escape' || e.key === 'Tab') {
        // Escape would also leave a form (useLeaveGuard) unless handled here.
        if (e.key === 'Escape') e.preventDefault();
        close(e.key === 'Escape');
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focus(at + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focus(e.key === 'Home' ? 0 : items.length - 1);
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
      <span className="inline-flex" title={empty ? 'Nothing to export' : undefined}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={() => (anchor ? close() : open())}
        onKeyDown={(e) => {
          if (!anchor && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            open();
          }
        }}
        disabled={empty}
        aria-label={iconOnly ? 'Export' : undefined}
        title={empty ? undefined : iconOnly ? 'Export' : undefined}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border bg-surface-2 text-sm font-medium whitespace-nowrap text-ink transition-colors hover:border-accent-soft/60 hover:text-white disabled:pointer-events-none disabled:opacity-50 ${
          iconOnly ? 'size-9 shrink-0' : 'px-3.5 py-2'
        } ${anchor ? 'border-accent-soft/60 text-white' : 'border-line-strong'}`}
      >
        <Download className="size-4" aria-hidden />
        {!iconOnly && (
          <>
            Export
            <ChevronDown className={`size-4 text-muted transition-transform ${anchor ? 'rotate-180' : ''}`} aria-hidden />
          </>
        )}
      </button>
      </span>
      {anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Export as"
            style={{ position: 'fixed', top: position?.top ?? anchor.bottom + 4, left: position?.left ?? anchor.left }}
            className={`z-50 w-max min-w-56 rounded-lg border border-line-strong bg-surface p-1 shadow-2xl ${position ? '' : 'invisible'}`}
          >
            {/* The menu's own label says this to screen readers. */}
            <div className="mb-1 border-b border-line px-2.5 pt-1.5 pb-2" aria-hidden>
              <div className="text-sm font-semibold text-ink">Export</div>
              {count !== undefined && (
                <div className="text-xs text-muted">
                  {count} {count === 1 ? noun[0] : noun[1]} to export
                </div>
              )}
            </div>
            {EXPORT_FORMATS.map(({ format, label, hint, icon: Icon }) => (
              <a
                key={format}
                role="menuitem"
                href={href(format)}
                download
                onClick={() => close(true)}
                className="flex items-center gap-2.5 rounded-md py-2 pr-3 pl-2.5 text-sm text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <Icon className="size-4 shrink-0 text-accent-soft" aria-hidden />
                <span className="flex flex-col">
                  <span className="font-medium">{label}</span>
                  <span className="text-xs text-muted">{hint}</span>
                </span>
              </a>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** "its attached document" / "its 3 attached documents", for delete confirmations. */
export const attachedDocuments = (count: number) => (count === 1 ? 'its attached document' : `its ${count} attached documents`);

/**
 * The documents on a transaction page: each name with Download and Open (in the document window) buttons. A grid rather
 * than a list, so the buttons line up just past the longest name (and names wrap when space is short).
 */
export function DocumentLinks({ documents }: { documents: TransactionDocument[] }) {
  if (documents.length === 0) return null;
  const iconButton = `${buttonClasses()} size-8 shrink-0 !p-0 print:hidden`;
  return (
    <ul className="grid w-fit max-w-full grid-cols-[minmax(0,max-content)_auto_auto] items-center gap-x-2 gap-y-1.5">
      {documents.map((d) => (
        <li key={d.id} className="col-span-3 grid grid-cols-subgrid items-center">
          <span className="min-w-0 break-words pr-2">{d.filename}</span>
          <a href={documentUrl(d.filename, true)} download={d.filename} aria-label={`Download ${d.filename}`} title="Download" className={iconButton}>
            <Download className="size-4" aria-hidden />
          </a>
          <a href={documentUrl(d.filename)} target="_blank" rel="noreferrer" onClick={openInDocumentWindow} aria-label={`Open ${d.filename}`} title="Open document" className={iconButton}>
            <ExternalLink className="size-4" aria-hidden />
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
  notes,
}: {
  to: string;
  title: string;
  sub: string;
  amount: string;
  amountClass: string;
  method: PaymentMethod;
  documents: TransactionDocument[];
  notes: string | null;
}) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/60">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium text-ink">
            <span className="truncate">{title}</span>
            <NotesIndicator notes={notes} />
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

/**
 * A heading in the tables and boxes under an expanded row. Every heading's baseline sits a whole number
 * of pixels down its 16px band (`--detail-heading-baseline` in index.css), so they all line up and render alike.
 */
export function DetailHeading({ children }: { children: ReactNode }) {
  return (
    // The text is trimmed to cap height and baseline (text-box), so its bottom is the baseline: put at the
    // band's foot, then moved up to the chosen baseline.
    <span className="inline-flex h-4 align-top">
      <span className="relative top-[calc(var(--detail-heading-baseline)-16px)] self-end [text-box:trim-both_cap_alphabetic]">
        {children}
      </span>
    </span>
  );
}

/**
 * The documents under an expanded Income or Expenses row, each with Download and Open (in the document window) buttons.
 * The buttons have no border and the rows are the height of the line items table's.
 */
export function DocumentsTable({ documents }: { documents: TransactionDocument[] }) {
  if (documents.length === 0) return null;
  const iconButton =
    'inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft';
  return (
    // Boxed in a div: a table's collapsed border can't have rounded corners.
    <div className="overflow-hidden rounded-lg border border-line bg-page/40">
      <table className="w-full text-sm">
        <thead className="text-xs tracking-wide text-faint uppercase">
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-2 text-left font-medium">
              <DetailHeading>Documents</DetailHeading>
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              <DetailHeading>Actions</DetailHeading>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {documents.map((d) => (
            <tr key={d.id}>
              <td className="px-4 py-2 break-all text-ink">{d.filename}</td>
              <td className="w-px px-3 py-1 whitespace-nowrap">
                <div className="flex justify-end gap-1">
                  <a href={documentUrl(d.filename, true)} download={d.filename} aria-label={`Download ${d.filename}`} title="Download" className={iconButton}>
                    <Download className="size-4" aria-hidden />
                  </a>
                  <a href={documentUrl(d.filename)} target="_blank" rel="noreferrer" onClick={openInDocumentWindow} aria-label={`Open ${d.filename}`} title="Open document" className={iconButton}>
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A notebook and pen showing a transaction has notes: just a sign, not a control. Hovering shows the start
 * of the notes. `muted` for grey, as `DocIndicator`.
 */
export function NotesIndicator({ notes, muted = false }: { notes: string | null; muted?: boolean }) {
  const text = notes?.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const preview = text.length > 100 ? `${text.slice(0, 99).trimEnd()}…` : text;
  return (
    <span className={`inline-flex shrink-0 ${muted ? 'text-muted' : 'text-accent-soft'}`} role="img" aria-label="Has notes" title={preview}>
      <NotebookPen className="size-3.5" aria-hidden />
    </span>
  );
}

/** A transaction's notes under its expanded row, boxed like the tables above them. Nothing without notes. */
export function NotesPanel({ notes }: { notes: string | null }) {
  if (!notes?.trim()) return null;
  return (
    <section aria-label="Notes" className="rounded-lg border border-line bg-page/40 text-sm">
      <div className="border-b border-line px-4 py-2 text-xs font-medium tracking-wide text-faint uppercase">
        <DetailHeading>Notes</DetailHeading>
      </div>
      <p className="px-4 py-2 break-words whitespace-pre-wrap text-ink">{notes.trim()}</p>
    </section>
  );
}

/** A document icon showing a transaction has documents: just a sign, not a control. `muted` for grey. */
export function DocIndicator({ documents, muted = false }: { documents: TransactionDocument[]; muted?: boolean }) {
  if (documents.length === 0) return null;
  const label = documents.length === 1 ? `Document: ${documents[0].filename}` : `${documents.length} documents`;
  // "×2" after the icon when there are several, in the icon's colour.
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 ${muted ? 'text-muted' : 'text-accent-soft'}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <FileText className="size-3.5" aria-hidden />
      {documents.length > 1 && <span className="tabular text-xs" aria-hidden>×{documents.length}</span>}
    </span>
  );
}

// ---- Payment method picker ----

// Icon colours match the payment badges: cash amber, card teal, bank transfer indigo.
const PAYMENT_ICON_COLOURS: Record<PaymentMethod, string> = {
  cash: 'text-amber-300',
  card: 'text-teal',
  bank_transfer: 'text-indigo-300',
};

const PAYMENT_ICONS: Record<PaymentMethod, LucideIcon> = {
  cash: Banknote,
  card: CreditCard,
  bank_transfer: ArrowLeftRight,
};

function PaymentMethodLabel({ method }: { method: PaymentMethod }) {
  const Icon = PAYMENT_ICONS[method];
  return (
    <>
      <Icon className={`size-4 shrink-0 ${PAYMENT_ICON_COLOURS[method]}`} aria-hidden />
      {PAYMENT_METHOD_LABELS[method]}
    </>
  );
}

/**
 * Cash / Card / Bank transfer as a popup menu: a button the height of a field showing the choice,
 * which opens a list below it (or above, near the bottom of the window). Used through react-hook-form's
 * `Controller`.
 */
export function PaymentMethodPicker({
  id,
  value,
  onChange,
  onBlur,
  ref,
  invalid = false,
}: {
  id: string;
  value: PaymentMethod | '';
  onChange: (method: PaymentMethod) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${id}-list`;
  const open = () => setAnchor(buttonRef.current!.getBoundingClientRect());
  const close = (refocus = false) => {
    setAnchor(null);
    setPosition(null);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (m: PaymentMethod) => {
    onChange(m);
    close(true);
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!anchor || !list) return;
    const gap = 4;
    const margin = 8;
    const below = anchor.bottom + gap + list.offsetHeight <= window.innerHeight - margin;
    setPosition({
      top: below ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - list.offsetHeight),
      left: Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - list.offsetWidth)),
    });
  }, [anchor]);

  // Once it's placed, start on the current choice (or the first).
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    const list = listRef.current;
    (list?.querySelector<HTMLElement>('[aria-selected=true]') ?? list?.querySelector<HTMLElement>('[role=option]'))?.focus({
      preventScroll: true,
    });
  }, [placed]);

  useEffect(() => {
    if (!anchor) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!listRef.current?.contains(target) && !buttonRef.current?.contains(target)) dismissWithoutClicking(e, () => close());
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role=option]') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const focus = (i: number) => items[(i + items.length) % items.length]?.focus({ preventScroll: true });
      if (e.key === 'Escape' || e.key === 'Tab') {
        // Escape also leaves the form (useLeaveGuard) unless handled here.
        if (e.key === 'Escape') e.preventDefault();
        close(e.key === 'Escape');
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focus(at + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focus(e.key === 'Home' ? 0 : items.length - 1);
      }
    };
    const onMove = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) close();
    };
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
        ref={(el) => {
          buttonRef.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) (ref as RefObject<HTMLButtonElement | null>).current = el;
        }}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? listId : undefined}
        aria-invalid={invalid || undefined}
        onClick={() => (anchor ? close() : open())}
        onKeyDown={(e) => {
          if (!anchor && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            open();
          }
        }}
        onBlur={onBlur}
        className={`grid h-[2.375rem] w-full grid-cols-[1fr_1rem] items-center gap-2 rounded-lg border bg-surface-2 px-3.5 text-left text-sm font-medium text-ink focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none ${
          invalid ? 'border-out/70' : 'border-line-strong'
        }`}
      >
                <span className="grid">
          {(['', ...PAYMENT_METHODS] as const).map((m) => (
            <span
              key={m}
              aria-hidden={m !== value || undefined}
              className={`col-start-1 row-start-1 flex items-center gap-2 whitespace-nowrap ${m === value ? '' : 'invisible'}`}
            >
              {m ? <PaymentMethodLabel method={m} /> : <span className="text-muted">Choose…</span>}
            </span>
          ))}
        </span>
        <ChevronsUpDown className="size-4 text-muted" aria-hidden />
      </button>
      {anchor &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Payment method"
            style={{ position: 'fixed', top: position?.top ?? anchor.bottom + 4, left: position?.left ?? anchor.left, minWidth: anchor.width }}
            className={`z-50 w-max rounded-lg border border-line-strong bg-surface p-1 shadow-2xl ${position ? '' : 'invisible'}`}
          >
            {PAYMENT_METHODS.map((m) => (
              <div
                key={m}
                role="option"
                tabIndex={-1}
                aria-selected={m === value}
                onClick={() => pick(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(m);
                  }
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md py-2 pr-3 pl-2 text-sm text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <Check className={`size-4 shrink-0 text-accent-soft ${m === value ? '' : 'invisible'}`} aria-hidden />
                <PaymentMethodLabel method={m} />
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
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
function nameFromDraft(firstName: string, draft: string) {
  const extension = fileExtension(firstName);
  let stem = draft.trim();
  if (stem.toLowerCase().endsWith(extension.toLowerCase())) stem = stem.slice(0, stem.length - extension.length).trimEnd();
  return stem ? `${stem}${extension}` : firstName;
}

const withoutExtension = (name: string, extension: string) => name.slice(0, name.length - extension.length);

/** What's in an attached document's name box, by document id, once Rename is pressed. */
export type DocumentRenames = Record<number, string>;

/** The attached documents whose name boxes give a new name, as the API takes them. */
export function renamedDocuments(current: TransactionDocument[], renames: DocumentRenames) {
  return current.flatMap((doc) => {
    const draft = renames[doc.id];
    const filename = draft === undefined ? doc.filename : nameFromDraft(doc.filename, draft);
    return filename === doc.filename ? [] : [{ id: doc.id, filename }];
  });
}

/**
 * The documents on a transaction: the ones already attached (each can be
 * renamed or marked for removal) and new files picked to add when it's saved.
 */
export function DocumentField({
  current,
  files,
  removeIds,
  renames,
  onFiles,
  onRemoveIds,
  onRenames,
  onPreparing,
  onBadNames,
}: {
  current: TransactionDocument[];
  files: File[];
  removeIds: number[];
  renames: DocumentRenames;
  onFiles: (files: File[]) => void;
  onRemoveIds: (ids: number[]) => void;
  onRenames: (renames: DocumentRenames) => void;
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
  const [dragging, setDragging] = useState(false);
  // Dragging over a row inside the box leaves the box's own element, so count rather than trust each leave.
  const dragDepth = useRef(0);
  const cameraOption = useCameraOption();
  const kept = current.length - removeIds.length;
  const room = MAX_DOCUMENTS - kept - files.length;
  const canAdd = room > 0 && !preparing;
  const addButton = `inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink ${
    canAdd ? 'cursor-pointer hover:border-accent-soft/60' : 'cursor-not-allowed opacity-50'
  }`;

  const savedNames = current.map((doc) => (renames[doc.id] === undefined ? doc.filename : nameFromDraft(doc.filename, renames[doc.id])));

  const choose = (chosen: File[]) => {
    if (chosen.length === 0) return;
    const taken = new Set([...current.map((d) => d.filename), ...savedNames, ...files.map((f) => f.name)]);
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
    return draft === undefined ? file.name : nameFromDraft(fileInfo(file).firstName, draft);
  });
  // Every name the save would leave, attached documents first. Old names count as taken until the save.
  const allNames = [...savedNames, ...newNames];
  const nameProblem = (name: string, index: number, unchanged: boolean) => {
    if (unchanged) return null;
    const problem = documentProblem(name);
    if (problem) return problem.replace('Rename the file: it', 'The name').replace('Rename the file: the name', 'The name');
    const clash = current.some((d) => d.filename === name) || allNames.some((other, j) => j !== index && other === name);
    return clash ? 'A document with this name is already attached' : null;
  };
  const savedProblems = current.map((doc, i) => nameProblem(savedNames[i], i, savedNames[i] === doc.filename));
  const nameProblems = newNames.map((name, i) => nameProblem(name, current.length + i, false));
  const badNames = [...savedProblems, ...nameProblems].some(Boolean);

  useEffect(() => {
    onBadNames(badNames);
    if (!badNames && newNames.some((name, i) => name !== files[i].name)) {
      onFiles(files.map((file, i) => (newNames[i] === file.name ? file : renamedFile(file, newNames[i]))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badNames, newNames.join('/')]);

  const toggleRemove = (docId: number) =>
    onRemoveIds(removeIds.includes(docId) ? removeIds.filter((x) => x !== docId) : [...removeIds, docId]);

  // A file dropped just outside the box would otherwise open in the tab, losing the form.
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);

  const takesDrag = (e: ReactDragEvent) => e.dataTransfer.types.includes('Files') && !preparing;

  return (
    <div>
      <ul
        className={`divide-y divide-line rounded-lg border border-dashed transition-colors ${
          dragging ? 'border-accent-soft bg-accent-bg' : 'border-line-strong bg-surface-2/60'
        }`}
        onDragEnter={(e) => {
          if (!takesDrag(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!takesDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (!takesDrag(e)) return;
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={(e) => {
          dragDepth.current = 0;
          setDragging(false);
          if (!takesDrag(e)) return;
          e.preventDefault();
          void add([...e.dataTransfer.files], (f) => CAMERA_DEFAULT_NAME.test(f.name));
        }}
      >
        {current.map((doc, i) => {
          const removing = removeIds.includes(doc.id);
          const draft = renames[doc.id];
          if (draft !== undefined) {
            const extension = fileExtension(doc.filename);
            const problem = savedProblems[i];
            const stopRenaming = () => {
              const { [doc.id]: _, ...rest } = renames;
              onRenames(rest);
            };
            return (
              <li key={doc.id} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <FileText className="size-5 shrink-0 text-faint" aria-hidden />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                    <input
                      aria-label={`New name for ${doc.filename}`}
                      aria-invalid={problem ? true : undefined}
                      autoComplete="off"
                      autoFocus
                      className="field min-w-0 flex-1 py-1.5"
                      value={draft}
                      onChange={(e) => onRenames({ ...renames, [doc.id]: e.target.value })}
                      onBlur={() => onRenames({ ...renames, [doc.id]: withoutExtension(savedNames[i], extension) })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                    />
                    <span className="shrink-0 text-muted">{extension}</span>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent-soft/60"
                    onClick={stopRenaming}
                  >
                    Undo
                  </button>
                </div>
                {problem ? (
                  <p className="mt-1 ml-8 text-xs text-out-soft">{problem}</p>
                ) : (
                  savedNames[i] !== doc.filename && <p className="mt-1 ml-8 text-xs text-muted">Renamed from {doc.filename} when you save</p>
                )}
              </li>
            );
          }
          return (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <FileText className="size-5 shrink-0 text-faint" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                {removing ? (
                  <span className="break-all text-muted line-through">{doc.filename}</span>
                ) : (
                  <a href={documentUrl(doc.filename)} target="_blank" rel="noreferrer" onClick={openInDocumentWindow} className="break-all text-accent-soft hover:underline">
                    {doc.filename}
                  </a>
                )}
                {removing && <span className="ml-2 text-xs text-out-soft">Removed when you save</span>}
              </div>
              {!removing && (
                <button
                  type="button"
                  aria-label={`Rename ${doc.filename}`}
                  title="Rename"
                  className="rounded-md border border-line-strong bg-surface p-2 text-muted transition-colors hover:border-accent-soft/60 hover:text-ink"
                  onClick={() => onRenames({ ...renames, [doc.id]: withoutExtension(doc.filename, fileExtension(doc.filename)) })}
                >
                  <Pencil className="size-4" aria-hidden />
                </button>
              )}
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
                    value={drafts[key] ?? withoutExtension(file.name, extension)}
                    onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                    onBlur={() => {
                      if (drafts[key] !== undefined) setDrafts({ ...drafts, [key]: withoutExtension(newNames[i], extension) });
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
              : dragging
              ? 'Drop to add'
              : current.length === 0 && files.length === 0
              ? cameraOption === 'phone'
                ? 'No documents attached'
                : 'No documents attached: drag files here'
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

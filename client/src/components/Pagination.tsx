// Splits a long table into pages, with page buttons and a "Show" menu below it.
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const PAGE_SIZES = [10, 20, 30, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_KEY = 'crafty.pageSize';
/** The page is kept in the URL, so it survives opening a row and coming back. */
const PAGE_PARAM = 'page';

function savedPageSize(): number {
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if ((PAGE_SIZES as readonly number[]).includes(saved)) return saved;
  } catch {
    // Unreadable or blocked storage: use the default.
  }
  return DEFAULT_PAGE_SIZE;
}

/**
 * The rows for the current page. The page size is one choice for every table,
 * remembered in this browser; the page number is in the URL (`?page=`).
 * `scrollTo` is brought into view when the page changes, so the new page starts at its top.
 */
export function usePagination<T>(rows: T[], scrollTo?: RefObject<HTMLElement | null>) {
  const [params, setParams] = useSearchParams();
  const [pageSize, setPageSizeState] = useState(savedPageSize);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  // Clamped, so a deleted last row or a narrower filter never leaves an empty page.
  const page = Math.min(Math.max(1, Math.floor(Number(params.get(PAGE_PARAM))) || 1), pageCount);

  useEffect(() => {
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(pageSize));
    } catch {
      // Blocked storage: the size just isn't remembered.
    }
  }, [pageSize]);

  const setPage = (next: number, scroll = true) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next > 1) p.set(PAGE_PARAM, String(next));
        else p.delete(PAGE_PARAM);
        return p;
      },
      { replace: true },
    );
    if (scroll) scrollTo?.current?.scrollIntoView({ block: 'start' });
  };

  const setPageSize = (size: number) => {
    // Stay on the page that holds the first row now showing.
    const first = (page - 1) * pageSize;
    setPageSizeState(size);
    setPage(Math.floor(first / size) + 1, false);
  };

  const pageRows = useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);
  return { pageRows, page, pageCount, pageSize, total: rows.length, setPage, setPageSize };
}

/** Page numbers to show: always the first and last, and the current one with its neighbours; null is a gap. */
export function pageNumbers(page: number, pageCount: number): (number | null)[] {
  const shown = new Set([1, pageCount, page - 1, page, page + 1]);
  // Fill a gap of one with the page itself rather than "…".
  if (shown.has(4)) shown.add(2);
  if (shown.has(pageCount - 3)) shown.add(pageCount - 1);
  const list = [...shown].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((n, i) => {
    if (i > 0 && n - list[i - 1] > 1) out.push(null);
    out.push(n);
  });
  return out;
}

// Without a display class, so page numbers can be hidden on phones.
const pageButton =
  'h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm tabular transition-colors disabled:pointer-events-none disabled:opacity-40';

/** Below a table: which rows are showing, how many per page, and the page buttons. Hidden while everything fits on the smallest page. */
export function Pagination({ pagination, noun = 'transactions' }: { pagination: ReturnType<typeof usePagination>; noun?: string }) {
  const { page, pageCount, pageSize, total, setPage, setPageSize } = pagination;
  if (total <= PAGE_SIZES[0]) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav
      aria-label="Pages"
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line px-4 py-3 text-sm text-muted sm:px-6 print:hidden"
    >
      <div className="flex items-center gap-4">
        <span className="tabular" aria-live="polite">
          {first}–{last} of {total}
        </span>
        <label className="flex items-center gap-2">
          <span>Show</span>
          <select className="field w-auto py-1 pr-8" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="sr-only">{noun} per page</span>
        </label>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`${pageButton} inline-flex text-muted hover:bg-surface-2 hover:text-ink`}
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          {/* Phones show where they are; wider screens get the page numbers. */}
          <span className="tabular px-2 sm:hidden">
            Page {page} of {pageCount}
          </span>
          {pageNumbers(page, pageCount).map((n, i) =>
            n === null ? (
              <span key={`gap-${i}`} className="hidden px-1 text-faint sm:inline" aria-hidden>
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                onClick={() => setPage(n)}
                aria-label={`Page ${n}`}
                aria-current={n === page ? 'page' : undefined}
                className={`${pageButton} hidden sm:inline-flex ${
                  n === page ? 'bg-accent-bg font-semibold text-accent-soft' : 'text-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            className={`${pageButton} inline-flex text-muted hover:bg-surface-2 hover:text-ink`}
            onClick={() => setPage(page + 1)}
            disabled={page === pageCount}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </nav>
  );
}

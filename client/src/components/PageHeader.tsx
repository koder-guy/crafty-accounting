import { useEffect, useRef, type ReactNode } from "react";
import { businessName, displayTaxYear } from "@crafty/shared";
import { useActiveTaxYear, useBusiness } from "../lib/queries";
import { NotificationBell } from "./NotificationBell";
import { UserMenu } from "./UserMenu";

/**
 * The page title, with any section tabs below it (`tabs`). On desktop it stays pinned to the top of
 * the window while the page scrolls under it; phones keep only their top bar pinned, for room.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  tabs,
}: {
  title: string;
  /** Shown after the business's name; by default, the tax year being viewed. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  const { taxYear } = useActiveTaxYear();
  const business = useBusiness().data?.details;
  const ref = usePinnedHeight();
  return (
    <div ref={ref} className="z-20 bg-page lg:sticky lg:top-0 print:static">
      <header className="flex flex-col gap-4 border-b border-line px-4 py-5 sm:flex-row sm:items-center sm:px-8 lg:py-[18px]">
        {/* On narrow screens the title keeps some room and the page buttons wrap instead. */}
        <div className="flex min-w-0 items-center gap-4 sm:min-w-64 sm:flex-1">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight text-white">
              {title}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {business && (
                <>
                  <span className="font-medium text-ink">{businessName(business)}</span>
                  {" · "}
                </>
              )}
              {subtitle ??
                (taxYear ? (
                  <>
                    Viewing data for UK tax year{" "}
                    <span className="font-semibold text-accent-soft">
                      {displayTaxYear(taxYear.label)}
                    </span>
                  </>
                ) : (
                  "No tax year selected"
                ))}
            </p>
          </div>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end print:hidden">
            {actions}
          </div>
        )}
        {/* The bell and account menu stay top right; page buttons wrap on their own. Phones have it in the top bar instead. */}
        <div className="hidden shrink-0 items-center gap-2 lg:flex print:hidden">
          {actions && <span className="mx-1 h-6 w-px bg-line" aria-hidden />}
          <NotificationBell />
          <UserMenu />
        </div>
      </header>
      {tabs}
    </div>
  );
}

/**
 * Shares the pinned header's height as --page-header-h, so scrolling to a field or element
 * (scroll-padding-top in index.css) stops below the header instead of under it.
 */
function usePinnedHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() =>
      root.style.setProperty("--page-header-h", `${el.offsetHeight}px`),
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--page-header-h");
    };
  }, []);
  return ref;
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="space-y-6 px-4 py-6 sm:px-8 lg:py-8">{children}</div>;
}

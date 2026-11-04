import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Link, useBlocker, useNavigate } from 'react-router';
import { displayTaxYear, formatDisplayDate, isDateInTaxYear, todayIso, type TaxYear } from '@crafty/shared';
import { ConfirmDialog } from './ConfirmDialog';
import { Alert, Button } from './ui';

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </Link>
  );
}

/**
 * Keeps a form's changes from being lost by leaving it. Any way of leaving to another page (Cancel, Back, the
 * sidebar, the browser's back button) asks first while there are changes, and closing or reloading the tab gets the
 * browser's own warning. Escape leaves the form as Cancel does; the guard listens on window so that what's open over
 * the form gets the key first: a calendar or menu on document, which marks it handled, or a dialog.
 *
 * Returns the dialog to render and `leave`, for leaving without asking once the changes are saved.
 */
export function useLeaveGuard({ dirty, busy, onCancel }: { dirty: boolean; busy: boolean; onCancel: () => void }) {
  const navigate = useNavigate();
  const leaving = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.isComposing || e.defaultPrevented || busy) return;
      if (document.querySelector('dialog[open]')) return;
      // Otherwise the browser's own Escape handling closes the dialog this opens, straight away.
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const guard = (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title="Discard your changes?"
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      onConfirm={() => {
        leaving.current = true;
        blocker.proceed?.();
      }}
      onClose={() => {
        // Also called after Discard changes, once the page is already on its way.
        if (!leaving.current) blocker.reset?.();
      }}
    >
      <p>What you’ve entered on this form hasn’t been saved.</p>
    </ConfirmDialog>
  );

  const leave = useCallback(
    (to: string) => {
      leaving.current = true;
      navigate(to);
    },
    [navigate],
  );

  return { guard, leave };
}

/** react-hook-form validator for a transaction date. */
export const dateInYear = (taxYear: TaxYear) => (value: string) =>
  !value
    ? 'Date is required'
    : isDateInTaxYear(value, taxYear) ||
      `Must be within tax year ${displayTaxYear(taxYear.label)} (${formatDisplayDate(taxYear.startDate)} to ${formatDisplayDate(taxYear.endDate)})`;

export const yearRangeHint = (taxYear: TaxYear) =>
  `Tax year ${displayTaxYear(taxYear.label)}: ${formatDisplayDate(taxYear.startDate)} to ${formatDisplayDate(taxYear.endDate)}`;

/** Shown on an edit form when someone else saves the same record meanwhile. */
export function ChangedElsewhere({ by, what = 'this transaction', onLoad }: { by: string | null; what?: string; onLoad: () => void }) {
  return (
    <Alert tone="warning">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {by ?? 'Someone else'} changed {what} while you were editing. Saving would overwrite their changes, so load their version
          first.
        </span>
        <Button type="button" onClick={onLoad}>
          <RefreshCw className="size-4" aria-hidden />
          Load their version
        </Button>
      </div>
    </Alert>
  );
}

const timestamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "Jo, 3 Nov 2026, 14:05" for the Added / Last changed rows; null for records made before sign-ins. */
export const recordedBy = (name: string | null, at: string) => (name ? `${name}, ${timestamp(at)}` : null);

/**
 * The date for a duplicated transaction or trip: today if it's in the tax
 * year being added to, otherwise the original date if that is, otherwise blank.
 */
export function duplicateDate(originalDate: string, taxYear: TaxYear): string {
  const today = todayIso();
  if (isDateInTaxYear(today, taxYear)) return today;
  return isDateInTaxYear(originalDate, taxYear) ? originalDate : '';
}

/** Shown on an Add form that was filled from an existing transaction. */
export function CopiedFrom({ what, date, notCopied }: { what: string; date: string; notCopied: string }) {
  return (
    <Alert tone="success">
      Copied from <strong>{what}</strong> on {formatDisplayDate(date)}. Check the date and amounts, then add it. {notCopied}
    </Alert>
  );
}

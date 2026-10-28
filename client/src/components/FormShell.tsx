import type { ReactNode } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { displayTaxYear, formatDisplayDate, isDateInTaxYear, todayIso, type TaxYear } from '@crafty/shared';
import { Alert, Button } from './ui';

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </Link>
  );
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

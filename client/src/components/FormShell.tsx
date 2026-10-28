import type { ReactNode } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { displayTaxYear, formatDisplayDate, isDateInTaxYear, type TaxYear } from '@crafty/shared';
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

/** Shown on an edit form when someone else saves the same transaction meanwhile. */
export function ChangedElsewhere({ by, onLoad }: { by: string | null; onLoad: () => void }) {
  return (
    <Alert tone="warning">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {by ?? 'Someone else'} changed this transaction while you were editing it. Saving would overwrite their changes, so
          load their version first.
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

import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { displayTaxYear, formatDisplayDate, isDateInTaxYear, type TaxYear } from '@crafty/shared';

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

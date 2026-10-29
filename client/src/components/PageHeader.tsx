import type { ReactNode } from 'react';
import { displayTaxYear } from '@crafty/shared';
import { useActiveTaxYear } from '../lib/queries';
import { UserMenu } from './UserMenu';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  const { taxYear } = useActiveTaxYear();
  return (
    <header className="flex flex-col gap-4 border-b border-line px-4 py-5 sm:flex-row sm:items-center sm:px-8 lg:py-[18px]">
      {/* On narrow screens the title keeps some room and the page buttons wrap instead. */}
      <div className="min-w-0 sm:min-w-64 sm:flex-1">
        <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
        <p className="mt-1 text-sm text-muted">
          {subtitle ??
            (taxYear ? (
              <>
                Viewing data for UK tax year{' '}
                <span className="font-semibold text-accent-soft">{displayTaxYear(taxYear.label)}</span>
              </>
            ) : (
              'No tax year selected'
            ))}
        </p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end print:hidden">{actions}</div>}
      {/* The account menu stays top right; page buttons wrap on their own. Phones have it in the top bar instead. */}
      <div className="hidden shrink-0 items-center gap-2 lg:flex print:hidden">
        {actions && <span className="mx-1 h-6 w-px bg-line" aria-hidden />}
        <UserMenu />
      </div>
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="space-y-6 px-4 py-6 sm:px-8 lg:py-8">{children}</div>;
}

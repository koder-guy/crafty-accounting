import type { ReactNode } from 'react';
import { displayTaxYear } from '@crafty/shared';
import { useActiveTaxYear } from '../lib/queries';
import { SignOutButton } from './Layout';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  const { taxYear } = useActiveTaxYear();
  return (
    <header className="flex flex-col gap-4 border-b border-line px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:py-6">
      <div className="min-w-0">
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
      <div className={`flex flex-wrap items-center gap-2 print:hidden ${actions ? '' : 'max-lg:hidden'}`}>
        {actions}
        <div className="hidden items-center gap-2 lg:flex">
          {actions && <span className="mx-1 h-6 w-px bg-line" aria-hidden />}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="space-y-6 px-4 py-6 sm:px-8 lg:py-8">{children}</div>;
}

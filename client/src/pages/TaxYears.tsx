import { useMemo, useState } from 'react';
import { CalendarPlus, CircleCheck, Layers, Trash2 } from 'lucide-react';
import {
  displayTaxYear,
  formatDisplayDate,
  taxYearFromStartYear,
  taxYearStartYearForDate,
  todayIso,
  type TaxYear,
} from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Spinner } from '../components/ui';
import { useTaxYearMutations, useTaxYears } from '../lib/queries';

export function TaxYears() {
  const { data, isLoading } = useTaxYears();
  const { create, setActive, remove } = useTaxYearMutations();
  const currentStart = taxYearStartYearForDate(todayIso());
  const [toDelete, setToDelete] = useState<TaxYear | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const available = useMemo(() => {
    const existing = new Set(data?.taxYears.map((y) => y.label));
    const years: number[] = [];
    for (let y = currentStart + 1; y >= currentStart - 10; y--) {
      if (!existing.has(taxYearFromStartYear(y).label)) years.push(y);
    }
    return years;
  }, [data, currentStart]);

  const [startYear, setStartYear] = useState<number | ''>('');
  // Default to the current year, else the most recent past year still missing.
  const selected = startYear === '' ? (available.find((y) => y <= currentStart) ?? available[0]) : startYear;
  const preview = selected !== undefined ? taxYearFromStartYear(selected) : null;

  const createYear = () => {
    if (selected === undefined) return;
    setMessage(null);
    create.mutate(selected, {
      onSuccess: () => {
        setStartYear('');
        setMessage(`Tax year ${displayTaxYear(taxYearFromStartYear(selected).label)} created.`);
      },
    });
  };

  return (
    <>
      <PageHeader title="Tax Years Management" />
      <PageBody>
        <Card>
          <CardHeader icon={<CalendarPlus className="size-5 text-accent-soft" />} title="Create a tax year" />
          <div className="flex flex-col gap-4 px-5 pb-6 sm:flex-row sm:items-end sm:px-6">
            <div className="sm:w-64">
              <label htmlFor="start-year" className="mb-1.5 block text-sm font-medium">
                Tax year
              </label>
              <select
                id="start-year"
                className="field"
                value={selected ?? ''}
                onChange={(e) => setStartYear(Number(e.target.value))}
                disabled={available.length === 0}
              >
                {available.map((y) => (
                  <option key={y} value={y}>
                    {displayTaxYear(taxYearFromStartYear(y).label)}
                    {y === currentStart ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="flex-1 text-sm text-muted sm:pb-2.5">
              {preview
                ? `Runs from ${formatDisplayDate(preview.startDate)} to ${formatDisplayDate(preview.endDate)}.`
                : 'All recent tax years already exist.'}
            </p>
            <Button variant="primary" onClick={createYear} busy={create.isPending} disabled={!preview}>
              Create tax year
            </Button>
          </div>
          {(create.error || message) && (
            <div className="px-5 pb-5 sm:px-6">
              {create.error ? <Alert>{create.error.message}</Alert> : <Alert tone="success">{message}</Alert>}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader icon={<Layers className="size-5 text-accent-soft" />} title="Your tax years" />
          {isLoading ? (
            <Spinner />
          ) : !data || data.taxYears.length === 0 ? (
            <EmptyState title="No tax years yet">Create one above to start recording transactions.</EmptyState>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {data.taxYears.map((year) => {
                const isActive = year.id === data.activeTaxYearId;
                return (
                  <li key={year.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold text-white">{displayTaxYear(year.label)}</span>
                        {isActive && <Badge tone="accent">Active</Badge>}
                        {Number(year.label.slice(0, 4)) === currentStart && <Badge>Current</Badge>}
                      </div>
                      <p className="mt-1 text-sm text-muted">
                        {formatDisplayDate(year.startDate)} – {formatDisplayDate(year.endDate)} · {year.incomeCount} incoming ·{' '}
                        {year.expenseCount} outgoing · {year.documentCount} documents
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {!isActive && (
                        <Button onClick={() => setActive.mutate(year.id)} disabled={setActive.isPending}>
                          <CircleCheck className="size-4" aria-hidden />
                          Make active
                        </Button>
                      )}
                      <Button variant="ghost" className="hover:text-out-soft!" onClick={() => setToDelete(year)}>
                        <Trash2 className="size-4" aria-hidden />
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </PageBody>

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete tax year ${toDelete ? displayTaxYear(toDelete.label) : ''}?`}
        confirmLabel="Delete tax year"
        requireText={toDelete ? displayTaxYear(toDelete.label) : undefined}
        onClose={() => setToDelete(null)}
        onConfirm={() => remove.mutateAsync(toDelete!.id)}
      >
        {toDelete && (
          <>
            <p>
              This permanently deletes <strong className="text-ink">{toDelete.incomeCount} incoming</strong> and{' '}
              <strong className="text-ink">{toDelete.expenseCount} outgoing</strong> transactions, and{' '}
              <strong className="text-ink">{toDelete.documentCount} attached documents</strong>.
            </p>
            <p>This can't be undone. Download a backup first if you might need this data.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

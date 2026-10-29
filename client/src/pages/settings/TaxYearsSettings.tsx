import { useMemo, useState } from 'react';
import { CalendarPlus, CircleCheck, Layers, Trash2 } from 'lucide-react';
import {
  displayTaxYear,
  formatDisplayDate,
  SUBMISSION_METHOD_LABELS,
  SUBMISSION_METHODS,
  taxYearFromStartYear,
  taxYearStartYearForDate,
  todayIso,
  type SubmissionMethod,
  type TaxYear,
  type TaxYearListItem,
} from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Spinner } from '../../components/ui';
import { useCanEdit, useTaxYearMutations, useTaxYears } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

export function TaxYearsSettings() {
  const { data, isLoading } = useTaxYears();
  const canEdit = useCanEdit();
  const { create, setActive, setSubmissionMethod, remove } = useTaxYearMutations();
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
  // Default to the current year, else next year, else the most recent past year still missing.
  const suggested = [currentStart, currentStart + 1].find((y) => available.includes(y)) ?? available[0];
  const selected = startYear === '' ? suggested : startYear;
  const preview = selected !== undefined ? taxYearFromStartYear(selected) : null;

  // A new year usually goes in the same way as the latest one (once in MTD, you stay in).
  const [method, setMethod] = useState<SubmissionMethod | ''>('');
  const chosenMethod = method === '' ? (data?.taxYears[0]?.submissionMethod ?? 'self_assessment') : method;

  const createYear = () => {
    if (selected === undefined) return;
    setMessage(null);
    create.mutate({ startYear: selected, submissionMethod: chosenMethod }, {
      onSuccess: () => {
        setStartYear('');
        setMethod('');
        setMessage(`Tax year ${displayTaxYear(taxYearFromStartYear(selected).label)} created.`);
      },
    });
  };

  return (
    <>
      <div className="space-y-6">
        <SettingsHeading
          title="Tax years"
          description="Create UK tax years (6 April to 5 April), choose how each one goes to HMRC and which is active, or delete a year and everything in it."
        />
        {canEdit && (
          <Card>
            <CardHeader icon={<CalendarPlus className="size-5 text-accent-soft" />} title="Create a tax year" />
            <div className="space-y-4 px-5 pb-6 sm:px-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
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
                <div>
                  <label htmlFor="submission-method" className="mb-1.5 block text-sm font-medium">
                    Sent to HMRC by
                  </label>
                  <select
                    id="submission-method"
                    className="field"
                    value={chosenMethod}
                    onChange={(e) => setMethod(e.target.value as SubmissionMethod)}
                  >
                    <MethodOptions />
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted">
                  {preview
                    ? `Runs from ${formatDisplayDate(preview.startDate)} to ${formatDisplayDate(preview.endDate)}.`
                    : 'All recent tax years already exist.'}
                </p>
                <Button variant="primary" onClick={createYear} busy={create.isPending} disabled={!preview}>
                  Create tax year
                </Button>
              </div>
            </div>
            {(create.error || message) && (
              <div className="px-5 pb-5 sm:px-6">
                {create.error ? <Alert>{create.error.message}</Alert> : <Alert tone="success">{message}</Alert>}
              </div>
            )}
          </Card>
        )}

        <Card>
          <CardHeader icon={<Layers className="size-5 text-accent-soft" />} title="Your tax years" />
          {isLoading ? (
            <Spinner />
          ) : !data || data.taxYears.length === 0 ? (
            <EmptyState title="No tax years yet">
              {canEdit ? 'Create one above to start recording transactions.' : 'An editor needs to create one.'}
            </EmptyState>
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
                      <YearMethod
                        year={year}
                        canEdit={canEdit}
                        busy={setSubmissionMethod.isPending && setSubmissionMethod.variables?.id === year.id}
                        onChange={(submissionMethod) => setSubmissionMethod.mutate({ id: year.id, submissionMethod })}
                      />
                      {setSubmissionMethod.error && setSubmissionMethod.variables?.id === year.id && (
                        <div className="mt-2">
                          <Alert>{setSubmissionMethod.error.message}</Alert>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {!isActive && (
                        <Button onClick={() => setActive.mutate(year.id)} disabled={setActive.isPending}>
                          <CircleCheck className="size-4" aria-hidden />
                          Make active
                        </Button>
                      )}
                      {canEdit && (
                        <Button variant="softDanger" onClick={() => setToDelete(year)}>
                          <Trash2 className="size-4" aria-hidden />
                          Delete
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

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

function MethodOptions() {
  return (
    <>
      {SUBMISSION_METHODS.map((m) => (
        <option key={m} value={m}>
          {SUBMISSION_METHOD_LABELS[m]}
        </option>
      ))}
    </>
  );
}

/** How the year goes to HMRC: a choice for editors, unless it has quarterly updates, which tie it to MTD. */
function YearMethod({
  year,
  canEdit,
  busy,
  onChange,
}: {
  year: TaxYearListItem;
  canEdit: boolean;
  busy: boolean;
  onChange: (method: SubmissionMethod) => void;
}) {
  const { recorded, sent } = year.mtdUpdates;
  // Recorded ones count too: they stand for updates sent to HMRC with other software.
  const locked = year.submissionMethod === 'mtd' && recorded + sent > 0;
  const id = `method-${year.id}`;
  return (
    <div className="mt-3 flex flex-col gap-1.5 text-sm sm:flex-row sm:items-center sm:gap-3">
      {canEdit && !locked ? (
        <label htmlFor={id} className="whitespace-nowrap text-muted">
          Sent to HMRC by
        </label>
      ) : (
        <span className="whitespace-nowrap text-muted">Sent to HMRC by</span>
      )}
      {canEdit && !locked ? (
        <select
          id={id}
          className="field sm:w-60"
          value={year.submissionMethod}
          disabled={busy}
          onChange={(e) => onChange(e.target.value as SubmissionMethod)}
        >
          <MethodOptions />
        </select>
      ) : (
        <span className="font-medium whitespace-nowrap text-ink">
          {SUBMISSION_METHOD_LABELS[year.submissionMethod]}
        </span>
      )}
      {locked && <span className="text-xs text-faint">It has quarterly updates, so it stays Making Tax Digital.</span>}
    </div>
  );
}

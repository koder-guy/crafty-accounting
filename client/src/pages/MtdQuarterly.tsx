import { useEffect, useState } from 'react';
import { CalendarCheck, FileDown, FileSpreadsheet, Info } from 'lucide-react';
import {
  formatDisplayDate,
  formatGBP,
  mtdPayload,
  mtdQuarterStatus,
  todayIso,
  type Category,
  type MtdPeriodSummary,
  type MtdQuarterStatus,
  type MtdQuarterSummary,
} from '@crafty/shared';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner, type BadgeTone } from '../components/ui';
import { useActiveTaxYear, useCategories, useMtdQuarters, useMtdSubmission } from '../lib/queries';

const STATUS: Record<MtdQuarterStatus, { label: string; tone: BadgeTone }> = {
  upcoming: { label: 'Upcoming', tone: 'neutral' },
  open: { label: 'In progress', tone: 'accent' },
  due: { label: 'Due', tone: 'warn' },
  overdue: { label: 'Overdue', tone: 'out' },
  submitted: { label: 'Submitted', tone: 'ok' },
};

const shortDate = (iso: string) => formatDisplayDate(iso).replace(/ \d{4}$/, '');

/** Saves JSON as a downloaded file. */
function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The quarter containing today, or the nearest end of the year. */
function defaultQuarter(quarters: MtdQuarterSummary[], today: string): number {
  const current = quarters.find((q) => q.startDate <= today && today <= q.endDate);
  if (current) return current.quarter;
  return today < quarters[0].startDate ? 1 : 4;
}

function QuarterCard({
  q,
  status,
  selected,
  onSelect,
}: {
  q: MtdQuarterSummary;
  status: MtdQuarterStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = q.period.totals;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`card p-5 text-left transition-colors ${selected ? 'border-accent ring-1 ring-accent' : 'hover:border-line-strong'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-bold text-white">Q{q.quarter}</div>
          <div className="text-xs text-muted">
            {shortDate(q.startDate)} – {formatDisplayDate(q.endDate)}
          </div>
        </div>
        <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
      </div>
      <dl className="mt-4 space-y-1.5 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Income</dt>
          <dd className="tabular text-in-soft">{formatGBP(t.incomePence)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Expenses</dt>
          <dd className="tabular text-out-soft">{formatGBP(t.expensesPence)}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-line pt-1.5">
          <dt className="text-muted">Net profit</dt>
          <dd className="tabular font-semibold text-ink">{formatGBP(t.netProfitPence)}</dd>
        </div>
      </dl>
      <div className="mt-4 text-xs text-faint">
        {q.submission ? `Submitted ${formatDisplayDate(q.submission.submittedOn)}` : `Due by ${formatDisplayDate(q.deadline)}`}
      </div>
    </button>
  );
}

function FiguresTable({ summary, categories }: { summary: MtdPeriodSummary; categories: Category[] }) {
  const row = (c: Category, amount: number, disallowable?: number) => (
    <tr key={c.id} className={amount === 0 ? 'text-faint' : ''}>
      <td className="px-4 py-2.5 sm:pl-6">{c.name}</td>
      <td className="px-4 py-2.5 font-mono text-xs text-faint">{c.hmrcCode}</td>
      <td className="tabular px-4 py-2.5 text-right">{formatGBP(amount)}</td>
      <td className="tabular px-4 py-2.5 text-right sm:pr-6">{disallowable === undefined ? '' : formatGBP(disallowable)}</td>
    </tr>
  );
  const totalRow = (label: string, pence: number, strong = false) => (
    <tr className={strong ? 'font-semibold text-white' : 'text-ink'}>
      <td colSpan={2} className="px-4 py-2.5 sm:pl-6">
        {label}
      </td>
      <td className="tabular px-4 py-2.5 text-right">{formatGBP(pence)}</td>
      <td className="sm:pr-6" />
    </tr>
  );
  const section = (title: string) => (
    <tr className="bg-surface-2/60">
      <th colSpan={4} scope="colgroup" className="px-4 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase sm:pl-6">
        {title}
      </th>
    </tr>
  );
  const t = summary.totals;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr className="border-y border-line">
            <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Category</th>
            <th scope="col" className="px-4 py-3 text-left font-medium">MTD field</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
            <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Disallowable</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {section('Income')}
          {categories.filter((c) => c.type === 'INCOME' && !c.isCustom).map((c) => row(c, summary.periodIncome[c.hmrcCode] ?? 0))}
          {section('Expenses')}
          {categories
            .filter((c) => c.type === 'EXPENSE' && !c.isCustom)
            .map((c) =>
              row(c, summary.periodExpenses[c.hmrcCode] ?? 0, summary.periodDisallowableExpenses[`${c.hmrcCode}Disallowable`] ?? 0),
            )}
          {section('Totals')}
          {totalRow('Total income', t.incomePence)}
          {totalRow('Total expenses', t.expensesPence)}
          {totalRow('Less disallowable expenses', t.disallowablePence)}
          {totalRow('Allowable expenses', t.allowableExpensesPence)}
          {totalRow('Net profit', t.netProfitPence, true)}
        </tbody>
      </table>
    </div>
  );
}

function SubmissionPanel({ taxYearId, q }: { taxYearId: number; q: MtdQuarterSummary }) {
  const { save, clear } = useMtdSubmission(taxYearId);
  const [editing, setEditing] = useState(false);
  const [submittedOn, setSubmittedOn] = useState(todayIso());
  const [reference, setReference] = useState('');

  useEffect(() => {
    setEditing(false);
    setSubmittedOn(q.submission?.submittedOn ?? todayIso());
    setReference(q.submission?.reference ?? '');
  }, [q.quarter, q.submission?.submittedOn, q.submission?.reference]);

  const error = save.error ?? clear.error;

  if (q.submission && !editing) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink">
          Submitted to HMRC on <strong>{formatDisplayDate(q.submission.submittedOn)}</strong>
          {q.submission.reference && <span className="text-muted"> · reference {q.submission.reference}</span>}
        </p>
        <div className="flex gap-2">
          <Button onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="ghost" busy={clear.isPending} onClick={() => clear.mutate(q.quarter)}>
            Mark as not submitted
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ quarter: q.quarter, submittedOn, reference });
      }}
    >
      <Field label="Date submitted" htmlFor="submitted-on" className="sm:w-48">
        <input id="submitted-on" type="date" className="field" required value={submittedOn} onChange={(e) => setSubmittedOn(e.target.value)} />
      </Field>
      <Field label="HMRC reference (optional)" htmlFor="submission-ref" className="sm:w-64">
        <input id="submission-ref" className="field" value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Mark Q{q.quarter} as submitted
        </Button>
        {editing && (
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
      {error && <Alert>{error.message}</Alert>}
    </form>
  );
}

export function MtdQuarterly() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMtdQuarters(taxYear?.id);
  const { data: categories = [] } = useCategories();
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<'cumulative' | 'period'>('cumulative');
  const today = todayIso();

  useEffect(() => setSelected(null), [taxYear?.id]);

  const quarters = data?.quarters ?? [];
  const current = quarters.length ? (selected ?? defaultQuarter(quarters, today)) : null;
  const q = quarters.find((x) => x.quarter === current);
  const summary = q ? q[view] : null;

  const exportJson = () => {
    if (!q || !summary || !taxYear) return;
    const from = view === 'cumulative' ? taxYear.startDate : q.startDate;
    const basis = view === 'cumulative' ? 'year-to-date' : 'quarter-only';
    downloadJson(mtdPayload(summary, from, q.endDate), `crafty-mtd-${taxYear.label}-Q${q.quarter}-${basis}.json`);
  };

  return (
    <>
      <PageHeader title="MTD quarterly summaries" />
      <PageBody>
        {yearLoading || (taxYear && isLoading) ? (
          <Spinner />
        ) : !taxYear ? (
          <NoTaxYear />
        ) : error || !data || !q || !summary ? (
          <Alert>{error?.message ?? 'Could not load the quarterly summaries'}</Alert>
        ) : (
          <>
            <div className="flex gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
              <Info className="mt-0.5 size-4 shrink-0 text-accent-soft" aria-hidden />
              <p>
                Making Tax Digital quarterly updates are <span className="text-ink">cumulative</span>: each one reports the tax year so
                far. To keep a digital link, use <span className="text-ink">Export to JSON</span> on the year-to-date figures and
                import the file into your MTD bridging software rather than retyping or copying them. Sending directly to HMRC isn't
                available yet, so record each submission here to keep track.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {quarters.map((x) => (
                <QuarterCard
                  key={x.quarter}
                  q={x}
                  status={mtdQuarterStatus(x, today, x.submission !== null)}
                  selected={x.quarter === current}
                  onSelect={() => setSelected(x.quarter)}
                />
              ))}
            </div>

            <Card>
              <CardHeader
                icon={<FileSpreadsheet className="size-5 text-accent-soft" />}
                title={
                  <span>
                    Q{q.quarter} figures{' '}
                    <span className="font-normal text-muted">
                      {view === 'cumulative'
                        ? `· ${formatDisplayDate(taxYear.startDate)} to ${formatDisplayDate(q.endDate)}`
                        : `· ${formatDisplayDate(q.startDate)} to ${formatDisplayDate(q.endDate)}`}
                    </span>
                  </span>
                }
                action={
                  <Button variant="ghost" onClick={exportJson} title="Download these figures as a JSON file in MTD API format (pounds)">
                    <FileDown className="size-4" aria-hidden />
                    Export to JSON
                  </Button>
                }
              />
              <div className="px-5 pb-4 sm:px-6">
                <div role="radiogroup" aria-label="Figures to show" className="inline-flex rounded-lg border border-line-strong bg-surface-2 p-1">
                  {(
                    [
                      ['cumulative', 'Year to date (for MTD)'],
                      ['period', 'This quarter only'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={view === value}
                      onClick={() => setView(value)}
                      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                        view === value ? 'bg-accent font-medium text-white' : 'text-muted hover:text-ink'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <FiguresTable summary={summary} categories={categories} />
            </Card>

            <Card>
              <CardHeader icon={<CalendarCheck className="size-5 text-accent-soft" />} title={`Q${q.quarter} submission`} />
              <div className="px-5 pb-6 sm:px-6">
                <p className="mb-4 text-sm text-muted">Due by {formatDisplayDate(q.deadline)}.</p>
                <SubmissionPanel taxYearId={taxYear.id} q={q} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}

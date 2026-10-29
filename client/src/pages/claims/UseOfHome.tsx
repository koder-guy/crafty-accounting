import { useEffect, useState, type FormEvent } from 'react';
import { House, Info } from 'lucide-react';
import {
  formatGBP,
  MAX_MONTH_HOURS,
  todayIso,
  USE_OF_HOME_BANDS,
  useOfHomeBandLabel,
  useOfHomeClaim,
  useOfHomeNextBand,
  type UseOfHomeResponse,
} from '@crafty/shared';
import { ChangedElsewhere, recordedBy } from '../../components/FormShell';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { SentQuarterNotice } from '../../components/SentQuarterNotice';
import { Alert, Button, Card, CardHeader, Spinner } from '../../components/ui';
import { useActiveTaxYear, useCanEdit, useSaveUseOfHome, useUseOfHome } from '../../lib/queries';

const parseHours = (value: string): number | null => {
  const text = value.trim();
  if (text === '') return 0;
  if (!/^\d+$/.test(text)) return null;
  const hours = Number(text);
  return hours <= MAX_MONTH_HOURS ? hours : null;
};

const fieldsFrom = (data: UseOfHomeResponse) => data.months.map((m) => (m.hours ? String(m.hours) : ''));

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-5">
      <div className="eyebrow">{label}</div>
      <div className="tabular mt-2 text-2xl font-bold text-white">{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </Card>
  );
}

function HoursForm({ taxYearId, data }: { taxYearId: number; data: UseOfHomeResponse }) {
  const canEdit = useCanEdit();
  const save = useSaveUseOfHome();
  // The saved hours the form started from; saving is refused if they've changed since.
  const [base, setBase] = useState(data);
  const [fields, setFields] = useState(() => fieldsFrom(data));
  const parsed = fields.map(parseHours);
  const dirty = parsed.some((hours, i) => (hours ?? -1) !== base.months[i].hours);
  // Each month's claim is dated its last day.
  const changedDates = base.months.filter((m, i) => (parsed[i] ?? -1) !== m.hours).map((m) => m.endDate);
  const changedElsewhere = data.updatedAt !== base.updatedAt;

  // Someone else saved: take their hours straight away if nothing has been typed, otherwise ask.
  const load = () => {
    setBase(data);
    setFields(fieldsFrom(data));
    save.reset();
  };
  useEffect(() => {
    if (changedElsewhere && !dirty) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedElsewhere, dirty]);

  const valid = parsed.every((h) => h !== null);
  const claims = parsed.map((h) => useOfHomeClaim(h ?? 0));
  const today = todayIso();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    save.mutate(
      {
        taxYearId,
        months: parsed.map((hours, index) => ({ index, hours: hours! })).filter((m) => m.hours > 0),
        expectedUpdatedAt: base.updatedAt,
      },
      {
        onSuccess: (saved) => {
          setBase(saved);
          setFields(fieldsFrom(saved));
        },
      },
    );
  };

  return (
    <>
      {canEdit && changedElsewhere && dirty && <ChangedElsewhere by={data.updatedBy} what="these hours" onLoad={load} />}
      <Card>
        <CardHeader icon={<House className="size-5 text-accent-soft" />} title="Hours worked at home" />
        <form onSubmit={submit} noValidate>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-xs tracking-wide text-muted uppercase">
                <tr className="border-y border-line">
                  <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Month</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">Hours</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">Rate</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Claim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.months.map((m, i) => {
                  const invalid = parsed[i] === null;
                  const band = invalid ? null : useOfHomeBandLabel(parsed[i]!);
                  return (
                    <tr key={m.index} className={m.startDate > today ? 'text-faint' : ''}>
                      <td className="px-4 py-2.5 sm:pl-6">
                        <div className={`font-medium ${m.startDate > today ? '' : 'text-ink'}`}>{m.label.replace(/ (\d\d)$/, ' 20$1')}</div>
                        <div className="text-xs text-muted">{m.range}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <label htmlFor={`hours-${i}`} className="sr-only">
                          Hours worked at home, {m.range}
                        </label>
                        <input
                          id={`hours-${i}`}
                          readOnly={!canEdit}
                          inputMode="numeric"
                          placeholder="0"
                          className={`field tabular w-24 ${invalid ? 'border-out!' : ''}`}
                          aria-invalid={invalid}
                          value={fields[i]}
                          onChange={(e) => setFields(fields.map((f, j) => (j === i ? e.target.value : f)))}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-muted">
                        {invalid ? (
                          <span className="text-out-soft">Whole hours, up to {MAX_MONTH_HOURS}</span>
                        ) : (
                          <>
                            {band ?? (parsed[i]! > 0 ? 'Under 25 hours: no claim' : '—')}
                            {parsed[i]! > 0 && m.startDate <= today && <NextBandHint hours={parsed[i]!} />}
                          </>
                        )}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right sm:pr-6">
                        {claims[i] > 0 ? <span className="text-out-soft">{formatGBP(claims[i])}</span> : <span className="text-faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong font-semibold">
                  <td className="px-4 py-3 text-right text-muted sm:pl-6">Total</td>
                  <td className="tabular px-4 py-3">{parsed.reduce<number>((acc, h) => acc + (h ?? 0), 0)} hours</td>
                  <td />
                  <td className="tabular px-4 py-3 text-right text-out-soft sm:pr-6">{formatGBP(claims.reduce((a, b) => a + b, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line px-5 py-4 sm:px-6">
              <span className="mr-auto text-xs text-muted">
                {dirty
                  ? 'Not saved yet'
                  : base.updatedAt && base.updatedBy
                    ? `Last saved by ${recordedBy(base.updatedBy, base.updatedAt)}`
                    : null}
              </span>
              {dirty && (
                <Button type="button" variant="ghost" onClick={() => setFields(fieldsFrom(base))}>
                  Undo changes
                </Button>
              )}
              <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty || !valid}>
                Save hours
              </Button>
            </div>
          )}
          <SentQuarterNotice className="px-5 pb-5 sm:px-6" taxYearId={taxYearId} dates={changedDates} />
          {save.error && (
            <div className="px-5 pb-5 sm:px-6">
              <Alert>{save.error.message}</Alert>
            </div>
          )}
        </form>
      </Card>
    </>
  );
}

export function UseOfHome() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useUseOfHome(taxYear?.id);

  return (
    <>
      <div className="space-y-6">
        <SectionHeading
          title="Use of Home"
          description="Hours worked at home each month, claimed at HMRC's flat rate instead of a share of household bills."
        />
          {yearLoading || (taxYear && isLoading) ? (
            <Spinner />
          ) : !taxYear ? (
            <NoTaxYear />
          ) : error || !data ? (
            <Alert>{error?.message ?? 'Could not load use of home'}</Alert>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Stat label="Months claimed" value={String(data.totals.monthsClaimed)} sub="With 25 or more hours at home" />
                <Stat label="Hours at home" value={data.totals.hours.toLocaleString('en-GB')} sub="Business work this tax year" />
                <Stat label="Use of home claim" value={formatGBP(data.totals.claimPence)} sub="Counted as rent, rates, power and insurance" />
              </div>

              <Alert tone="warning">
                The flat rate covers the extra heating, lighting and power from working at home, so don't also claim a share of those
                household bills in Outgoing. Business calls and the business share of your broadband can still go in Outgoing.
              </Alert>

              <HoursForm key={taxYear.id} taxYearId={taxYear.id} data={data} />

              <p className="flex items-start gap-2 text-xs text-faint">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                HMRC's flat rate for working from home, for each month with 25 or more hours of business work at home:{' '}
                {[...USE_OF_HOME_BANDS]
                  .reverse()
                  .map((b) => `${b.label.toLowerCase()} ${formatGBP(b.pence).replace(/\.00$/, '')}`)
                  .join(', ')}
                . Count only time spent working on the business at home. Months run from the 6th to the 5th, like the tax year.
              </p>
            </>
          )}
      </div>
    </>
  );
}

/** "12 more hours reach £18" */
function NextBandHint({ hours }: { hours: number }) {
  const next = useOfHomeNextBand(hours);
  if (!next) return null;
  return (
    <div className="text-xs text-faint">
      {next.hoursToGo} more {next.hoursToGo === 1 ? 'hour reaches' : 'hours reach'} {formatGBP(next.pence).replace(/\.00$/, '')}
    </div>
  );
}

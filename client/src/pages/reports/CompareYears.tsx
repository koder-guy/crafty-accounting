import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowUpRight, Calculator, GitCompareArrows, Printer, TrendingUp, Wallet } from 'lucide-react';
import {
  compareSections,
  displayTaxYear,
  estimateTax,
  formatDisplayDate,
  formatGBP,
  percentChange,
  profitMargin,
  todayIso,
  type BreakdownSection,
  type ComparisonLine,
  type ComparisonPeriod,
  type TaxYear,
  type YearComparisonMonth,
  type YearComparisonResponse,
  type YearComparisonYear,
} from '@crafty/shared';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, Spinner } from '../../components/ui';
import { useActiveTaxYear, useTaxYears, useYearComparison } from '../../lib/queries';
import { printPage } from '../../lib/liveUpdates';

const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
const shortYear = (y: YearComparisonYear) => displayTaxYear(y.taxYear.label);

// ---- Changes ----

/** Whether a rise is good news: green for more income or profit, red for more spending. */
type Good = 'up' | 'down';

function toneOf(change: number, good: Good): string {
  if (change === 0) return 'text-muted';
  return change > 0 === (good === 'up') ? 'text-in-soft' : 'text-out-soft';
}

const signed = (change: number, text: string) => `${change > 0 ? '+' : change < 0 ? '−' : ''}${text}`;

/** "+£120.00 (+15%)", or "new" when there was nothing to compare with. */
function Change({ current, previous, good }: { current: number; previous: number; good: Good }) {
  const change = current - previous;
  if (change === 0) return <span className="text-muted">No change</span>;
  const pct = percentChange(current, previous);
  return (
    <span className={toneOf(change, good)}>
      {signed(change, formatGBP(Math.abs(change)))}
      {pct !== null ? ` (${signed(change, `${Math.round(Math.abs(pct) * 100)}%`)})` : previous === 0 ? ' (new)' : ''}
    </span>
  );
}

/** A change between two rates, in percentage points. */
function PointsChange({ current, previous, good }: { current: number | null; previous: number | null; good: Good }) {
  if (current === null || previous === null) return <span className="text-muted">–</span>;
  // From the rounded rates, so the change agrees with the two figures beside it.
  const change = (Math.round(current * 1000) - Math.round(previous * 1000)) / 10;
  if (change === 0) return <span className="text-muted">No change</span>;
  return <span className={toneOf(change, good)}>{signed(change, `${Math.abs(change)} points`)}</span>;
}

// ---- Headline boxes ----

function StatBox({ label, value, valueClass, compared, change }: { label: string; value: string; valueClass: string; compared: string; change: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="eyebrow">{label}</div>
      <div className={`tabular mt-2 text-2xl font-bold ${valueClass}`}>{value}</div>
      <div className="tabular mt-1 text-sm">{change}</div>
      <div className="tabular mt-1 text-xs text-muted">{compared}</div>
    </Card>
  );
}

function Headlines({ a, b }: { a: YearComparisonYear; b: YearComparisonYear }) {
  const was = shortYear(b);
  const marginA = profitMargin(a.totals.incomePence, a.totals.profitPence);
  const marginB = profitMargin(b.totals.incomePence, b.totals.profitPence);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatBox
        label="Incoming"
        value={formatGBP(a.totals.incomePence)}
        valueClass="text-in-soft"
        compared={`${was}: ${formatGBP(b.totals.incomePence)}`}
        change={<Change current={a.totals.incomePence} previous={b.totals.incomePence} good="up" />}
      />
      <StatBox
        label="Allowable outgoing"
        value={formatGBP(a.totals.allowableExpensesPence)}
        valueClass="text-out-soft"
        compared={`${was}: ${formatGBP(b.totals.allowableExpensesPence)}`}
        change={<Change current={a.totals.allowableExpensesPence} previous={b.totals.allowableExpensesPence} good="down" />}
      />
      <StatBox
        label="Profit"
        value={formatGBP(a.totals.profitPence)}
        valueClass={a.totals.profitPence < 0 ? 'text-out-soft' : 'text-white'}
        compared={`${was}: ${formatGBP(b.totals.profitPence)}`}
        change={<Change current={a.totals.profitPence} previous={b.totals.profitPence} good="up" />}
      />
      <StatBox
        label="Profit margin"
        value={marginA === null ? '–' : percent(marginA)}
        valueClass="text-white"
        compared={`${was}: ${marginB === null ? '–' : percent(marginB)}`}
        change={<PointsChange current={marginA} previous={marginB} good="up" />}
      />
    </div>
  );
}

// ---- Month by month ----

// The dashboard chart's bars. Colour follows the year here, whichever figure is showing.
const CHOSEN_YEAR = { id: 'compare-chosen-year', fill: 'url(#compare-chosen-year)', swatch: '#8559f4', glow: '#8559f480' };
const OTHER_YEAR = { id: 'compare-other-year', fill: 'url(#compare-other-year)', swatch: '#6ea0f5', glow: '#6ea0f580' };

const METRICS = {
  incomePence: { label: 'Incoming', good: 'up' },
  expensesPence: { label: 'Allowable outgoing', good: 'down' },
  profitPence: { label: 'Profit', good: 'up' },
} as const;
type Metric = keyof typeof METRICS;

interface MonthRow {
  label: string;
  a: number;
  b: number;
  months: [YearComparisonMonth, YearComparisonMonth];
}

function MonthTooltip({ active, payload, metric, names }: { active?: boolean; payload?: { payload: MonthRow }[]; metric: Metric; names: [string, string] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1.5 font-medium text-ink">{row.months[0].name}, from the 6th</div>
      {row.months.map((m, i) => (
        <div key={i} className="tabular flex justify-between gap-6 text-ink">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="size-2 rounded-sm" style={{ backgroundColor: i === 0 ? CHOSEN_YEAR.swatch : OTHER_YEAR.swatch }} />
            {names[i]}
          </span>
          <span>{formatGBP(m[metric])}</span>
        </div>
      ))}
    </div>
  );
}

function MonthByMonth({ a, b }: { a: YearComparisonYear; b: YearComparisonYear }) {
  const [metric, setMetric] = useState<Metric>('incomePence');
  const names: [string, string] = [shortYear(a), shortYear(b)];
  const rows: MonthRow[] = a.monthly.map((m, i) => ({
    label: m.name.slice(0, 3),
    a: m[metric] / 100,
    b: b.monthly[i][metric] / 100,
    months: [m, b.monthly[i]],
  }));
  return (
    <Card className="print:break-inside-avoid">
      <CardHeader
        icon={<TrendingUp className="size-5 text-accent-soft" />}
        title={`Month by month: ${METRICS[metric].label.toLowerCase()}`}
        action={
          <select aria-label="Figure to show" className="field w-auto print:hidden" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {(Object.keys(METRICS) as Metric[]).map((m) => (
              <option key={m} value={m}>
                {METRICS[m].label}
              </option>
            ))}
          </select>
        }
      />
      <div className="h-[260px] px-2 pb-4 sm:px-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 10, right: 16, left: 4, bottom: 0 }} barGap="11%">
            <defs>
              <linearGradient id={CHOSEN_YEAR.id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#a065f7" />
                <stop offset="1" stopColor="#6d4ff0" />
              </linearGradient>
              <linearGradient id={OTHER_YEAR.id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#86d6f8" />
                <stop offset="0.45" stopColor="#6ea0f5" />
                <stop offset="1" stopColor="#5b62ee" />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#8b90a3', fontSize: 12 }} axisLine={{ stroke: '#323648' }} tickLine={false} />
            <YAxis
              tick={{ fill: '#8b90a3', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={56}
              allowDecimals={false}
              tickFormatter={(v: number) => `${v < 0 ? '−' : ''}£${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : Math.abs(v)}`}
            />
            <ReferenceLine y={0} stroke="#323648" />
            <Tooltip content={<MonthTooltip metric={metric} names={names} />} cursor={{ fill: '#ffffff08' }} />
            <Legend
              iconType="square"
              wrapperStyle={{ fontSize: 13, paddingTop: 12 }}
              formatter={(value: string) => <span className="text-muted">{value === 'a' ? names[0] : names[1]}</span>}
            />
            <Bar dataKey="a" fill={CHOSEN_YEAR.fill} radius={5} maxBarSize={36} style={{ filter: `drop-shadow(0 0 3px ${CHOSEN_YEAR.glow})` }} />
            <Bar dataKey="b" fill={OTHER_YEAR.fill} radius={5} maxBarSize={36} style={{ filter: `drop-shadow(0 0 3px ${OTHER_YEAR.glow})` }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="border-t border-line text-sm print:hidden">
        <summary className="cursor-pointer px-5 py-3 text-muted hover:text-ink sm:px-6">Show as a table</summary>
        <div className="overflow-x-auto pb-2">
          <table className="w-full min-w-[420px]">
            <thead className="text-xs tracking-wide text-muted uppercase">
              <tr className="border-y border-line">
                <th scope="col" className="py-2.5 pr-3 pl-5 text-left font-medium sm:pl-6">Tax month</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">{names[0]}</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">{names[1]}</th>
                <th scope="col" className="py-2.5 pr-5 pl-3 text-right font-medium sm:pr-6">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(({ months: [ma, mb] }) => (
                <tr key={ma.index}>
                  <td className="py-2 pr-3 pl-5 text-ink sm:pl-6">{ma.name}</td>
                  <td className="tabular px-3 py-2 text-right">{formatGBP(ma[metric])}</td>
                  <td className="tabular px-3 py-2 text-right text-muted">{formatGBP(mb[metric])}</td>
                  <td className="tabular py-2 pr-5 pl-3 text-right whitespace-nowrap sm:pr-6">
                    <Change current={ma[metric]} previous={mb[metric]} good={METRICS[metric].good} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

// ---- Categories ----

/** An amount that opens Breakdown for that year, with this row's transactions showing. */
function AmountLink({ year, line, index }: { year: YearComparisonYear; line: ComparisonLine; index: 0 | 1 }) {
  const amount = line.totalsPence[index];
  const disallowable = line.disallowablePence[index];
  const query = new URLSearchParams({ from: year.from, to: year.to, show: line.show });
  return (
    <>
      {amount === 0 ? (
        <span className="text-faint">{formatGBP(0)}</span>
      ) : (
        <Link to={`/reports/breakdown?${query}`} className="hover:text-accent-soft hover:underline">
          {formatGBP(amount)}
        </Link>
      )}
      {disallowable > 0 && <div className="text-xs font-normal text-faint">{formatGBP(disallowable)} disallowable</div>}
    </>
  );
}

function CategoryRow({
  line,
  a,
  b,
  good,
  depth,
  showShare,
}: {
  line: ComparisonLine;
  a: YearComparisonYear;
  b: YearComparisonYear;
  good: Good;
  depth: 0 | 1;
  showShare: boolean;
}) {
  const share = (index: 0 | 1, y: YearComparisonYear) =>
    y.totals.incomePence > 0 ? `${Math.round((line.totalsPence[index] / y.totals.incomePence) * 100)}%` : '–';
  return (
    <tr className={depth === 0 ? 'font-medium text-ink' : 'text-ink/90'}>
      <td className={`py-2.5 pr-3 ${depth === 0 ? 'pl-5 sm:pl-6' : 'pl-10 sm:pl-12'}`}>
        {line.name}
        {line.note && <span className="ml-2 text-xs font-normal text-faint">{line.note}</span>}
      </td>
      <td className="tabular px-3 py-2.5 text-right align-top whitespace-nowrap">
        <AmountLink year={a} line={line} index={0} />
      </td>
      <td className="tabular px-3 py-2.5 text-right align-top whitespace-nowrap text-muted">
        <AmountLink year={b} line={line} index={1} />
      </td>
      <td className="tabular px-3 py-2.5 text-right align-top font-normal whitespace-nowrap">
        <Change current={line.totalsPence[0]} previous={line.totalsPence[1]} good={good} />
      </td>
      <td className={`tabular py-2.5 pr-5 pl-3 text-right align-top font-normal whitespace-nowrap text-muted sm:pr-6 ${showShare ? 'max-sm:hidden' : 'hidden'}`}>
        {share(0, a)} · {share(1, b)}
      </td>
    </tr>
  );
}

function CategoryTable({ a, b, pick, good, showShare }: { a: YearComparisonYear; b: YearComparisonYear; pick: (y: YearComparisonYear) => BreakdownSection; good: Good; showShare: boolean }) {
  const [sa, sb] = [pick(a), pick(b)];
  const rows = useMemo(() => compareSections(sa, sb), [sa, sb]);
  const hasDisallowable = sa.disallowablePence > 0 || sb.disallowablePence > 0;
  const cells = 'tabular px-3 py-3 text-right whitespace-nowrap';
  const lastCell = `py-3 pr-5 pl-3 sm:pr-6 ${showShare ? 'max-sm:hidden' : 'hidden'}`;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr className="border-y border-line">
            <th scope="col" className="py-3 pr-3 pl-5 text-left font-medium sm:pl-6">Category</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">{shortYear(a)}</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">{shortYear(b)}</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Change</th>
            <th scope="col" className={`${lastCell} text-right font-medium whitespace-nowrap`}>% of incoming</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.flatMap((row) => [
            <CategoryRow key={row.key} line={row} a={a} b={b} good={good} depth={0} showShare={showShare} />,
            ...row.children.map((c) => <CategoryRow key={c.key} line={c} a={a} b={b} good={good} depth={1} showShare={showShare} />),
          ])}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-strong font-semibold text-white">
            <td className="py-3 pr-3 pl-5 sm:pl-6">Total</td>
            <td className={cells}>{formatGBP(sa.totalPence)}</td>
            <td className={cells}>{formatGBP(sb.totalPence)}</td>
            <td className={`${cells} font-normal`}>
              <Change current={sa.totalPence} previous={sb.totalPence} good={good} />
            </td>
            <td className={lastCell} />
          </tr>
          {hasDisallowable && (
            <tr className="font-medium text-ink">
              <td className="py-3 pr-3 pl-5 sm:pl-6">Allowable, as in the profit</td>
              <td className={cells}>{formatGBP(sa.totalPence - sa.disallowablePence)}</td>
              <td className={cells}>{formatGBP(sb.totalPence - sb.disallowablePence)}</td>
              <td className={`${cells} font-normal`}>
                <Change current={sa.totalPence - sa.disallowablePence} previous={sb.totalPence - sb.disallowablePence} good={good} />
              </td>
              <td className={lastCell} />
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  );
}

// ---- Tax ----

function TaxRow({ label, detail, a, b, change, strong = false }: { label: string; detail?: string; a: string; b: string; change: ReactNode; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-semibold text-white' : 'text-ink'}>
      <td className="py-2.5 pr-3 pl-5 sm:pl-6">
        {label}
        {detail && <div className="text-xs font-normal text-muted">{detail}</div>}
      </td>
      <td className="tabular px-3 py-2.5 text-right align-top whitespace-nowrap">{a}</td>
      <td className="tabular px-3 py-2.5 text-right align-top whitespace-nowrap text-muted">{b}</td>
      <td className="tabular py-2.5 pr-5 pl-3 text-right align-top font-normal whitespace-nowrap sm:pr-6">{change}</td>
    </tr>
  );
}

function TaxComparison({ a, b }: { a: YearComparisonYear; b: YearComparisonYear }) {
  if (!a.tax || !b.tax) return null;
  const [ea, eb] = [a.tax.estimate, b.tax.estimate];
  const money = (label: string, pick: (e: typeof ea) => number, detail?: string, strong = false) => (
    <TaxRow
      label={label}
      detail={detail}
      a={formatGBP(pick(ea))}
      b={formatGBP(pick(eb))}
      change={<Change current={pick(ea)} previous={pick(eb)} good="down" />}
      strong={strong}
    />
  );
  // This year's profit at the other year's rates: what's left of the change is down to the rates.
  const atOtherRates = estimateTax({ label: b.taxYear.label, profitPence: ea.profitPence, otherIncomePence: ea.otherIncomePence });
  const rateEffect = ea.totalPence - atOtherRates.totalPence;
  const allowance = [a, b].filter((y) => y.tax!.usesTradingAllowance).map(shortYear);

  return (
    <Card className="print:break-inside-avoid">
      <CardHeader icon={<Calculator className="size-5 text-accent-soft" />} title="Estimated tax" />
      <div className="space-y-3 px-5 pb-4 empty:hidden sm:px-6">
        {[a, b]
          .filter((y) => y.tax!.estimate.ratesAssumed)
          .map((y) => (
            <Alert key={y.taxYear.id} tone="warning">
              The app doesn't have HMRC's rates for {shortYear(y)} yet, so this uses the {displayTaxYear(y.tax!.estimate.ratesLabel)} rates.
            </Alert>
          ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-xs tracking-wide text-muted uppercase">
            <tr className="border-y border-line">
              <th scope="col" className="py-3 pr-3 pl-5 text-left font-medium sm:pl-6">Figure</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">{shortYear(a)}</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">{shortYear(b)}</th>
              <th scope="col" className="py-3 pr-5 pl-3 text-right font-medium sm:pr-6">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <TaxRow
              label="Taxable profit"
              detail={allowance.length ? `${allowance.join(' and ')} ${allowance.length === 1 ? 'uses' : 'use'} the trading allowance` : undefined}
              a={formatGBP(ea.profitPence)}
              b={formatGBP(eb.profitPence)}
              change={<Change current={ea.profitPence} previous={eb.profitPence} good="up" />}
            />
            {(ea.otherIncomePence > 0 || eb.otherIncomePence > 0) && money('Other taxable income', (e) => e.otherIncomePence, 'A salary or pension: it affects the rate your profit is taxed at')}
            {money('Income Tax on the profit', (e) => e.incomeTaxPence)}
            {money('Class 4 National Insurance', (e) => e.class4Pence)}
            {money('Estimated tax', (e) => e.totalPence, undefined, true)}
            <TaxRow
              label="Share of profit to put aside"
              a={percent(ea.setAsideRate)}
              b={percent(eb.setAsideRate)}
              change={<PointsChange current={ea.setAsideRate} previous={eb.setAsideRate} good="down" />}
            />
          </tbody>
        </table>
      </div>
      {rateEffect !== 0 && (
        <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">
          Different tax rates account for <span className="tabular text-ink">{signed(rateEffect, formatGBP(Math.abs(rateEffect)))}</span> of the change. The rest comes from
          the profit and other income.
        </p>
      )}
      <p className="flex items-start gap-2 border-t border-line px-5 py-4 text-xs text-faint sm:px-6">
        <Wallet className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Estimates using the Income Tax rates for England, Wales and Northern Ireland, on the same basis as the Tax estimate page. They aren't tax advice.
      </p>
    </Card>
  );
}

// ---- Page ----

const byStart = (x: TaxYear, y: TaxYear) => (x.startDate < y.startDate ? -1 : 1);

/** The year before, or the one after if it's the earliest. */
function nearestOther(years: TaxYear[], year: TaxYear): TaxYear | undefined {
  const others = years.filter((y) => y.id !== year.id);
  return others.filter((y) => y.startDate < year.startDate).at(-1) ?? others[0];
}

function Comparison({ data, inProgress }: { data: YearComparisonResponse; inProgress: YearComparisonYear | undefined }) {
  const [a, b] = data.years;
  return (
    <>
      {data.period === 'full' && inProgress && (
        <Alert tone="warning">
          {shortYear(inProgress)} hasn't finished, so this compares its figures so far with a whole year. Choose Same period for a fairer comparison.
        </Alert>
      )}
      <Headlines a={a} b={b} />
      <MonthByMonth a={a} b={b} />
      <Card className="print:break-inside-avoid">
        <CardHeader icon={<ArrowDownRight className="size-5 text-in-soft" />} title="Income by category" />
        {a.income.groups.length + b.income.groups.length === 0 ? (
          <EmptyState title="No income in either period" />
        ) : (
          <CategoryTable a={a} b={b} pick={(y) => y.income} good="up" showShare={false} />
        )}
      </Card>
      <Card className="print:break-inside-avoid">
        <CardHeader icon={<ArrowUpRight className="size-5 text-out-soft" />} title="Expenses by category" />
        {a.expenses.groups.length + b.expenses.groups.length === 0 ? (
          <EmptyState title="No expenses in either period" />
        ) : (
          <CategoryTable a={a} b={b} pick={(y) => y.expenses} good="down" showShare />
        )}
      </Card>
      {data.period === 'full' ? (
        <TaxComparison a={a} b={b} />
      ) : (
        <p className="text-sm text-muted print:hidden">Tax is compared for full years only, because the tax on part of a year's profit would mislead.</p>
      )}
    </>
  );
}

export function CompareYears() {
  const { data: yearsData, isLoading: yearsLoading } = useTaxYears();
  const { taxYear: active } = useActiveTaxYear();
  const [params, setParams] = useSearchParams();
  const today = todayIso();

  const years = useMemo(() => [...(yearsData?.taxYears ?? [])].sort(byStart), [yearsData]);
  const find = (param: string) => years.find((y) => String(y.id) === params.get(param));
  const chosen = find('year') ?? active ?? years.at(-1);
  const requestedOther = find('with');
  const other = requestedOther && requestedOther.id !== chosen?.id ? requestedOther : chosen && nearestOther(years, chosen);

  // A year still running can only fairly be compared over the same stretch of the other.
  const later = chosen && other ? (chosen.startDate > other.startDate ? chosen : other) : undefined;
  const requestedPeriod = params.get('period');
  const period: ComparisonPeriod =
    requestedPeriod === 'same' || requestedPeriod === 'full' ? requestedPeriod : later && today <= later.endDate ? 'same' : 'full';

  const { data, isLoading, error } = useYearComparison(chosen?.id, other?.id, period);

  const update = (changes: Record<string, string>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) next.set(k, v);
        return next;
      },
      { replace: true },
    );

  const [a, b] = data?.years ?? [];
  const inProgress = data?.years.find((y) => today <= y.taxYear.endDate);

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Compare years"
        description="Two tax years side by side, to see whether you're ahead and which costs are growing. Click an amount to see what's behind it."
        actions={
          years.length >= 2 && (
            <Button onClick={printPage} disabled={!data}>
              <Printer className="size-4" aria-hidden />
              Print / Save as PDF
            </Button>
          )
        }
      />
      {yearsLoading ? (
        <Spinner />
      ) : years.length === 0 || !chosen ? (
        <NoTaxYear />
      ) : !other ? (
        <Card>
          <EmptyState icon={<GitCompareArrows className="size-10" />} title="Only one tax year so far">
            <p>Comparisons need at least two tax years. Add the year you want to compare with {displayTaxYear(chosen.label)}.</p>
            <ButtonLink to="/settings/tax-years" variant="primary" className="mt-5">
              Manage tax years
            </ButtonLink>
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end print:hidden">
              <label className="block sm:w-40">
                <span className="mb-1.5 block text-sm font-medium">Tax year</span>
                <select
                  className="field"
                  value={chosen.id}
                  onChange={(e) => {
                    // Picking the year it's compared with swaps the two.
                    update({ year: e.target.value, with: e.target.value === String(other.id) ? String(chosen.id) : String(other.id) });
                  }}
                >
                  {years.map((y) => (
                    <option key={y.id} value={y.id}>
                      {displayTaxYear(y.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:w-40">
                <span className="mb-1.5 block text-sm font-medium">Compared with</span>
                <select className="field" value={other.id} onChange={(e) => update({ year: String(chosen.id), with: e.target.value })}>
                  {years
                    .filter((y) => y.id !== chosen.id)
                    .map((y) => (
                      <option key={y.id} value={y.id}>
                        {displayTaxYear(y.label)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block sm:w-44">
                <span className="mb-1.5 block text-sm font-medium">Period</span>
                <select className="field" value={period} onChange={(e) => update({ period: e.target.value })}>
                  <option value="same">Same period</option>
                  <option value="full">Full years</option>
                </select>
              </label>
            </div>
            {a && b && (
              <p className="mt-4 text-sm text-muted print:mt-0">
                {formatDisplayDate(a.from)} to {formatDisplayDate(a.to)} compared with {formatDisplayDate(b.from)} to {formatDisplayDate(b.to)}
                {data?.period === 'same' && later ? `: up to the last date recorded in ${displayTaxYear(later.label)}.` : '.'}
              </p>
            )}
          </Card>
          {isLoading ? <Spinner /> : error || !data ? <Alert>{error?.message ?? 'Could not load the comparison'}</Alert> : <Comparison data={data} inProgress={inProgress} />}
        </>
      )}
    </div>
  );
}

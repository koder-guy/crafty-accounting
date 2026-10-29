import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowUpRight, CalendarClock, PieChart, PoundSterling, TrendingDown, TrendingUp } from 'lucide-react';
import {
  daysBetween,
  formatDisplayDate,
  formatGBP,
  PAYMENT_METHOD_LABELS,
  mtdQuarterStatus,
  selfAssessmentDeadline,
  shortCategoryName,
  startYearFromLabel,
  todayIso,
  type CategoryTotal,
  type DashboardData,
  type TransactionDocument,
} from '@crafty/shared';
import { SampleDataNotice, Welcome } from '../components/Welcome';
import { PageBody, PageHeader } from '../components/PageHeader';
import { ReadOnlyNotice } from '../components/ReadOnly';
import { DocIndicator } from '../components/transactions';
import { Alert, Card, CardHeader, Spinner } from '../components/ui';
import { useActiveTaxYear, useCanEdit, useDashboard, useMtdQuarters } from '../lib/queries';

const CHART_IN = '#10b981';
const CHART_OUT = '#dc2626';

function StatCard({
  label,
  value,
  sub,
  icon,
  valueClass = 'text-white',
}: {
  label: string;
  value: string;
  sub: ReactNode;
  icon: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="card p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="eyebrow pt-1.5">{label}</div>
        <div className="hidden sm:block">{icon}</div>
      </div>
      <div className={`tabular mt-1 text-2xl font-bold tracking-tight sm:mt-5 sm:text-3xl ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-muted sm:mt-2 sm:text-sm">{sub}</div>
    </div>
  );
}

/** "Includes £185.60 mileage and £130.00 use of home. Excludes £15.11 disallowable" */
function outgoingNote(data: DashboardData): string {
  const flatRates = [
    data.mileagePence > 0 ? `${formatGBP(data.mileagePence)} mileage` : null,
    data.useOfHomePence > 0 ? `${formatGBP(data.useOfHomePence)} use of home` : null,
  ].filter(Boolean);
  const parts = [
    flatRates.length ? `Includes ${flatRates.join(' and ')}` : null,
    data.totals.disallowablePence > 0 ? `Excludes ${formatGBP(data.totals.disallowablePence)} disallowable` : null,
  ].filter(Boolean);
  return parts.join('. ') || 'Allowable expenses';
}

const IconChip = ({ className, children }: { className: string; children: ReactNode }) => (
  <div className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${className}`}>{children}</div>
);

interface ChartTooltipProps {
  active?: boolean;
  payload?: { payload: DashboardData['monthly'][number] }[];
}

function ChartTooltip({ active, payload }: ChartTooltipProps) {
  const month = payload?.[0]?.payload;
  if (!active || !month) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1.5 font-medium text-ink">{month.range}</div>
      <div className="tabular flex justify-between gap-6 text-in-soft">
        <span>Incoming</span>
        <span>{formatGBP(month.incomePence)}</span>
      </div>
      <div className="tabular flex justify-between gap-6 text-out-soft">
        <span>Outgoing</span>
        <span>{formatGBP(month.expensesPence)}</span>
      </div>
    </div>
  );
}

/** Rounds the largest bar up to a value that divides into four tidy steps. */
function niceMax(rows: { incoming: number; outgoing: number }[]): number {
  const max = Math.max(...rows.flatMap((r) => [r.incoming, r.outgoing]));
  if (max <= 0) return 100;
  const step = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const nice = [1, 2, 2.5, 5, 10].find((m) => m * magnitude >= step)! * magnitude;
  return nice * 4;
}

function MonthlyChart({ data }: { data: DashboardData['monthly'] }) {
  const rows = data.map((m) => ({ ...m, incoming: m.incomePence / 100, outgoing: m.expensesPence / 100 }));
  return (
    <div className="h-[228px] px-2 pb-4 sm:px-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 10, right: 16, left: 4, bottom: 0 }} barGap={4}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: '#8b90a3', fontSize: 12 }} axisLine={{ stroke: '#323648' }} tickLine={false} />
          <YAxis
            tick={{ fill: '#8b90a3', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={56}
            domain={[0, niceMax(rows)]}
            tickCount={5}
            allowDecimals={false}
            tickFormatter={(v: number) => `£${v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v}`}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: '#ffffff08' }} />
          <Legend
            iconType="square"
            wrapperStyle={{ fontSize: 13, paddingTop: 12 }}
            formatter={(value: string) => <span style={{ color: value === 'incoming' ? '#34d399' : '#f87171' }}>{value === 'incoming' ? 'Incoming (£)' : 'Outgoing (£)'}</span>}
          />
          <Bar dataKey="incoming" fill={CHART_IN} radius={[3, 3, 0, 0]} maxBarSize={36} />
          <Bar dataKey="outgoing" fill={CHART_OUT} radius={[3, 3, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecentList({
  title,
  icon,
  viewAll,
  empty,
  items,
}: {
  title: string;
  icon: ReactNode;
  viewAll: string;
  empty: string;
  items: { key: number; to: string; name: string; sub: string; amount: string; tone: 'in' | 'out'; docs: TransactionDocument[] }[];
}) {
  return (
    <Card>
      <CardHeader
        icon={icon}
        title={title}
        action={
          <Link to={viewAll} className="text-sm text-accent-soft hover:underline">
            View all
          </Link>
        }
      />
      <div className="px-5 pb-5 sm:px-6">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{empty}</p>
        ) : (
          <ul className="space-y-2.5">
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  to={item.to}
                  className="flex items-center justify-between gap-4 rounded-xl border border-line bg-page/40 px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium text-ink">
                      <span className="truncate">{item.name}</span>
                      <DocIndicator documents={item.docs} />
                    </div>
                    <div className="truncate text-xs text-muted">{item.sub}</div>
                  </div>
                  <span className={`tabular shrink-0 font-semibold ${item.tone === 'in' ? 'text-in-soft' : 'text-out-soft'}`}>
                    {item.tone === 'in' ? '+' : '−'}
                    {item.amount}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function CategoryBreakdown({ title, rows, tone }: { title: string; rows: CategoryTotal[]; tone: 'in' | 'out' }) {
  const max = Math.max(1, ...rows.map((r) => r.totalPence));
  return (
    <div>
      <h3 className="eyebrow mb-3">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-faint">Nothing recorded yet.</p>
      ) : (
        <ul className="space-y-3.5">
          {rows.map((row) => (
            <li key={row.categoryId}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-ink" title={row.name}>
                  {shortCategoryName(row.name)}
                </span>
                <span className="tabular shrink-0 font-medium">{formatGBP(row.totalPence)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${tone === 'in' ? 'bg-ok' : 'bg-out'}`}
                  style={{ width: `${(row.totalPence / max) * 100}%` }}
                />
              </div>
              {row.disallowablePence > 0 && (
                <div className="mt-1 text-xs text-faint">{formatGBP(row.disallowablePence)} disallowable</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KeyDates({ data }: { data: DashboardData }) {
  const today = todayIso();
  const year = data.taxYear;
  const startYear = startYearFromLabel(year.label)!;
  const deadline = selfAssessmentDeadline(startYear);
  const daysLeft = daysBetween(today, year.endDate);
  const daysToDeadline = daysBetween(today, deadline);

  const { data: mtd } = useMtdQuarters(year.id);
  const nextUpdate = mtd?.quarters.find((q) => mtdQuarterStatus(q, today, q.submission !== null) !== 'submitted');
  const daysToUpdate = nextUpdate ? daysBetween(today, nextUpdate.deadline) : 0;

  const status =
    today < year.startDate
      ? `Starts in ${daysBetween(today, year.startDate)} days`
      : daysLeft >= 0
        ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`
        : 'Ended';

  return (
    <Card>
      <CardHeader icon={<CalendarClock className="size-5 text-accent-soft" />} title="Key Dates" />
      <dl className="space-y-4 px-5 pb-6 text-sm sm:px-6">
        <div>
          <dt className="text-muted">Tax year ends</dt>
          <dd className="mt-0.5 flex items-baseline justify-between gap-3">
            <span className="font-medium text-ink">{formatDisplayDate(year.endDate)}</span>
            <span className="text-xs text-faint">{status}</span>
          </dd>
        </div>
        {nextUpdate && (
          <div>
            <dt className="text-muted">
              <Link to="/mtd" className="hover:text-accent-soft hover:underline">
                MTD update for Q{nextUpdate.quarter}
              </Link>
            </dt>
            <dd className="mt-0.5 flex items-baseline justify-between gap-3">
              <span className="font-medium text-ink">{formatDisplayDate(nextUpdate.deadline)}</span>
              <span className={`text-xs ${daysToUpdate < 0 ? 'text-out-soft' : daysToUpdate <= 14 ? 'text-warn' : 'text-faint'}`}>
                {daysToUpdate < 0 ? 'Overdue' : daysToUpdate === 0 ? 'Due today' : `${daysToUpdate} ${daysToUpdate === 1 ? 'day' : 'days'} left`}
              </span>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted">Self Assessment deadline</dt>
          <dd className="mt-0.5 flex items-baseline justify-between gap-3">
            <span className="font-medium text-ink">{formatDisplayDate(deadline)}</span>
            <span className={`text-xs ${daysToDeadline < 0 ? 'text-faint' : daysToDeadline <= 60 ? 'text-warn' : 'text-faint'}`}>
              {daysToDeadline < 0 ? 'Passed' : `${daysToDeadline} days to go`}
            </span>
          </dd>
        </div>
        <div className="border-t border-line pt-4">
          <dt className="text-muted">Income by payment method</dt>
          <dd className="mt-2 space-y-1.5">
            {(
              [
                ['cash', data.totals.cashIncomePence],
                ['card', data.totals.cardIncomePence],
                ['bank_transfer', data.totals.bankIncomePence],
              ] as const
            ).map(([method, pence]) => (
              <div key={method} className="flex justify-between">
                <span className="text-ink/90">{PAYMENT_METHOD_LABELS[method]}</span>
                <span className="tabular">{formatGBP(pence)}</span>
              </div>
            ))}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

export function Dashboard() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useDashboard(taxYear?.id);
  const canEdit = useCanEdit();

  return (
    <>
      <PageHeader title="Dashboard" />
      <PageBody>
        {yearLoading || (taxYear && isLoading) ? (
          <Spinner />
        ) : !taxYear ? (
          <Welcome />
        ) : error || !data ? (
          <Alert>{error?.message ?? 'Could not load the dashboard'}</Alert>
        ) : (
          <>
            {!canEdit && <ReadOnlyNotice />}
            <SampleDataNotice />
            <div className="grid gap-3 sm:gap-5 md:grid-cols-3">
              <StatCard
                label="Total income"
                value={formatGBP(data.totals.incomePence)}
                sub="Card, cash and bank transfer"
                icon={
                  <IconChip className="bg-ok/15 text-ok">
                    <TrendingUp className="size-5" aria-hidden />
                  </IconChip>
                }
              />
              <StatCard
                label="Total outgoing"
                value={formatGBP(data.totals.allowableExpensesPence)}
                sub={outgoingNote(data)}
                icon={
                  <IconChip className="bg-out-bg text-out-soft">
                    <TrendingDown className="size-5" aria-hidden />
                  </IconChip>
                }
              />
              <StatCard
                label="Net profit"
                value={formatGBP(data.totals.netProfitPence)}
                sub={
                  <>
                    Income minus allowable outgoing.{' '}
                    <Link to="/reports/tax-estimate" className="text-accent-soft hover:underline">
                      Estimated tax {formatGBP(data.taxEstimate.totalPence)}
                    </Link>
                  </>
                }
                valueClass={data.totals.netProfitPence < 0 ? 'text-out-soft' : 'text-accent-soft'}
                icon={
                  <IconChip className="bg-violet-500/15 text-violet-300">
                    <PoundSterling className="size-5" aria-hidden />
                  </IconChip>
                }
              />
            </div>

            <Card>
              <CardHeader icon={<TrendingUp className="size-5 text-accent-soft" />} title="Monthly incoming vs outgoing" />
              <MonthlyChart data={data.monthly} />
            </Card>

            <div className="grid gap-5 xl:grid-cols-2">
              <RecentList
                title="Recent incoming sales"
                icon={<ArrowDownRight className="size-5 text-in-soft" />}
                viewAll="/incoming"
                empty="No incoming records for this tax year."
                items={data.recentIncomes.map((i) => ({
                  key: i.id,
                  to: `/incoming/${i.id}`,
                  name: i.description,
                  sub: `${formatDisplayDate(i.date)} · ${PAYMENT_METHOD_LABELS[i.paymentMethod]}`,
                  amount: formatGBP(i.amountPence),
                  tone: 'in',
                  docs: i.documents,
                }))}
              />
              <RecentList
                title="Recent outgoing payments"
                icon={<ArrowUpRight className="size-5 text-out-soft" />}
                viewAll="/outgoing"
                empty="No outgoing records for this tax year."
                items={data.recentExpenses.map((e) => ({
                  key: e.id,
                  to: `/outgoing/${e.id}`,
                  name: e.payee,
                  sub: `${formatDisplayDate(e.date)} · ${PAYMENT_METHOD_LABELS[e.paymentMethod]}`,
                  amount: formatGBP(e.totalPence),
                  tone: 'out',
                  docs: e.documents,
                }))}
              />
            </div>

            <div className="grid gap-5 xl:grid-cols-3">
              <Card className="xl:col-span-2">
                <CardHeader icon={<PieChart className="size-5 text-accent-soft" />} title="By Category" />
                <div className="grid gap-8 px-5 pb-6 sm:px-6 md:grid-cols-2">
                  <CategoryBreakdown title="Income" rows={data.incomeByCategory} tone="in" />
                  <CategoryBreakdown title="Expenses" rows={data.expensesByCategory} tone="out" />
                </div>
              </Card>
              <KeyDates data={data} />
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowDownRight, ArrowUpRight, ListTree, Printer, Store, X } from 'lucide-react';
import {
  formatDisplayDate,
  formatGBP,
  isValidIsoDate,
  mtdQuarters,
  taxYearFromStartYear,
  taxYearStartYearForDate,
  todayIso,
  type BreakdownCategory,
  type BreakdownSection,
} from '@crafty/shared';
import { SectionHeading } from '../../components/SectionLayout';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, IconButton, Spinner } from '../../components/ui';
import { useBreakdown, useBreakdownItems, type BreakdownSelection } from '../../lib/queries';

// ---- Periods ----

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function presets(today: string) {
  const [y, m] = today.split('-').map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const startYear = taxYearStartYearForDate(today);
  const quarters = [...mtdQuarters(startYear - 1), ...mtdQuarters(startYear)];
  const current = quarters.findIndex((q) => q.startDate <= today && today <= q.endDate);
  const thisYear = taxYearFromStartYear(startYear);
  const lastYear = taxYearFromStartYear(startYear - 1);
  return [
    { key: 'this-month', label: 'This month', from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) },
    { key: 'last-month', label: 'Last month', from: iso(prevY, prevM, 1), to: iso(prevY, prevM, lastDay(prevY, prevM)) },
    { key: 'this-quarter', label: 'This MTD quarter', from: quarters[current].startDate, to: quarters[current].endDate },
    { key: 'last-quarter', label: 'Last MTD quarter', from: quarters[current - 1].startDate, to: quarters[current - 1].endDate },
    { key: 'this-tax-year', label: 'This tax year', from: thisYear.startDate, to: thisYear.endDate },
    { key: 'last-tax-year', label: 'Last tax year', from: lastYear.startDate, to: lastYear.endDate },
  ];
}

// ---- Selection (kept in the URL as e.g. "group:3", "cat:21", "payee:Bead World") ----

function parseSelection(value: string | null): BreakdownSelection | null {
  if (!value) return null;
  const [kind, ...rest] = value.split(':');
  const arg = rest.join(':');
  if (kind === 'payee' && arg) return { payee: arg };
  const id = Number(arg);
  if ((kind === 'cat' || kind === 'group') && Number.isInteger(id) && id > 0) return { categoryId: id, group: kind === 'group' };
  return null;
}

const selectionKey = (s: BreakdownSelection) => ('payee' in s ? `payee:${s.payee}` : `${s.group ? 'group' : 'cat'}:${s.categoryId}`);

// ---- Tables ----

function Share({ amount, total, tone }: { amount: number; total: number; tone: 'in' | 'out' }) {
  const pct = total > 0 ? (amount / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2 print:border print:border-line">
        <div className={`h-full rounded-full ${tone === 'in' ? 'bg-accent' : 'bg-out'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular w-10 text-right text-xs text-muted">{Math.round(pct)}%</span>
    </div>
  );
}

function Row({
  name,
  note,
  amount,
  disallowable,
  count,
  total,
  tone,
  depth,
  selected,
  onSelect,
}: {
  name: ReactNode;
  note?: string;
  amount: number;
  disallowable: number;
  count: number;
  total: number;
  tone: 'in' | 'out';
  depth: 0 | 1;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      onClick={onSelect}
      aria-selected={selected}
      className={`cursor-pointer transition-colors hover:bg-surface-2/60 ${selected ? 'bg-accent-bg' : ''} ${depth === 0 ? 'font-medium text-ink' : 'text-ink/90'}`}
    >
      <td className={`py-2.5 pr-3 ${depth === 0 ? 'pl-5 sm:pl-6' : 'pl-10 sm:pl-12'}`}>
        <button
          type="button"
          className="text-left hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          {name}
        </button>
        {note && <span className="ml-2 text-xs font-normal text-faint">{note}</span>}
        {disallowable > 0 && <div className="text-xs font-normal text-faint">{formatGBP(disallowable)} disallowable</div>}
      </td>
      <td className="tabular px-3 py-2.5 text-right text-muted">{count}</td>
      <td className="px-3 py-2.5 max-sm:hidden">
        <Share amount={amount} total={total} tone={tone} />
      </td>
      <td className={`tabular py-2.5 pr-5 pl-3 text-right whitespace-nowrap sm:pr-6 ${depth === 0 ? 'font-semibold' : ''}`}>
        {formatGBP(amount)}
      </td>
    </tr>
  );
}

function CategoryTable({
  section,
  tone,
  selectedKey,
  onSelect,
}: {
  section: BreakdownSection;
  tone: 'in' | 'out';
  selectedKey: string | null;
  onSelect: (s: BreakdownSelection) => void;
}) {
  const child = (c: BreakdownCategory, note?: string) => {
    const sel = { categoryId: c.categoryId, group: false };
    return (
      <Row
        key={c.categoryId}
        name={c.name}
        note={note}
        amount={c.totalPence}
        disallowable={c.disallowablePence}
        count={c.count}
        total={section.totalPence}
        tone={tone}
        depth={1}
        selected={selectedKey === selectionKey(sel)}
        onSelect={() => onSelect(sel)}
      />
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr className="border-y border-line">
            <th scope="col" className="py-3 pr-3 pl-5 text-left font-medium sm:pl-6">Category</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Items</th>
            <th scope="col" className="px-3 py-3 text-left font-medium max-sm:hidden">Share</th>
            <th scope="col" className="py-3 pr-5 pl-3 text-right font-medium sm:pr-6">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {section.groups.map((g) => {
            const sel = { categoryId: g.standard.categoryId, group: true };
            return [
              <Row
                key={`g${g.standard.categoryId}`}
                name={g.standard.name}
                amount={g.totalPence}
                disallowable={g.custom.length ? 0 : g.disallowablePence}
                count={g.count}
                total={section.totalPence}
                tone={tone}
                depth={0}
                selected={selectedKey === selectionKey(sel)}
                onSelect={() => onSelect(sel)}
              />,
              ...(g.custom.length
                ? [
                    ...g.custom.map((c) => child(c)),
                    ...(g.standard.count > 0 ? [child(g.standard, 'not in a custom category')] : []),
                  ]
                : []),
            ];
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-strong font-semibold text-white">
            <td className="py-3 pr-3 pl-5 sm:pl-6">Total</td>
            <td />
            <td className="max-sm:hidden" />
            <td className="tabular py-3 pr-5 pl-3 text-right sm:pr-6">{formatGBP(section.totalPence)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DrillDown({
  from,
  to,
  selection,
  title,
  onClose,
}: {
  from: string;
  to: string;
  selection: BreakdownSelection;
  title: string;
  onClose: () => void;
}) {
  const { data: items, isLoading, error } = useBreakdownItems(from, to, selection);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  const total = (items ?? []).reduce((acc, i) => acc + i.amountPence, 0);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click on the dialog element itself (not its contents) is a click on the blurred backdrop.
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto max-h-[85vh] w-[calc(100%-32px)] max-w-4xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm open:flex"
    >
        <CardHeader
          icon={<ListTree className="size-5 text-accent-soft" />}
          title={
            <span>
              {title}{' '}
              <span className="font-normal text-muted">
                · {items?.length ?? 0} {items?.length === 1 ? 'item' : 'items'} · {formatGBP(total)}
              </span>
            </span>
          }
          action={
            <IconButton label="Close" onClick={onClose} className="print:hidden">
              <X className="size-4" />
            </IconButton>
          }
        />
        <div className="min-h-0 flex-1 overflow-auto pb-2">
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <div className="px-6 pb-6">
            <Alert>{error.message}</Alert>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-xs tracking-wide text-muted uppercase">
                <tr className="border-y border-line">
                  <th scope="col" className="py-3 pr-3 pl-5 text-left font-medium sm:pl-6">Date</th>
                  <th scope="col" className="px-3 py-3 text-left font-medium">Payee / description</th>
                  <th scope="col" className="px-3 py-3 text-left font-medium">Category</th>
                  <th scope="col" className="py-3 pr-5 pl-3 text-right font-medium sm:pr-6">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(items ?? []).map((i, n) => (
                  <tr key={`${i.kind}-${i.transactionId}-${n}`}>
                    <td className="py-2.5 pr-3 pl-5 whitespace-nowrap text-muted sm:pl-6">{formatDisplayDate(i.date)}</td>
                    <td className="px-3 py-2.5">
                      <Link
                        to={`/${i.kind === 'income' ? 'incoming' : 'outgoing'}/${i.transactionId}`}
                        className="font-medium text-ink hover:text-accent-soft hover:underline"
                      >
                        {i.payee ?? i.description}
                      </Link>
                      {i.payee && <div className="text-xs text-muted">{i.description}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-muted">
                      {i.categoryName}
                      {i.disallowable && (
                        <span className="ml-2">
                          <Badge tone="out">Disallowable</Badge>
                        </span>
                      )}
                    </td>
                    <td className={`tabular py-2.5 pr-5 pl-3 text-right sm:pr-6 ${i.kind === 'income' ? 'text-in-soft' : 'text-out-soft'}`}>
                      {formatGBP(i.amountPence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
    </dialog>
  );
}

// ---- Page ----

export function Breakdown() {
  const today = todayIso();
  const options = useMemo(() => presets(today), [today]);
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? options[0].from;
  const to = params.get('to') ?? options[0].to;
  const selection = parseSelection(params.get('show'));
  const selectedKey = selection ? selectionKey(selection) : null;
  const rangeError =
    !isValidIsoDate(from) || !isValidIsoDate(to) ? 'Choose a start and end date' : from > to ? 'The start date must be on or before the end date' : null;

  const { data, isLoading, error } = useBreakdown(from, to);

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );

  const preset = options.find((o) => o.from === from && o.to === to)?.key ?? 'custom';
  const select = (s: BreakdownSelection) => update({ show: selectedKey === selectionKey(s) ? null : selectionKey(s) });

  const selectionTitle = (() => {
    if (!selection || !data) return '';
    if ('payee' in selection) return selection.payee;
    for (const g of [...data.expenses.groups, ...data.income.groups]) {
      if (g.standard.categoryId === selection.categoryId) return selection.group ? g.standard.name : `${g.standard.name} (not in a custom category)`;
      const c = g.custom.find((x) => x.categoryId === selection.categoryId);
      if (c) return c.name;
    }
    return 'Selected items';
  })();

  const allowableExpenses = (data?.expenses.totalPence ?? 0) - (data?.expenses.disallowablePence ?? 0);
  const profit = (data?.income.totalPence ?? 0) - allowableExpenses;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Breakdown"
        description="Income and spending by category and payee for any period. Click a row to see what's behind it."
        actions={
          <Button onClick={() => window.print()} disabled={!data}>
            <Printer className="size-4" aria-hidden />
            Print / Save as PDF
          </Button>
        }
      />

      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end print:hidden">
          <label className="block sm:w-56">
            <span className="mb-1.5 block text-sm font-medium">Period</span>
            <select
              className="field"
              value={preset}
              onChange={(e) => {
                const o = options.find((x) => x.key === e.target.value);
                if (o) update({ from: o.from, to: o.to, show: null });
              }}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
              <option value="custom" disabled>
                Custom dates
              </option>
            </select>
          </label>
          <label className="block sm:w-44">
            <span className="mb-1.5 block text-sm font-medium">From</span>
            <input type="date" className="field" value={from} onChange={(e) => update({ from: e.target.value, show: null })} />
          </label>
          <label className="block sm:w-44">
            <span className="mb-1.5 block text-sm font-medium">To</span>
            <input type="date" className="field" value={to} onChange={(e) => update({ to: e.target.value, show: null })} />
          </label>
        </div>
        <p className="hidden text-sm print:block">
          Period: {formatDisplayDate(from)} to {formatDisplayDate(to)}
        </p>
        {rangeError && (
          <div className="mt-4">
            <Alert>{rangeError}</Alert>
          </div>
        )}
      </Card>

      {rangeError ? null : isLoading ? (
        <Spinner />
      ) : error || !data ? (
        <Alert>{error?.message ?? 'Could not load the breakdown'}</Alert>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-5">
              <div className="eyebrow">Income</div>
              <div className="tabular mt-2 text-2xl font-bold text-in-soft">{formatGBP(data.income.totalPence)}</div>
            </Card>
            <Card className="p-5">
              <div className="eyebrow">Expenses</div>
              <div className="tabular mt-2 text-2xl font-bold text-out-soft">{formatGBP(allowableExpenses)}</div>
              {data.expenses.disallowablePence > 0 && (
                <div className="mt-1 text-xs text-muted">Excludes {formatGBP(data.expenses.disallowablePence)} disallowable</div>
              )}
            </Card>
            <Card className="p-5">
              <div className="eyebrow">Profit</div>
              <div className={`tabular mt-2 text-2xl font-bold ${profit < 0 ? 'text-out-soft' : 'text-white'}`}>{formatGBP(profit)}</div>
            </Card>
          </div>

          {selection && (
            <DrillDown
              key={selectedKey}
              from={from}
              to={to}
              selection={selection}
              title={selectionTitle}
              onClose={() => update({ show: null })}
            />
          )}

          <Card className="print:break-inside-avoid">
            <CardHeader icon={<ArrowDownRight className="size-5 text-in-soft" />} title="Income by category" />
            {data.income.groups.length === 0 ? (
              <EmptyState title="No income in this period" />
            ) : (
              <CategoryTable section={data.income} tone="in" selectedKey={selectedKey} onSelect={select} />
            )}
          </Card>

          <div className="space-y-6">
            <Card className="print:break-inside-avoid">
              <CardHeader icon={<ArrowUpRight className="size-5 text-out-soft" />} title="Expenses by category" />
              {data.expenses.groups.length === 0 ? (
                <EmptyState title="No expenses in this period" />
              ) : (
                <CategoryTable section={data.expenses} tone="out" selectedKey={selectedKey} onSelect={select} />
              )}
            </Card>

            <Card className="print:break-inside-avoid">
              <CardHeader icon={<Store className="size-5 text-accent-soft" />} title="Spending by payee" />
              {data.payees.length === 0 ? (
                <EmptyState title="No payments in this period" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs tracking-wide text-muted uppercase">
                      <tr className="border-y border-line">
                        <th scope="col" className="py-3 pr-3 pl-5 text-left font-medium sm:pl-6">Payee</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">Payments</th>
                        <th scope="col" className="px-3 py-3 text-left font-medium max-sm:hidden">Share</th>
                        <th scope="col" className="py-3 pr-5 pl-3 text-right font-medium sm:pr-6">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.payees.map((p) => (
                        <Row
                          key={p.payee}
                          name={p.payee}
                          amount={p.totalPence}
                          disallowable={0}
                          count={p.count}
                          total={data.expenses.totalPence}
                          tone="out"
                          depth={0}
                          selected={selectedKey === selectionKey({ payee: p.payee })}
                          onSelect={() => select({ payee: p.payee })}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CalendarCheck, FileDown, FileSpreadsheet, Info, Landmark, Send } from 'lucide-react';
import {
  MTD_FIRST_SEND_YEAR,
  formatDisplayDate,
  formatGBP,
  mtdEarliestSendDate,
  mtdPayload,
  startYearFromLabel,
  mtdQuarterStatus,
  todayIso,
  type Category,
  type HmrcObligation,
  type HmrcStatus,
  type MtdPayload,
  type MtdPeriodSummary,
  type MtdQuarterStatus,
  type MtdQuarterSummary,
  type TaxYear,
} from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner, type BadgeTone } from '../components/ui';
import {
  useActiveTaxYear,
  useCanEdit,
  useCategories,
  useHmrc,
  useHmrcObligations,
  useMtdQuarters,
  useMtdSubmission,
  useSendToHmrc,
} from '../lib/queries';

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

/** What HMRC says about a quarter: expected (open) or received. */
function HmrcObligationLine({ obligation }: { obligation: HmrcObligation | null }) {
  if (!obligation) return <div className="text-faint">HMRC: not expected</div>;
  return obligation.status === 'fulfilled' ? (
    <div className="text-ok">HMRC: received{obligation.receivedDate ? ` ${formatDisplayDate(obligation.receivedDate)}` : ''}</div>
  ) : (
    <div className="text-muted">HMRC: expected by {formatDisplayDate(obligation.dueDate)}</div>
  );
}

function QuarterCard({
  q,
  status,
  obligation,
  selected,
  onSelect,
}: {
  q: MtdQuarterSummary;
  status: MtdQuarterStatus;
  /** HMRC's obligation for the quarter: undefined when not checked with HMRC. */
  obligation: HmrcObligation | null | undefined;
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
      <div className="mt-4 space-y-0.5 text-xs text-faint">
        <div>
          {q.submission?.sent
            ? `Sent to HMRC ${formatDisplayDate(q.submission.submittedOn)}`
            : q.submission
              ? `Submitted ${formatDisplayDate(q.submission.submittedOn)}`
              : `Due by ${formatDisplayDate(q.deadline)}`}
        </div>
        {obligation !== undefined && <HmrcObligationLine obligation={obligation} />}
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
  const canEdit = useCanEdit();
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

  if (!canEdit) {
    return (
      <p className="text-sm text-ink">
        {q.submission ? (
          <>
            Submitted to HMRC on <strong>{formatDisplayDate(q.submission.submittedOn)}</strong>
            {q.submission.reference && <span className="text-muted"> · reference {q.submission.reference}</span>}
          </>
        ) : (
          <span className="text-muted">No submission recorded yet.</span>
        )}
      </p>
    );
  }

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

const sameFigures = (a: MtdPayload, b: MtdPayload) => JSON.stringify(a) === JSON.stringify(b);

/** The fields being sent, listed for checking before they go: everything that isn't zero. */
function PayloadSummary({ payload, categories }: { payload: MtdPayload; categories: Category[] }) {
  const names = new Map(categories.filter((c) => !c.isCustom).map((c) => [c.hmrcCode, c.name]));
  const rows = [
    ...Object.entries(payload.periodIncome).map(([code, pounds]) => ({ code, label: names.get(code) ?? code, pounds })),
    ...Object.entries(payload.periodExpenses).map(([code, pounds]) => ({ code, label: names.get(code) ?? code, pounds })),
    ...Object.entries(payload.periodDisallowableExpenses ?? {}).map(([code, pounds]) => ({
      code,
      label: `${names.get(code.replace(/Disallowable$/, '')) ?? code}, disallowable`,
      pounds,
    })),
  ].filter((r) => r.pounds !== 0);
  const pence = (pounds: number) => Math.round(pounds * 100);
  return (
    <div className="space-y-2">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.code}>
              <td className="py-1.5 pr-3 text-ink">
                {r.label}
                <div className="font-mono text-xs text-faint">{r.code}</div>
              </td>
              <td className="tabular py-1.5 text-right text-ink">{formatGBP(pence(r.pounds))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-faint">{rows.length ? 'Every other field is sent as zero.' : 'Every field is zero.'}</p>
    </div>
  );
}

/** Sending a quarter's year-to-date figures to HMRC, and what was sent. */
function SendToHmrc({
  taxYear,
  q,
  hmrc,
  categories,
  canSend,
}: {
  taxYear: TaxYear;
  q: MtdQuarterSummary;
  hmrc: HmrcStatus | undefined;
  categories: Category[];
  /** Connected, with a business, and this person can edit. */
  canSend: boolean;
}) {
  const send = useSendToHmrc(taxYear.id);
  const [confirming, setConfirming] = useState(false);
  const resetSend = send.reset;
  // An error belongs to the quarter it happened on.
  useEffect(() => resetSend(), [q.quarter, resetSend]);
  const payload = mtdPayload(q.cumulative, taxYear.startDate, q.endDate);
  const sent = q.submission?.sent ?? null;
  const changed = sent !== null && !sameFigures(sent.payload, payload);
  const earliest = mtdEarliestSendDate(q);
  const tooEarly = todayIso() < earliest;
  const service = (environment: string) => (environment === 'sandbox' ? 'HMRC’s sandbox' : 'HMRC');

  return (
    <div className="space-y-4">
      {sent ? (
        <div className="space-y-1 text-sm">
          <p className="text-ink">
            Sent to {service(sent.environment)} by {sent.by} on <strong>{formatDisplayDate(sent.at.slice(0, 10))}</strong>.
          </p>
          {sent.correlationId && <p className="text-xs text-faint">HMRC correlation ID {sent.correlationId}</p>}
        </div>
      ) : (
        q.submission && (
          <p className="text-sm text-muted">Recorded by hand as submitted on {formatDisplayDate(q.submission.submittedOn)}.</p>
        )
      )}

      {changed && (
        <Alert tone="warning">
          The figures up to {formatDisplayDate(q.endDate)} have changed since they were sent. Updates are cumulative, so your next
          quarterly update brings HMRC up to date. If this is the latest quarter you’ve sent, you can also send it again.
        </Alert>
      )}

      {canSend && (!sent || changed) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={sent ? 'secondary' : 'primary'} onClick={() => setConfirming(true)} disabled={tooEarly}>
            <Send className="size-4" aria-hidden />
            {sent ? `Send Q${q.quarter} again` : `Send Q${q.quarter} to HMRC`}
          </Button>
          {tooEarly && <span className="text-sm text-muted">HMRC takes this update from {formatDisplayDate(earliest)}.</span>}
        </div>
      )}
      {send.error && !confirming && <Alert>{send.error.message}</Alert>}

      <ConfirmDialog
        open={confirming}
        tone="send"
        wide
        title={`Send Q${q.quarter} to ${service(hmrc?.environment ?? 'production')}?`}
        confirmLabel="Send to HMRC"
        onClose={() => setConfirming(false)}
        onConfirm={() => send.mutateAsync({ quarter: q.quarter, payload })}
      >
        <p>
          Year-to-date figures for {hmrc?.business?.tradingName ?? hmrc?.business?.businessId}, {formatDisplayDate(taxYear.startDate)}{' '}
          to {formatDisplayDate(q.endDate)}:
        </p>
        <PayloadSummary payload={payload} categories={categories} />
        {sent && <p>This replaces the Q{q.quarter} update HMRC already has.</p>}
      </ConfirmDialog>
    </div>
  );
}

export function MtdQuarterly() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMtdQuarters(taxYear?.id);
  const { data: categories = [] } = useCategories();
  const { data: hmrc } = useHmrc();
  const checkWithHmrc = Boolean(hmrc?.connection && hmrc.business);
  const canEdit = useCanEdit();
  // Cumulative updates can be sent from 2025/26.
  const sendable = checkWithHmrc && !!taxYear && (startYearFromLabel(taxYear.label) ?? 0) >= MTD_FIRST_SEND_YEAR;
  const obligations = useHmrcObligations(taxYear?.id, checkWithHmrc);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<'cumulative' | 'period'>('cumulative');
  const today = todayIso();

  useEffect(() => setSelected(null), [taxYear?.id]);

  const quarters = data?.quarters ?? [];
  // HMRC is asked about this tax year only, but its sandbox can answer with test data for others.
  const inYear = (obligations.data ?? []).filter(
    (o) => taxYear && o.periodEndDate >= taxYear.startDate && o.periodEndDate <= taxYear.endDate,
  );
  const otherYears = (obligations.data?.length ?? 0) - inYear.length;
  // Cumulative updates all start on 6 April, so match HMRC's obligations to quarters by their end date.
  const obligationFor = (endDate: string) =>
    obligations.data ? (inYear.find((o) => o.periodEndDate === endDate) ?? null) : undefined;
  const unmatched = inYear.filter((o) => !quarters.some((x) => x.endDate === o.periodEndDate));
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
      <PageHeader title="MTD Quarterly Summaries" />
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
                far.{' '}
                {sendable ? (
                  <>
                    Send each quarter’s year-to-date figures to HMRC from its submission panel below. A mistake is put right by your next
                    update.
                  </>
                ) : (
                  <>
                    To keep a digital link, use <span className="text-ink">Export to JSON</span> on the year-to-date figures and import
                    the file into your MTD bridging software rather than retyping or copying them, then record each submission here. Or
                    connect to HMRC in <Link className="text-accent-soft hover:underline" to="/settings/hmrc">Settings → HMRC</Link>{' '}
                    to send updates from here.
                  </>
                )}
              </p>
            </div>

            {checkWithHmrc && (
              <div className="flex items-start gap-3 text-sm text-muted">
                <Landmark className="mt-0.5 size-4 shrink-0 text-accent-soft" aria-hidden />
                {obligations.isLoading ? (
                  <span>Checking what HMRC expects…</span>
                ) : obligations.error ? (
                  <span className="text-out-soft">Couldn’t check with HMRC: {obligations.error.message}</span>
                ) : (
                  <span>
                    Checked with HMRC for {hmrc!.business!.tradingName ?? hmrc!.business!.businessId}
                    {hmrc!.environment === 'sandbox' && ' (sandbox, so these are HMRC’s test figures)'}.
                    {otherYears > 0 && ` HMRC also answered with ${otherYears} ${otherYears === 1 ? 'update' : 'updates'} for other tax years, not shown here.`}
                    {unmatched.length > 0 &&
                      ` HMRC also expects updates for periods that don’t match these quarters: ${unmatched
                        .map((o) => `${formatDisplayDate(o.periodStartDate)} to ${formatDisplayDate(o.periodEndDate)}`)
                        .join('; ')}.`}
                  </span>
                )}
              </div>
            )}
            {hmrc?.connection && !hmrc.business && (
              <p className="text-sm text-muted">
                To see what HMRC expects, find your business in <Link className="text-accent-soft hover:underline" to="/settings/hmrc">Settings → HMRC</Link>.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {quarters.map((x) => (
                <QuarterCard
                  key={x.quarter}
                  q={x}
                  status={mtdQuarterStatus(x, today, x.submission !== null)}
                  obligation={obligationFor(x.endDate)}
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
                {sendable || q.submission?.sent ? (
                  <SendToHmrc taxYear={taxYear} q={q} hmrc={hmrc} categories={categories} canSend={sendable && canEdit} />
                ) : (
                  <SubmissionPanel taxYearId={taxYear.id} q={q} />
                )}
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}

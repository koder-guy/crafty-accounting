import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CalendarCheck, FileSpreadsheet, Info, Landmark, Send } from 'lucide-react';
import {
  MTD_FIRST_SEND_YEAR,
  VAT_REGISTRATION_THRESHOLD_PENCE,
  daysBetween,
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
  type MtdExpenses,
  type MtdPayload,
  type MtdPeriodSummary,
  type MtdQuarterStatus,
  type MtdQuarterSummary,
  type TaxYear,
} from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { ExportCsvButton } from '../../components/transactions';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner, type BadgeTone } from '../../components/ui';
import {
  useActiveTaxYear,
  useCanEdit,
  useCategories,
  useHmrc,
  useHmrcObligations,
  useMtdQuarters,
  useMtdSubmission,
  useSendToHmrc,
  useHmrcCalculationAvailable,
  useTaxEstimate,
} from '../../lib/queries';
import { HmrcCalculationCard } from './HmrcCalculationCard';

const STATUS: Record<MtdQuarterStatus, { label: string; tone: BadgeTone }> = {
  upcoming: { label: 'Upcoming', tone: 'neutral' },
  open: { label: 'In progress', tone: 'accent' },
  due: { label: 'Due', tone: 'warn' },
  overdue: { label: 'Overdue', tone: 'out' },
  submitted: { label: 'Submitted', tone: 'ok' },
};

const shortDate = (iso: string) => formatDisplayDate(iso).replace(/ \d{4}$/, '');

/** The quarter containing today, or the nearest end of the year. */
/** The quarter that needs doing first: the earliest ended one not yet submitted, else the one in progress. */
function defaultQuarter(quarters: MtdQuarterSummary[], today: string): number {
  const waiting = quarters.find((q) => !q.submission && q.endDate < today);
  if (waiting) return waiting.quarter;
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

/** " · 9 days left" for a quarter waiting to be submitted. */
function dueIn(status: MtdQuarterStatus, deadline: string): string {
  if (status === 'overdue') return ' · overdue';
  if (status !== 'due') return '';
  const days = daysBetween(todayIso(), deadline);
  return days === 0 ? ' · today' : ` · ${days} ${days === 1 ? 'day' : 'days'} left`;
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
              : `Due by ${formatDisplayDate(q.deadline)}${dueIn(status, q.deadline)}`}
        </div>
        {obligation !== undefined && <HmrcObligationLine obligation={obligation} />}
      </div>
    </button>
  );
}

function FiguresTable({ summary, categories, oneTotal }: { summary: MtdPeriodSummary; categories: Category[]; oneTotal: boolean }) {
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
          {oneTotal && section('Sent to HMRC as one total')}
          {oneTotal && (
            <tr className="text-ink">
              <td className="px-4 py-2.5 sm:pl-6">Allowable expenses</td>
              <td className="px-4 py-2.5 font-mono text-xs text-faint">consolidatedExpenses</td>
              <td className="tabular px-4 py-2.5 text-right">{formatGBP(t.allowableExpensesPence)}</td>
              <td className="sm:pr-6" />
            </tr>
          )}
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
          <Button busy={clear.isPending} onClick={() => clear.mutate(q.quarter)}>
            Mark as not submitted
          </Button>
        </div>
      </div>
    );
  }

  const earliest = mtdEarliestSendDate(q);
  if (!q.submission && todayIso() < earliest) {
    return (
      <p className="text-sm text-muted">
        Q{q.quarter} runs until {formatDisplayDate(q.endDate)}. HMRC takes its update from {formatDisplayDate(earliest)}, so you can record
        it as submitted after that.
      </p>
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
        <input id="submitted-on" type="date" className="field" required min={earliest} value={submittedOn} onChange={(e) => setSubmittedOn(e.target.value)} />
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

export const sameFigures = (a: MtdPayload, b: MtdPayload) => JSON.stringify(a) === JSON.stringify(b);

/** The fields being sent, listed for checking before they go: everything that isn't zero. */
export function PayloadSummary({ payload, categories }: { payload: MtdPayload; categories: Category[] }) {
  const names = new Map(categories.filter((c) => !c.isCustom).map((c) => [c.hmrcCode, c.name]));
  names.set('consolidatedExpenses', 'Allowable expenses, as one total');
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
      <p className="text-xs text-faint">
        {'consolidatedExpenses' in payload.periodExpenses
          ? 'Expenses go as one total, with no categories or disallowable amounts.'
          : rows.length
            ? 'Every other field is sent as zero.'
            : 'Every field is zero.'}
      </p>
    </div>
  );
}

/** Sending a quarter's year-to-date figures to HMRC, and what was sent. */
function SendToHmrc({
  taxYear,
  q,
  hmrc,
  categories,
  expenses,
  canSend,
  obligation,
  laterHeld,
}: {
  taxYear: TaxYear;
  q: MtdQuarterSummary;
  hmrc: HmrcStatus | undefined;
  categories: Category[];
  expenses: MtdExpenses;
  /** Connected, with a business, and this person can edit. */
  canSend: boolean;
  /** HMRC's obligation for this quarter, if checked with HMRC. */
  obligation: HmrcObligation | null | undefined;
  /** The latest later quarter HMRC already has, if any: HMRC won't take this one now. */
  laterHeld: MtdQuarterSummary | null;
}) {
  const send = useSendToHmrc(taxYear.id);
  const [confirming, setConfirming] = useState(false);
  const resetSend = send.reset;
  // An error belongs to the quarter it happened on.
  useEffect(() => resetSend(), [q.quarter, resetSend]);
  const payload = mtdPayload(q.cumulative, taxYear.startDate, q.endDate, expenses);
  const sent = q.submission?.sent ?? null;
  const changed = sent !== null && !sameFigures(sent.payload, payload);
  // HMRC has an update for this quarter that the app didn't send (other software, or sandbox test data).
  const receivedElsewhere = !sent && obligation?.status === 'fulfilled' ? obligation : null;
  const replacing = sent !== null || receivedElsewhere !== null;
  const earliest = mtdEarliestSendDate(q);
  const tooEarly = todayIso() < earliest;
  const service = (environment: string) => (environment === 'sandbox' ? 'HMRC’s sandbox' : 'HMRC');

  // One status first, then at most a couple of quieter lines.
  const status: { tone: BadgeTone; label: string; detail: string } = sent
    ? {
        tone: 'ok',
        label: 'Sent from here',
        detail: `${formatDisplayDate(sent.at.slice(0, 10))} by ${sent.by}, to ${service(sent.environment)}`,
      }
    : receivedElsewhere
      ? {
          tone: 'ok',
          label: 'HMRC has this update',
          detail: `${receivedElsewhere.receivedDate ? `Received ${formatDisplayDate(receivedElsewhere.receivedDate)}` : 'Received'}, from other software`,
        }
      : laterHeld
        ? {
            tone: 'ok',
            label: `Covered by Q${laterHeld.quarter}`,
            detail: `HMRC has your figures for the year to ${formatDisplayDate(laterHeld.endDate)}`,
          }
        : q.submission && obligation === undefined
          ? { tone: 'neutral', label: 'Recorded as submitted', detail: `${formatDisplayDate(q.submission.submittedOn)}, by hand` }
          : { tone: 'warn', label: 'Not sent yet', detail: `Due by ${formatDisplayDate(q.deadline)}` };
  const held = sent !== null || receivedElsewhere !== null || laterHeld !== null;
  // Changed figures, or nothing at HMRC yet: worth sending, unless HMRC already has a later quarter.
  const wantsSending = canSend && (!held || changed || (receivedElsewhere !== null && !laterHeld));
  const handRecord = !sent && q.submission && status.label !== 'Recorded as submitted' ? q.submission : null;
  // HMRC has this quarter and a later one: reassure rather than offer a button HMRC would refuse.
  const coveredLater = laterHeld !== null && !changed && (sent !== null || receivedElsewhere !== null);

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="text-ink">{status.detail}</span>
        </div>

        {(sent?.correlationId || handRecord || coveredLater || q.otherServiceSend) && (
          <div className="space-y-1 text-sm text-muted">
            {sent?.correlationId && <p className="break-all">HMRC correlation ID {sent.correlationId}</p>}
            {handRecord && <p>You recorded it as submitted on {formatDisplayDate(handRecord.submittedOn)}.</p>}
            {q.otherServiceSend && (
              <p>
                {q.otherServiceSend.environment === 'sandbox'
                  ? `A test update went to HMRC’s sandbox on ${formatDisplayDate(q.otherServiceSend.at.slice(0, 10))}; HMRC’s live service doesn’t have it.`
                  : `An update went to HMRC’s live service on ${formatDisplayDate(q.otherServiceSend.at.slice(0, 10))}, while the app was using it.`}
              </p>
            )}
            {coveredLater && (
              <p>
                Your Q{laterHeld!.quarter} update now covers this quarter too, so there’s nothing more to send for Q{q.quarter}.
              </p>
            )}
          </div>
        )}

        {changed && (
          <Alert tone="warning">
            The figures up to {formatDisplayDate(q.endDate)} have changed since they were sent. Updates are cumulative, so your next
            quarterly update brings HMRC up to date{laterHeld ? '' : ', or you can send this quarter again now'}.
          </Alert>
        )}

        {wantsSending && !laterHeld && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant={replacing ? 'secondary' : 'primary'} onClick={() => setConfirming(true)} disabled={tooEarly}>
              <Send className="size-4" aria-hidden />
              {replacing ? `Send Q${q.quarter} again` : `Send Q${q.quarter} to HMRC`}
            </Button>
            {tooEarly && <span className="text-sm text-muted">HMRC takes this update from {formatDisplayDate(earliest)}.</span>}
          </div>
        )}
        {send.error && !confirming && <Alert>{send.error.message}</Alert>}
      </div>

      {/* Outside the spaced lines: space-y gives every child but the last a bottom margin, and the hidden dialog would be last. */}
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
        {replacing && <p>This replaces the Q{q.quarter} update HMRC already has.</p>}
      </ConfirmDialog>
    </>
  );
}

export function MtdQuarterly() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMtdQuarters(taxYear?.id);
  const { data: categories = [] } = useCategories();
  const { data: hmrc } = useHmrc();
  const checkWithHmrc = Boolean(hmrc?.connection && hmrc.business);
  const canEdit = useCanEdit();
  const declared = data?.finalDeclaration ?? null;
  // Cumulative updates can be sent from 2025/26, until the year's final declaration.
  const sendable = checkWithHmrc && !!taxYear && (startYearFromLabel(taxYear.label) ?? 0) >= MTD_FIRST_SEND_YEAR && !declared;
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
  // HMRC won't take an update ending before the latest one it has: sent from here, or received from elsewhere.
  const laterHeld = (q: MtdQuarterSummary) =>
    quarters
      .filter((x) => x.endDate > q.endDate && (x.submission?.sent || obligationFor(x.endDate)?.status === 'fulfilled'))
      .at(-1) ?? null;
  const current = quarters.length ? (selected ?? defaultQuarter(quarters, today)) : null;
  const q = quarters.find((x) => x.quarter === current);
  const summary = q ? q[view] : null;
  const oneTotal = data?.mtdExpenses === 'consolidated';
  const overThreshold = taxYear?.mtdExpenses === 'consolidated' && data?.mtdExpenses === 'itemised';

  return (
    <>
      <div className="space-y-6">
        <SectionHeading
          title="Quarterly updates"
          description="Your figures for each quarter, sent to HMRC (or recorded) by the 7th of the month after it ends."
        />
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
                {declared ? (
                  <>
                    The{' '}
                    <Link className="text-accent-soft hover:underline" to="/mtd/final-declaration">
                      final declaration
                    </Link>{' '}
                    for this year was made on {formatDisplayDate(declared.at.slice(0, 10))}, so HMRC takes no more quarterly updates. To
                    correct the year, amend it from the final declaration tab.
                  </>
                ) : sendable ? (
                  <>
                    Send each quarter’s year-to-date figures to HMRC from its submission panel below. A mistake is put right by your next
                    update.
                  </>
                ) : (
                  <>
                    To keep a digital link, use <span className="text-ink">Export CSV</span> on the year-to-date figures and import
                    the file into your MTD bridging software rather than retyping or copying them, then record each submission here. Or
                    connect to HMRC in <Link className="text-accent-soft hover:underline" to="/settings/hmrc">Settings → HMRC</Link>{' '}
                    to send updates from here.
                  </>
                )}
              </p>
            </div>

            {overThreshold && (
              <Alert tone="warning">
                This year’s turnover has reached the VAT registration threshold of {formatGBP(VAT_REGISTRATION_THRESHOLD_PENCE).replace(/\.00$/, '')}. One total
                for expenses is only for turnover below it, so expenses now go by category for the whole year. Your next update sends the year
                to date that way.
              </Alert>
            )}

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
              <CardHeader icon={<CalendarCheck className="size-5 text-accent-soft" />} title={`Q${q.quarter} submission`} />
              <div className="px-5 pb-6 sm:px-6">
                {sendable || q.submission?.sent ? (
                  <SendToHmrc
                    taxYear={taxYear}
                    q={q}
                    hmrc={hmrc}
                    categories={categories}
                    expenses={data.mtdExpenses}
                    canSend={sendable && canEdit}
                    obligation={obligationFor(q.endDate)}
                    laterHeld={laterHeld(q)}
                  />
                ) : (
                  <>
                    <p className="mb-4 text-sm text-muted">Due by {formatDisplayDate(q.deadline)}.</p>
                    <SubmissionPanel taxYearId={taxYear.id} q={q} />
                  </>
                )}
              </div>
            </Card>

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
                action={<ExportCsvButton href={`/api/mtd/quarters/${taxYear.id}/${q.quarter}/export.csv?basis=${view}`} />}
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
                <p className="mt-3 text-sm text-muted">
                  Expenses in the CSV and your update to HMRC are{' '}
                  <span className="font-medium text-ink">{oneTotal ? 'consolidated into one total' : 'by category'}</span>.
                  {oneTotal && ' The categories below are for your own reference.'}
                  {canEdit && !overThreshold && (
                    <>
                      {' '}
                      You can change this in{' '}
                      <Link className="text-accent-soft hover:underline" to="/settings/tax-years">
                        Settings → Tax Years
                      </Link>
                      .
                    </>
                  )}
                </p>
              </div>
              <FiguresTable summary={summary} categories={categories} oneTotal={oneTotal} />
            </Card>

            <YearCalculation taxYear={taxYear} />
          </>
        )}
      </div>
    </>
  );
}

/** HMRC's calculation for the whole year, below the quarters it's worked out from. */
function YearCalculation({ taxYear }: { taxYear: TaxYear }) {
  const available = useHmrcCalculationAvailable(taxYear.label);
  const { data } = useTaxEstimate(available ? taxYear.id : undefined);
  return data ? <HmrcCalculationCard data={data} /> : null;
}

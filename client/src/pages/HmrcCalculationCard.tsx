import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Landmark, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  MTD_FIRST_SEND_YEAR,
  displayTaxYear,
  formatGBP,
  startYearFromLabel,
  type HmrcCalculation,
  type HmrcMessage,
  type TaxEstimateResponse,
} from '@crafty/shared';
import { Alert, Button, Card, CardHeader, Spinner } from '../components/ui';
import { HMRC_CALCULATION, useCanEdit, useHmrc, useHmrcCalculation, useTriggerHmrcCalculation } from '../lib/queries';

/** Give up checking for a calculation HMRC is still working on after this long. */
const WAIT_MS = 2 * 60 * 1000;

const TYPES: Record<string, string> = {
  'in-year': 'an in-year calculation',
  'intent-to-finalise': 'a calculation for the final declaration',
  'intent-to-amend': 'a calculation for an amendment',
  'final-declaration': 'the final declaration',
};

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const amount = (pence: number | null | undefined) => (pence === null || pence === undefined ? '—' : formatGBP(pence));

function Row({ label, detail, hmrc, app, strong = false }: { label: string; detail?: string; hmrc: ReactNode; app: ReactNode; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-semibold text-white' : 'text-ink'}>
      <td className="py-2.5 pr-3 pl-5 sm:pl-6">
        {label}
        {detail && <div className="text-xs font-normal text-muted">{detail}</div>}
      </td>
      <td className="tabular px-3 py-2.5 text-right align-top whitespace-nowrap">{hmrc}</td>
      <td className="tabular py-2.5 pr-5 pl-3 text-right align-top whitespace-nowrap text-muted sm:pr-6">{app}</td>
    </tr>
  );
}

function Messages({ messages }: { messages: HmrcCalculation['messages'] }) {
  const list = (items: HmrcMessage[]) =>
    items.length === 1 ? (
      <p>{items[0].text}</p>
    ) : (
      <ul className="list-disc space-y-1 pl-5">
        {items.map((m) => (
          <li key={m.id}>{m.text}</li>
        ))}
      </ul>
    );
  return (
    <>
      {messages.errors.length > 0 && <Alert>{list(messages.errors)}</Alert>}
      {messages.warnings.length > 0 && <Alert tone="warning">{list(messages.warnings)}</Alert>}
      {messages.info.length > 0 && <div className="text-sm text-muted">{list(messages.info)}</div>}
    </>
  );
}

function Figures({ calculation, data }: { calculation: HmrcCalculation; data: TaxEstimateResponse }) {
  const f = calculation.figures!;
  const e = data.estimate;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr className="border-y border-line">
            <th scope="col" className="py-2.5 pr-3 pl-5 text-left font-medium sm:pl-6" />
            <th scope="col" className="px-3 py-2.5 text-right font-medium">HMRC</th>
            <th scope="col" className="py-2.5 pr-5 pl-3 text-right font-medium sm:pr-6">App’s estimate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          <Row label="Self-employment profit" hmrc={amount(f.selfEmploymentProfitPence)} app={formatGBP(e.profitPence)} />
          <Row label="Total income" detail="Including any other income HMRC knows about" hmrc={amount(f.totalIncomePence)} app="—" />
          <Row label="Allowances and deductions" hmrc={amount(f.allowancesPence)} app={formatGBP(e.personalAllowancePence)} />
          <Row label="Taxable income" hmrc={amount(f.taxableIncomePence)} app="—" />
          <Row label="Income Tax" hmrc={amount(f.incomeTaxPence)} app={formatGBP(e.incomeTaxPence)} />
          {f.class2Pence > 0 && <Row label="Class 2 National Insurance" hmrc={amount(f.class2Pence)} app="—" />}
          <Row label="Class 4 National Insurance" hmrc={amount(f.class4Pence)} app={formatGBP(e.class4Pence)} />
          <Row label="Total due" hmrc={amount(f.totalDuePence)} app={formatGBP(e.totalPence)} strong />
        </tbody>
      </table>
    </div>
  );
}

/** Whether HMRC can calculate the tax for a year: connected, with a NINO, from 2025/26. */
export function useHmrcCalculationAvailable(taxYearLabel: string | undefined): boolean {
  const { data: hmrc } = useHmrc();
  return Boolean(hmrc?.connection && hmrc.nino) && (startYearFromLabel(taxYearLabel ?? '') ?? 0) >= MTD_FIRST_SEND_YEAR;
}

/**
 * HMRC's own calculation of the year's tax, from the quarterly updates it has,
 * next to the app's estimate. Lives on the MTD page, apart from the app's
 * Self Assessment estimate in Reports. Shown once connected to HMRC.
 */
export function HmrcCalculationCard({ data }: { data: TaxEstimateResponse }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit();
  const { data: hmrc } = useHmrc();
  const taxYearId = data.taxYear.id;
  const available = useHmrcCalculationAvailable(data.taxYear.label);
  // The calculation just asked for, until HMRC has worked it out.
  const [awaiting, setAwaiting] = useState<{ id: string; since: number } | null>(null);
  useEffect(() => setAwaiting(null), [taxYearId]);
  const calc = useHmrcCalculation(taxYearId, available, awaiting?.id ?? null);
  const trigger = useTriggerHmrcCalculation(taxYearId);

  const result = calc.data;
  const timedOut = awaiting !== null && result?.state === 'pending' && Date.now() - awaiting.since > WAIT_MS;
  // Once ready, the latest calculation is this one too.
  useEffect(() => {
    if (awaiting && result?.state === 'ready') qc.invalidateQueries({ queryKey: [HMRC_CALCULATION, taxYearId, null] });
  }, [awaiting, result?.state, qc, taxYearId]);

  if (!available) return null;
  const busy = trigger.isPending || (result?.state === 'pending' && !timedOut);

  return (
    <Card className="print:break-inside-avoid">
      <CardHeader
        icon={<Landmark className="size-5 text-accent-soft" />}
        title={`HMRC’s tax calculation for ${displayTaxYear(data.taxYear.label)}`}
        action={
          canEdit && (
            <Button
              className="print:hidden"
              onClick={() => trigger.mutate(undefined, { onSuccess: ({ calculationId }) => setAwaiting({ id: calculationId, since: Date.now() }) })}
              busy={trigger.isPending}
              disabled={busy}
            >
              <RefreshCw className="size-4" aria-hidden />
              {result?.state === 'ready' ? 'Calculate again' : 'Ask HMRC to calculate'}
            </Button>
          )
        }
      />
      <div className="space-y-4 px-5 pb-5 sm:px-6">
        <p className="text-sm text-muted">
          HMRC works out your tax for the whole year from the quarterly updates it has, so it can lag behind your books. The app’s own
          estimate is in{' '}
          <Link className="text-accent-soft hover:underline" to="/reports/tax-estimate">
            Reports → Tax estimate
          </Link>
          .
          {hmrc?.environment === 'sandbox' && ' This is HMRC’s sandbox, so the figures are its worked example, not yours.'}
        </p>
        {trigger.error && <Alert>{trigger.error.message}</Alert>}
        {calc.isLoading ? (
          <Spinner label="Asking HMRC…" />
        ) : calc.error ? (
          <Alert>{calc.error.message}</Alert>
        ) : result?.state === 'none' ? (
          <p className="text-sm text-ink">HMRC hasn’t worked out the tax for {displayTaxYear(data.taxYear.label)} yet.</p>
        ) : result?.state === 'pending' ? (
          timedOut ? (
            <Alert tone="warning">HMRC is taking longer than usual. Come back to this page later to see the result.</Alert>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink">
              <LoaderCircle className="size-4 animate-spin text-accent-soft" aria-hidden />
              HMRC is working it out. This usually takes a few seconds.
            </p>
          )
        ) : result?.state === 'ready' ? (
          <>
            <p className="text-sm text-ink">
              {result.calculation.calculatedAt ? `Worked out on ${dateTime(result.calculation.calculatedAt)}` : 'Worked out'}, as{' '}
              {TYPES[result.calculation.type] ?? result.calculation.type}.
            </p>
            {/* Without figures the messages say why, so they come first; otherwise after the figures. */}
            {!result.calculation.figures && <Messages messages={result.calculation.messages} />}
          </>
        ) : null}
      </div>
      {result?.state === 'ready' && result.calculation.figures && (
        <>
          <Figures calculation={result.calculation} data={data} />
          <div className="space-y-3 px-5 py-4 text-sm text-muted sm:px-6">
            <Messages messages={result.calculation.messages} />
            {result.calculation.endOfYearTotalPence !== null && (
              <p>
                If the rest of the year goes the same way, HMRC expects your Income Tax and National Insurance to come to{' '}
                <strong className="text-ink">{formatGBP(result.calculation.endOfYearTotalPence)}</strong>.
              </p>
            )}
            <p className="text-xs text-faint">
              The app’s figures only include the tax caused by the business; HMRC’s include any other income it knows about.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CalendarCheck, CircleCheck, CircleDashed, FileCheck, FilePen, Landmark, LoaderCircle, Send } from 'lucide-react';
import {
  MTD_FIRST_SEND_YEAR,
  displayTaxYear,
  formatDisplayDate,
  formatGBP,
  mtdAmendmentDeadline,
  mtdPayload,
  selfAssessmentDeadline,
  startYearFromLabel,
  todayIso,
  type MtdFinalDeclaration,
  type MtdQuartersResponse,
  type TaxYear,
} from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { Alert, Badge, Button, Card, CardHeader, Spinner, type BadgeTone } from '../../components/ui';
import {
  useActiveTaxYear,
  useAgreeToCalculation,
  useCanEdit,
  useCategories,
  useHmrc,
  useHmrcCalculation,
  useMtdQuarters,
  useSendToHmrc,
  useTaxEstimate,
  useTriggerAgreementCalculation,
  type HmrcAgreement,
} from '../../lib/queries';
import { Bands, Figures, Messages, dateTime } from './HmrcCalculationCard';
import { PayloadSummary, sameFigures } from './MtdQuarterly';

/** Give up checking for a calculation HMRC is still working on after this long. */
const WAIT_MS = 2 * 60 * 1000;

/** HMRC's wording, which software must show and the person agree to before declaring. */
const DECLARATION =
  'I declare that the information and tax return I have submitted are (taken together) correct and complete to the best of my knowledge. I understand that I may have to pay financial penalties and face prosecution if I give false information.';

function Check({ done, children }: { done: boolean; children: ReactNode }) {
  const Icon = done ? CircleCheck : CircleDashed;
  return (
    <li className="flex gap-3">
      <Icon className={`mt-0.5 size-4 shrink-0 ${done ? 'text-ok' : 'text-faint'}`} aria-hidden />
      <div>{children}</div>
    </li>
  );
}

function Declared({ data }: { data: MtdQuartersResponse }) {
  const declaration = data.finalDeclaration!;
  const latest = data.amendments.at(-1) ?? declaration;
  return (
    <Card>
      <CardHeader icon={<FileCheck className="size-5 text-ok" />} title={`${displayTaxYear(data.taxYear.label)} is declared`} />
      <div className="space-y-3 px-5 pb-5 text-sm sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge tone="ok">Final declaration made</Badge>
          <span className="text-ink">
            {dateTime(declaration.at)} by {declaration.by}
            {declaration.environment === 'sandbox' && ', to HMRC’s sandbox'}
          </span>
        </div>
        <p className="text-ink">
          {data.amendments.length > 0 ? 'As amended, your' : 'You agreed that your'} Income Tax and National Insurance for the year come to{' '}
          <strong>{formatGBP(latest.totalDuePence)}</strong>. HMRC will show what to pay, and when, in your HMRC online account.
        </p>
        <Receipt record={declaration} />
      </div>
      {data.amendments.length > 0 && (
        <ul className="divide-y divide-line border-t border-line text-sm">
          {data.amendments.map((a, i) => (
            <li key={a.calculationId} className="space-y-1 px-5 py-3 sm:px-6">
              <p className="text-ink">
                <span className="font-medium">Amendment {i + 1}</span>: {dateTime(a.at)} by {a.by}, total{' '}
                <strong>{formatGBP(a.totalDuePence)}</strong>
              </p>
              <Receipt record={a} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Receipt({ record }: { record: MtdFinalDeclaration }) {
  return (
    <div className="space-y-1 text-muted">
      <p className="break-all">HMRC calculation ID {record.calculationId}</p>
      {record.correlationId && <p className="break-all">HMRC correlation ID {record.correlationId}</p>}
    </div>
  );
}

const AGREEMENT: Record<HmrcAgreement, { title: string; intro: string; button: string; done: string }> = {
  declaration: {
    title: 'HMRC’s final calculation',
    intro: 'HMRC checks the year’s figures, more strictly than during the year, and works out the tax you’ll agree to.',
    button: 'Make the final declaration',
    done: 'Nothing is declared until you agree below.',
  },
  amendment: {
    title: 'HMRC’s amended calculation',
    intro: 'HMRC works out the year’s tax again from the figures it now has, including any corrections you sent.',
    button: 'Confirm the amendment',
    done: 'Nothing changes at HMRC until you agree below.',
  },
};

/**
 * HMRC's calculation for a final declaration or an amendment, shown in full,
 * and HMRC's declaration statement to agree to it with.
 */
function AgreementCard({ taxYear, kind, ready, notReady }: { taxYear: TaxYear; kind: HmrcAgreement; ready: boolean; notReady: string }) {
  const canEdit = useCanEdit();
  const { data: hmrc } = useHmrc();
  const estimate = useTaxEstimate(taxYear.id);
  // The calculation asked for on this visit; it stays shown until the page is left or the year changes.
  const [requested, setRequested] = useState<{ id: string; since: number } | null>(null);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    setRequested(null);
    setAgreed(false);
  }, [taxYear.id]);
  const trigger = useTriggerAgreementCalculation(taxYear.id, kind);
  const calc = useHmrcCalculation(taxYear.id, requested?.id ?? null);
  const agree = useAgreeToCalculation(taxYear.id, kind);
  const text = AGREEMENT[kind];

  const result = calc.data;
  const timedOut = requested !== null && result?.state === 'pending' && Date.now() - requested.since > WAIT_MS;
  const calculation = result?.state === 'ready' ? result.calculation : null;
  const agreeable = calculation?.figures && calculation.messages.errors.length === 0 ? calculation : null;
  const busy = trigger.isPending || (result?.state === 'pending' && !timedOut);

  const ask = () => {
    setAgreed(false);
    agree.reset();
    trigger.mutate(undefined, { onSuccess: ({ calculationId }) => setRequested({ id: calculationId, since: Date.now() }) });
  };

  return (
    <Card className="print:break-inside-avoid">
      <CardHeader
        icon={<Landmark className="size-5 text-accent-soft" />}
        title={`${text.title} for ${displayTaxYear(taxYear.label)}`}
        action={
          canEdit && (
            <Button className="print:hidden" onClick={ask} busy={trigger.isPending} disabled={!ready || busy}>
              {calculation ? 'Calculate again' : 'Ask HMRC to calculate'}
            </Button>
          )
        }
      />
      <div className="space-y-4 px-5 pb-5 text-sm sm:px-6">
        <p className="text-muted">
          {text.intro} {text.done}
          {hmrc?.environment === 'sandbox' && ' This is HMRC’s sandbox, so the figures are its worked example, not yours.'}
        </p>
        {trigger.error && <Alert>{trigger.error.message}</Alert>}
        {!requested ? (
          <p className="text-ink">
            {!canEdit
              ? 'An editor can ask HMRC to calculate.'
              : ready
                ? 'Choose “Ask HMRC to calculate” when you’re ready. It takes a few seconds.'
                : notReady}
          </p>
        ) : calc.isLoading ? (
          <Spinner label="Asking HMRC…" />
        ) : calc.error ? (
          <Alert>{calc.error.message}</Alert>
        ) : result?.state === 'pending' ? (
          timedOut ? (
            <Alert tone="warning">HMRC is taking longer than usual. Try asking it to calculate again in a few minutes.</Alert>
          ) : (
            <p className="flex items-center gap-2 text-ink">
              <LoaderCircle className="size-4 animate-spin text-accent-soft" aria-hidden />
              HMRC is working it out. This usually takes a few seconds.
            </p>
          )
        ) : calculation ? (
          <>
            <p className="text-ink">{calculation.calculatedAt ? `Worked out at ${dateTime(calculation.calculatedAt)}` : 'Worked out'}.</p>
            {!agreeable && (
              <>
                <Messages messages={calculation.messages} />
                <p className="text-ink">
                  HMRC won’t accept the year until these are put right. Fix them, send any corrected figures, then ask HMRC to calculate
                  again.
                </p>
              </>
            )}
          </>
        ) : null}
      </div>
      {agreeable && estimate.data && (
        <>
          <Figures calculation={agreeable} data={estimate.data} />
          <div className="px-5 pt-5 text-xs font-medium tracking-wide text-muted uppercase sm:px-6">How HMRC worked it out</div>
          <Bands bands={agreeable.bands} />
          {(agreeable.messages.warnings.length > 0 || agreeable.messages.info.length > 0) && (
            <div className="space-y-3 px-5 pt-4 text-sm sm:px-6">
              <Messages messages={agreeable.messages} />
            </div>
          )}
        </>
      )}
      {agreeable && canEdit && (
        <div className="m-5 space-y-4 rounded-lg border border-line bg-surface p-4 text-sm sm:m-6">
          <p className="text-muted">
            Before you can submit the information displayed here in response to your notice to file from HM Revenue &amp; Customs, you
            must read and agree to the following statement.
          </p>
          <label className="flex items-start gap-3 text-ink">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            {DECLARATION}
          </label>
          {agree.error && <Alert>{agree.error.message}</Alert>}
          <Button
            variant="primary"
            disabled={!agreed}
            busy={agree.isPending}
            onClick={() =>
              agree.mutate(
                { calculationId: agreeable.calculationId, totalDuePence: agreeable.figures!.totalDuePence },
                { onSuccess: () => setRequested(null) },
              )
            }
          >
            <FileCheck className="size-4" aria-hidden />
            {text.button}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Before the final declaration: what has to be done first, then HMRC's calculation to agree to. */
function Declare({ data }: { data: MtdQuartersResponse }) {
  const { data: hmrc } = useHmrc();
  const { taxYear } = data;
  const year = displayTaxYear(taxYear.label);
  const connected = Boolean(hmrc?.connection && hmrc.nino);
  const ended = todayIso() > taxYear.endDate;
  const missing = data.quarters.filter((q) => !q.submission).map((q) => `Q${q.quarter}`);

  return (
    <>
      <Card>
        <CardHeader icon={<CalendarCheck className="size-5 text-accent-soft" />} title="Before you declare" />
        <ul className="space-y-3 px-5 pb-5 text-sm text-ink sm:px-6">
          <Check done={connected}>
            {connected ? (
              'Connected to HMRC.'
            ) : (
              <>
                Connect to HMRC in{' '}
                <Link className="text-accent-soft hover:underline" to="/settings/hmrc">
                  Settings → HMRC
                </Link>
                .
              </>
            )}
          </Check>
          <Check done={ended}>
            {ended
              ? `The ${year} tax year has ended.`
              : `The ${year} tax year ends on ${formatDisplayDate(taxYear.endDate)}. HMRC takes the final declaration from the day after.`}
          </Check>
          <Check done={missing.length === 0}>
            {missing.length === 0 ? (
              'HMRC has all four quarterly updates.'
            ) : (
              <>
                Send the quarterly update{missing.length > 1 ? 's' : ''} for {missing.join(', ')} from{' '}
                <Link className="text-accent-soft hover:underline" to="/mtd/quarterly">
                  Quarterly updates
                </Link>
                . Your last update should include any changes made since the earlier ones.
              </>
            )}
          </Check>
          <Check done={false}>
            The app only reports this business. Tell HMRC about any other income (a job, savings, property, pensions) and any reliefs in your
            HMRC online account before you declare.
          </Check>
        </ul>
        <p className="border-t border-line px-5 py-3 text-sm text-muted sm:px-6">
          The deadline is {formatDisplayDate(selfAssessmentDeadline(startYearFromLabel(taxYear.label)!))}, which is also when any tax for
          the year is due.
        </p>
      </Card>
      <AgreementCard
        taxYear={taxYear}
        kind="declaration"
        ready={connected && ended && missing.length === 0}
        notReady="You can ask HMRC once the steps above are done."
      />
    </>
  );
}

/**
 * After the final declaration: correct the books, send the whole year's
 * figures again, then agree to HMRC's amended calculation.
 */
function Amend({ data }: { data: MtdQuartersResponse }) {
  const canEdit = useCanEdit();
  const { data: hmrc } = useHmrc();
  const { data: categories = [] } = useCategories();
  const { taxYear } = data;
  const send = useSendToHmrc(taxYear.id);
  const [confirming, setConfirming] = useState(false);
  const deadline = mtdAmendmentDeadline(startYearFromLabel(taxYear.label)!);
  const connected = Boolean(hmrc?.connection && hmrc.nino && hmrc.business);

  if (todayIso() > deadline) {
    return (
      <Alert tone="warning">
        {displayTaxYear(taxYear.label)} could be amended until {formatDisplayDate(deadline)}. To change it now, contact HMRC.
      </Alert>
    );
  }
  if (!canEdit) return null;

  const q4 = data.quarters.find((q) => q.quarter === 4)!;
  const payload = mtdPayload(q4.cumulative, taxYear.startDate, q4.endDate);
  const sent = q4.submission?.sent ?? null;
  const upToDate = sent !== null && sameFigures(sent.payload, payload);
  const status: { tone: BadgeTone; label: string; detail: string } = upToDate
    ? { tone: 'ok', label: 'HMRC has your figures', detail: `The year’s figures were sent on ${formatDisplayDate(sent.at.slice(0, 10))}` }
    : sent
      ? { tone: 'warn', label: 'Your books have changed', detail: `Since the year’s figures were sent on ${formatDisplayDate(sent.at.slice(0, 10))}` }
      : { tone: 'warn', label: 'Not sent from here', detail: 'The app hasn’t sent the year’s figures, so it can’t tell what HMRC has' };

  return (
    <>
      <Card>
        <CardHeader icon={<FilePen className="size-5 text-accent-soft" />} title={`Amend ${displayTaxYear(taxYear.label)}`} />
        <div className="space-y-4 px-5 pb-5 text-sm sm:px-6">
          <p className="text-muted">
            You can change the year until {formatDisplayDate(deadline)}. Correct your books, send the corrected figures for the whole
            year, then ask HMRC to work out the tax again and confirm it. Changes to other income are made in your HMRC online account.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="text-ink">{status.detail}</span>
          </div>
          {!upToDate && (
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={!connected}>
              <Send className="size-4" aria-hidden />
              Send the corrected figures
            </Button>
          )}
          {send.error && !confirming && <Alert>{send.error.message}</Alert>}
        </div>
      </Card>
      <ConfirmDialog
        open={confirming}
        tone="send"
        wide
        title={`Send the corrected figures for ${displayTaxYear(taxYear.label)}?`}
        confirmLabel="Send to HMRC"
        onClose={() => setConfirming(false)}
        onConfirm={() => send.mutateAsync({ quarter: 4, payload })}
      >
        <p>
          The whole year’s figures for {hmrc?.business?.tradingName ?? hmrc?.business?.businessId}, {formatDisplayDate(taxYear.startDate)}{' '}
          to {formatDisplayDate(taxYear.endDate)}:
        </p>
        <PayloadSummary payload={payload} categories={categories} />
        <p>They replace the figures HMRC has. The year isn’t amended until you confirm HMRC’s new calculation.</p>
      </ConfirmDialog>
      <AgreementCard taxYear={taxYear} kind="amendment" ready={connected} notReady="Connect to HMRC to amend the year." />
    </>
  );
}

/**
 * The end of an MTD year: once it has ended and every quarterly update is in,
 * HMRC works out the year's tax, and the person agrees to it with HMRC's
 * declaration. Afterwards the year can be amended for a while.
 */
export function FinalDeclaration() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMtdQuarters(taxYear?.id);
  const startYear = taxYear ? (startYearFromLabel(taxYear.label) ?? 0) : 0;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Final declaration"
        description="After the tax year ends, confirm HMRC’s calculation of your tax. It takes the place of a Self Assessment return."
      />
      {yearLoading || (taxYear && isLoading) ? (
        <Spinner />
      ) : !taxYear ? (
        <NoTaxYear />
      ) : error || !data ? (
        <Alert>{error?.message ?? 'Could not load the tax year'}</Alert>
      ) : startYear < MTD_FIRST_SEND_YEAR ? (
        <Alert tone="warning">
          HMRC takes final declarations through Making Tax Digital from the 2025/26 tax year. Send {displayTaxYear(taxYear.label)} on a
          Self Assessment return.
        </Alert>
      ) : data.finalDeclaration ? (
        <>
          <Declared data={data} />
          <Amend data={data} />
        </>
      ) : (
        <Declare data={data} />
      )}
    </div>
  );
}

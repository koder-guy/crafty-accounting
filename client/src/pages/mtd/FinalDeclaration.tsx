import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CalendarCheck, CircleCheck, CircleDashed, FileCheck, Landmark, LoaderCircle } from 'lucide-react';
import {
  MTD_FIRST_SEND_YEAR,
  displayTaxYear,
  formatDisplayDate,
  formatGBP,
  selfAssessmentDeadline,
  startYearFromLabel,
  todayIso,
  type MtdFinalDeclaration,
  type TaxYear,
} from '@crafty/shared';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { Alert, Badge, Button, Card, CardHeader, Spinner } from '../../components/ui';
import {
  useActiveTaxYear,
  useCanEdit,
  useHmrc,
  useHmrcCalculation,
  useMakeFinalDeclaration,
  useMtdQuarters,
  useTaxEstimate,
  useTriggerFinalCalculation,
} from '../../lib/queries';
import { Bands, Figures, Messages, dateTime } from './HmrcCalculationCard';

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

function Declared({ declaration, taxYear }: { declaration: MtdFinalDeclaration; taxYear: TaxYear }) {
  return (
    <Card>
      <CardHeader icon={<FileCheck className="size-5 text-ok" />} title={`${displayTaxYear(taxYear.label)} is declared`} />
      <div className="space-y-3 px-5 pb-5 text-sm sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge tone="ok">Final declaration made</Badge>
          <span className="text-ink">
            {dateTime(declaration.at)} by {declaration.by}
            {declaration.environment === 'sandbox' && ', to HMRC’s sandbox'}
          </span>
        </div>
        <p className="text-ink">
          You agreed to HMRC’s calculation of <strong>{formatGBP(declaration.totalDuePence)}</strong> Income Tax and National Insurance
          for the year. HMRC will show what to pay, and when, in your HMRC online account.
        </p>
        <div className="space-y-1 text-muted">
          <p className="break-all">HMRC calculation ID {declaration.calculationId}</p>
          {declaration.correlationId && <p className="break-all">HMRC correlation ID {declaration.correlationId}</p>}
        </div>
      </div>
    </Card>
  );
}

/**
 * The end of an MTD year: once it has ended and every quarterly update is in,
 * HMRC works out the year's tax, and the person agrees to it with HMRC's
 * declaration. Changing a declared year (an amendment) isn't in the app yet.
 */
export function FinalDeclaration() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMtdQuarters(taxYear?.id);
  const { data: hmrc } = useHmrc();
  const estimate = useTaxEstimate(taxYear?.id);
  const canEdit = useCanEdit();
  const taxYearId = taxYear?.id;

  // The calculation asked for on this visit; it stays shown until the page is left or the year changes.
  const [requested, setRequested] = useState<{ id: string; since: number } | null>(null);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    setRequested(null);
    setAgreed(false);
  }, [taxYearId]);
  const trigger = useTriggerFinalCalculation(taxYearId);
  const calc = useHmrcCalculation(taxYearId, requested?.id ?? null);
  const declare = useMakeFinalDeclaration(taxYearId);

  const startYear = taxYear ? (startYearFromLabel(taxYear.label) ?? 0) : 0;
  const year = taxYear ? displayTaxYear(taxYear.label) : '';
  const connected = Boolean(hmrc?.connection && hmrc.nino);
  const ended = taxYear ? todayIso() > taxYear.endDate : false;
  const missing = (data?.quarters ?? []).filter((q) => !q.submission).map((q) => `Q${q.quarter}`);
  const ready = connected && ended && missing.length === 0;

  const result = calc.data;
  const timedOut = requested !== null && result?.state === 'pending' && Date.now() - requested.since > WAIT_MS;
  const calculation = result?.state === 'ready' ? result.calculation : null;
  const agreeable = calculation?.figures && calculation.messages.errors.length === 0 ? calculation : null;
  const busy = trigger.isPending || (result?.state === 'pending' && !timedOut);

  const ask = () => {
    setAgreed(false);
    declare.reset();
    trigger.mutate(undefined, { onSuccess: ({ calculationId }) => setRequested({ id: calculationId, since: Date.now() }) });
  };

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
          HMRC takes final declarations through Making Tax Digital from the 2025/26 tax year. Send {year} on a Self Assessment return.
        </Alert>
      ) : data.finalDeclaration ? (
        <Declared declaration={data.finalDeclaration} taxYear={taxYear} />
      ) : (
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
                The app only reports this business. Tell HMRC about any other income (a job, savings, property, pensions) and any reliefs in
                your HMRC online account before you declare.
              </Check>
            </ul>
            <p className="border-t border-line px-5 py-3 text-sm text-muted sm:px-6">
              The deadline is {formatDisplayDate(selfAssessmentDeadline(startYear))}, which is also when any tax for the year is due.
            </p>
          </Card>

          <Card className="print:break-inside-avoid">
            <CardHeader
              icon={<Landmark className="size-5 text-accent-soft" />}
              title={`HMRC’s final calculation for ${year}`}
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
                HMRC checks the year’s figures, more strictly than during the year, and works out the tax you’ll agree to. Nothing is
                declared until you agree below.
                {hmrc?.environment === 'sandbox' && ' This is HMRC’s sandbox, so the figures are its worked example, not yours.'}
              </p>
              {trigger.error && <Alert>{trigger.error.message}</Alert>}
              {!requested ? (
                <p className="text-ink">
                  {!canEdit
                    ? 'An editor can ask HMRC for the final calculation.'
                    : ready
                      ? 'Choose “Ask HMRC to calculate” when everything above is done. It takes a few seconds.'
                      : 'You can ask HMRC once the steps above are done.'}
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
                  <p className="text-ink">
                    {calculation.calculatedAt ? `Worked out at ${dateTime(calculation.calculatedAt)}` : 'Worked out'}.
                  </p>
                  {!agreeable && (
                    <>
                      <Messages messages={calculation.messages} />
                      <p className="text-ink">
                        HMRC can’t finalise the year until these are put right. Fix them, send any changed quarterly update, then ask HMRC to
                        calculate again.
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
                  Before you can submit the information displayed here in response to your notice to file from HM Revenue &amp; Customs,
                  you must read and agree to the following statement.
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
                {declare.error && <Alert>{declare.error.message}</Alert>}
                <Button
                  variant="primary"
                  disabled={!agreed}
                  busy={declare.isPending}
                  onClick={() => declare.mutate({ calculationId: agreeable.calculationId, totalDuePence: agreeable.figures!.totalDuePence })}
                >
                  <FileCheck className="size-4" aria-hidden />
                  Make the final declaration
                </Button>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

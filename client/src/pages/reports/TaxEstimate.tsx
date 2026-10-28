import { useState, type FormEvent, type ReactNode } from 'react';
import { CalendarClock, Calculator, Printer, Wallet } from 'lucide-react';
import {
  APP_NAME,
  displayTaxYear,
  formatDisplayDate,
  formatGBP,
  parsePoundsToPence,
  penceToPounds,
  PAYMENTS_ON_ACCOUNT_THRESHOLD_PENCE,
  startYearFromLabel,
  taxRatesFor,
  taxYearFromStartYear,
  todayIso,
  TRADING_ALLOWANCE_PENCE,
  type TaxEstimateResponse,
} from '@crafty/shared';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { Alert, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useActiveTaxYear, useCanEdit, useTaxEstimate, useTaxSettings } from '../../lib/queries';
import { printPage } from '../../lib/liveUpdates';

const whole = (pence: number) => formatGBP(pence).replace(/\.00$/, '');
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

function Row({ label, detail, amount, strong = false }: { label: ReactNode; detail?: ReactNode; amount: ReactNode; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-semibold text-white' : 'text-ink'}>
      <td className="py-2.5 pr-3 pl-5 sm:pl-6">
        {label}
        {detail && <div className="text-xs font-normal text-muted">{detail}</div>}
      </td>
      <td className="tabular py-2.5 pr-5 pl-3 text-right align-top whitespace-nowrap sm:pr-6">{amount}</td>
    </tr>
  );
}

function OtherIncomeForm({ data }: { data: TaxEstimateResponse }) {
  const save = useTaxSettings();
  const saved = data.taxYear.otherIncomePence;
  const [value, setValue] = useState(saved ? penceToPounds(saved) : '');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pence = value.trim() === '' ? 0 : parsePoundsToPence(value);
    if (pence === null || pence < 0) return setError('Enter an amount, e.g. 18000, or leave it blank for none');
    setError(null);
    save.mutate({ taxYearId: data.taxYear.id, otherIncomePence: pence });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6 print:hidden">
      <p className="text-sm text-muted">
        A salary, pension or other taxable income uses up some of your tax-free allowance and lower tax bands, so more of your profit is
        taxed at higher rates. The tax on that income itself is assumed to be paid through PAYE, so the estimate only shows the extra tax
        from the business.
      </p>
      <Field
        label="Other taxable income for the year (£)"
        htmlFor="other-income"
        hint="The full amount before tax is taken off, e.g. your gross salary or pension"
        error={error ?? save.error?.message}
      >
        <div className="flex flex-wrap gap-3">
          <input
            id="other-income"
            inputMode="decimal"
            placeholder="0.00"
            className="field tabular w-48"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" busy={save.isPending}>
            Update estimate
          </Button>
        </div>
      </Field>
    </form>
  );
}

export function TaxEstimate() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useTaxEstimate(taxYear?.id);
  const today = todayIso();

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Tax estimate"
        description="A guide to the Income Tax and Class 4 National Insurance on your profit, so you know how much to put aside."
        actions={
          data && (
            <Button onClick={printPage}>
              <Printer className="size-4" aria-hidden />
              Print / Save as PDF
            </Button>
          )
        }
      />
      {yearLoading || (taxYear && isLoading) ? (
        <Spinner />
      ) : !taxYear ? (
        <NoTaxYear />
      ) : error || !data ? (
        <Alert>{error?.message ?? 'Could not work out the estimate'}</Alert>
      ) : (
        <EstimateBody data={data} today={today} />
      )}
    </div>
  );
}

function EstimateBody({ data, today }: { data: TaxEstimateResponse; today: string }) {
  const canEdit = useCanEdit();
  const e = data.estimate;
  const rates = taxRatesFor(data.taxYear.label).rates;
  const year = displayTaxYear(data.taxYear.label);
  const nextYear = displayTaxYear(taxYearFromStartYear(startYearFromLabel(data.taxYear.label)! + 1).label);

  return (
    <>
      <p className="hidden text-sm print:block">
        {APP_NAME} · tax year {year} · printed {formatDisplayDate(today)}
      </p>

      {today <= data.taxYear.endDate && (
        <Alert tone="warning">
          This tax year hasn't finished, so this is the tax on your profit so far
          {data.recordedTo ? ` (recorded up to ${formatDisplayDate(data.recordedTo)})` : ''}. It will grow as you record more income.
        </Alert>
      )}
      {e.ratesAssumed && (
        <Alert tone="warning">
          The app doesn't have HMRC's rates for {year} yet, so this uses the {displayTaxYear(e.ratesLabel)} rates.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="eyebrow">Estimated tax</div>
          <div className="tabular mt-2 text-2xl font-bold text-accent-soft">{formatGBP(e.totalPence)}</div>
          <div className="mt-1 text-xs text-muted">Income Tax and Class 4 National Insurance</div>
        </Card>
        <Card className="p-5">
          <div className="eyebrow">Put aside</div>
          <div className="tabular mt-2 text-2xl font-bold text-white">{percent(e.setAsideRate)}</div>
          <div className="mt-1 text-xs text-muted">of your profit so far</div>
        </Card>
        <Card className="p-5">
          <div className="eyebrow">Taxable profit</div>
          <div className="tabular mt-2 text-2xl font-bold text-white">{formatGBP(e.profitPence)}</div>
          <div className="mt-1 text-xs text-muted">
            {data.netLossPence > 0
              ? `A loss of ${formatGBP(data.netLossPence)}, so no tax`
              : data.usesTradingAllowance
                ? `Using the ${whole(TRADING_ALLOWANCE_PENCE)} trading allowance, which beats your expenses`
                : 'From the Year-end summary'}
          </div>
        </Card>
      </div>

      <Card className="print:break-inside-avoid">
        <CardHeader icon={<Calculator className="size-5 text-accent-soft" />} title="How it's worked out" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <tbody className="divide-y divide-line border-t border-line">
              <Row label="Taxable profit from the business" amount={formatGBP(e.profitPence)} />
              {e.otherIncomePence > 0 && (
                <Row
                  label="Other taxable income"
                  detail="Its own tax is assumed to be paid through PAYE, so it only affects the rate your profit is taxed at"
                  amount={formatGBP(e.otherIncomePence)}
                />
              )}
              <Row
                label="Personal allowance"
                detail={
                  e.personalAllowancePence < rates.personalAllowancePence
                    ? `Reduced from ${whole(rates.personalAllowancePence)}: it shrinks by £1 for every £2 of income over ${whole(rates.allowanceTaperFromPence)}`
                    : 'Income you can have before paying Income Tax'
                }
                amount={formatGBP(e.personalAllowancePence)}
              />
              <Row
                label="Income Tax on the profit"
                detail={`${percent(rates.basicRate)} basic rate, ${percent(rates.higherRate)} higher rate above ${whole(rates.personalAllowancePence + rates.basicRateBandPence)}, ${percent(rates.additionalRate)} above ${whole(rates.additionalRateFromPence)}`}
                amount={formatGBP(e.incomeTaxPence)}
              />
              <Row
                label="Class 4 National Insurance"
                detail={`${percent(rates.class4MainRate)} of profit between ${whole(rates.class4LowerLimitPence)} and ${whole(rates.class4UpperLimitPence)}${e.class4UpperPence > 0 ? `, ${percent(rates.class4UpperRate)} above (${formatGBP(e.class4UpperPence)})` : ''}`}
                amount={formatGBP(e.class4Pence)}
              />
              <Row label="Estimated tax" amount={formatGBP(e.totalPence)} strong />
            </tbody>
          </table>
        </div>
        {canEdit && <OtherIncomeForm key={`${data.taxYear.id}-${data.taxYear.otherIncomePence}`} data={data} />}
      </Card>

      <Card className="print:break-inside-avoid">
        <CardHeader icon={<CalendarClock className="size-5 text-accent-soft" />} title="When it's due" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <tbody className="divide-y divide-line border-t border-line">
              <Row
                label={`${formatDisplayDate(data.dueDates.balancing)}: tax for ${year}`}
                detail={`Less any payments on account you've already made towards ${year}`}
                amount={formatGBP(e.totalPence)}
              />
              {e.paymentOnAccountPence !== null && (
                <>
                  <Row
                    label={`${formatDisplayDate(data.dueDates.balancing)}: first payment on account for ${nextYear}`}
                    detail="Half of this year's bill, paid in advance towards next year's"
                    amount={formatGBP(e.paymentOnAccountPence)}
                  />
                  <Row
                    label={`${formatDisplayDate(data.dueDates.secondPaymentOnAccount)}: second payment on account for ${nextYear}`}
                    amount={formatGBP(e.paymentOnAccountPence)}
                  />
                </>
              )}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-4 text-sm text-muted sm:px-6">
          {e.paymentOnAccountPence !== null
            ? `Because the bill is over ${whole(PAYMENTS_ON_ACCOUNT_THRESHOLD_PENCE)}, HMRC will usually ask for payments on account towards next year as well, unless most of your tax is already taken through PAYE. You can ask HMRC to reduce them if you expect to earn less.`
            : `The bill is ${whole(PAYMENTS_ON_ACCOUNT_THRESHOLD_PENCE)} or less, so you won't need to make payments on account towards next year.`}
        </p>
      </Card>

      <p className="flex items-start gap-2 text-xs text-faint">
        <Wallet className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        An estimate using the Income Tax rates for England, Wales and Northern Ireland; Scottish rates and bands are different. It
        doesn't include student loan repayments, the High Income Child Benefit Charge, pension contributions, Gift Aid, Marriage
        Allowance, tax on savings or dividends, or voluntary Class 2 National Insurance. It isn't tax advice.
      </p>
    </>
  );
}

import type { ReactNode } from 'react';
import { CircleAlert, FileText, Printer, Scale } from 'lucide-react';
import {
  APP_NAME,
  displayTaxYear,
  formatDisplayDate,
  formatGBP,
  todayIso,
  type Category,
  type Sa103sBox,
  type YearEndSummaryResponse,
} from '@crafty/shared';
import { MileageCheckAlert } from '../../components/MileageCheckAlert';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { Alert, Button, Card, CardHeader, Spinner } from '../../components/ui';
import { useActiveTaxYear, useCategories, useYearEndSummary } from '../../lib/queries';
import { printPage } from '../../lib/liveUpdates';

const whole = (pence: number) => formatGBP(pence).replace(/\.00$/, '');

function BoxRow({ box, label, amount, strong = false }: { box: string; label: ReactNode; amount: number; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-semibold text-white' : amount === 0 ? 'text-faint' : 'text-ink'}>
      <td className="w-16 py-2.5 pr-2 pl-5 align-top sm:pl-6">
        <span className="inline-flex min-w-9 justify-center rounded-md border border-line-strong px-1.5 py-0.5 text-xs font-medium text-muted">
          {box}
        </span>
      </td>
      <td className="px-3 py-2.5">{label}</td>
      <td className="tabular px-5 py-2.5 text-right whitespace-nowrap sm:pr-6">{formatGBP(amount)}</td>
    </tr>
  );
}

function SectionRow({ children }: { children: ReactNode }) {
  return (
    <tr className="bg-surface-2/60">
      <th colSpan={3} scope="colgroup" className="px-5 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase sm:px-6">
        {children}
      </th>
    </tr>
  );
}

/** The range of expense boxes on this year's form, such as "boxes 11 to 19". */
const expenseBoxRange = ({ expenseBoxes }: YearEndSummaryResponse['summary']) =>
  `boxes ${expenseBoxes[0].box} to ${expenseBoxes[expenseBoxes.length - 1].box}`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 text-sm text-ink">{children}</div>
    </div>
  );
}

function Sa103sTable({ data }: { data: YearEndSummaryResponse }) {
  const s = data.summary;
  const rows = (boxes: Sa103sBox[]) => boxes.map((b) => <BoxRow key={b.box} box={b.box} label={b.label} amount={b.amountPence} />);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr className="border-y border-line">
            <th scope="col" className="py-3 pr-2 pl-5 text-left font-medium sm:pl-6">Box</th>
            <th scope="col" className="px-3 py-3 text-left font-medium">Description</th>
            <th scope="col" className="px-5 py-3 text-right font-medium sm:pr-6">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          <SectionRow>Business income</SectionRow>
          {rows(s.incomeBoxes)}
          <SectionRow>Allowable business expenses</SectionRow>
          {rows(s.expenseBoxes)}
          <BoxRow box={s.form.totalExpenses.box} label={s.form.totalExpenses.label} amount={s.totalAllowableExpensesPence} strong />
          <SectionRow>Net profit or loss</SectionRow>
          {s.netLossPence > 0 ? (
            <BoxRow box={s.form.netLoss.box} label={s.form.netLoss.label} amount={s.netLossPence} strong />
          ) : (
            <BoxRow box={s.form.netProfit.box} label={s.form.netProfit.label} amount={s.netProfitPence} strong />
          )}
        </tbody>
      </table>
    </div>
  );
}

function NotOnForm({ data, names }: { data: YearEndSummaryResponse; names: Map<string, string> }) {
  const s = data.summary;
  if (s.disallowable.length === 0 && s.notAllowable.length === 0 && s.checks.length === 0) return null;
  const name = (code: string) => names.get(code) ?? code;
  return (
    <Card className="print:break-inside-avoid">
      <CardHeader icon={<CircleAlert className="size-5 text-accent-soft" />} title="Recorded but not entered on the form" />
      <div className="space-y-5 px-5 pb-6 text-sm sm:px-6">
        {s.disallowable.length > 0 && (
          <div>
            <p className="mb-2 text-muted">Disallowable parts of expenses (left out of {expenseBoxRange(s)}):</p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {s.disallowable.map((d) => (
                <li key={d.hmrcCode} className="flex justify-between gap-4 px-4 py-2">
                  <span>{name(d.hmrcCode)}</span>
                  <span className="tabular">{formatGBP(d.amountPence)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.notAllowable.map((e) => (
          <Alert key={e.hmrcCode} tone="warning">
            <strong>{name(e.hmrcCode)}</strong>: {formatGBP(e.amountPence)} not claimed. {e.reason}
          </Alert>
        ))}
        {s.checks.map((e) => (
          <Alert key={e.hmrcCode} tone="warning">
            <strong>{name(e.hmrcCode)}</strong>: {formatGBP(e.amountPence)} is included in box {e.box}. {e.reason}
          </Alert>
        ))}
      </div>
    </Card>
  );
}

function TradingAllowance({ data }: { data: YearEndSummaryResponse }) {
  const { form, tradingAllowance: t, expenseBoxes } = data.summary;
  const allowance = whole(t.allowancePence);
  return (
    <Card className="print:break-inside-avoid">
      <CardHeader icon={<Scale className="size-5 text-accent-soft" />} title="Trading allowance check" />
      <div className="space-y-4 px-5 pb-6 text-sm sm:px-6">
        <p className="text-muted">
          Instead of claiming expenses you can deduct the {allowance} trading allowance from your income (box {form.tradingAllowanceBox}). You can't do both. {t.provisional}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={`rounded-lg border p-4 ${t.better === 'expenses' ? 'border-ok/50 bg-ok/10' : 'border-line'}`}>
            <div className="eyebrow">Claiming your expenses</div>
            <div className="tabular mt-2 text-xl font-semibold text-white">{formatGBP(t.profitWithExpensesPence)}</div>
            <div className="mt-1 text-xs text-muted">taxable profit</div>
          </div>
          <div className={`rounded-lg border p-4 ${t.better === 'allowance' ? 'border-ok/50 bg-ok/10' : 'border-line'}`}>
            <div className="eyebrow">Using the {allowance} allowance</div>
            <div className="tabular mt-2 text-xl font-semibold text-white">{formatGBP(t.profitWithAllowancePence)}</div>
            <div className="mt-1 text-xs text-muted">taxable profit</div>
          </div>
        </div>
        <p className="text-ink">
          {t.incomeWithinAllowance
            ? `Your business income is ${allowance} or less, so you may not need to report it at all. Check GOV.UK if you have to fill in a return for other reasons.`
            : t.better === 'allowance'
              ? `The trading allowance gives a lower profit by ${formatGBP(t.profitWithExpensesPence - t.profitWithAllowancePence)}. Enter ${allowance} in box ${form.tradingAllowanceBox} and leave boxes ${expenseBoxes[0].box} to ${form.totalExpenses.box} blank.`
              : t.better === 'expenses'
                ? `Claiming your expenses gives a lower profit by ${formatGBP(t.profitWithAllowancePence - t.profitWithExpensesPence)}, so use the figures above.`
                : 'Both give the same profit.'}
        </p>
      </div>
    </Card>
  );
}

export function YearEndSummary() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useYearEndSummary(taxYear?.id);
  const { data: categories = [] } = useCategories();
  const names = new Map(categories.filter((c: Category) => !c.isCustom).map((c) => [c.hmrcCode, c.name]));
  const today = todayIso();

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Year-end summary"
        description="Figures for the Self Assessment self-employment (short) pages for the active tax year."
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
          <Alert>{error?.message ?? 'Could not load the year-end summary'}</Alert>
        ) : (
          <>
            <p className="hidden text-sm print:block">
              {APP_NAME} · printed {formatDisplayDate(today)}
            </p>

            <Card className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-4 print:break-inside-avoid">
              <Fact label="Tax year">
                {displayTaxYear(data.taxYear.label)} ({formatDisplayDate(data.taxYear.startDate)} to {formatDisplayDate(data.taxYear.endDate)})
              </Fact>
              <Fact label="Accounting method">Cash basis</Fact>
              <Fact label="Online filing and payment deadline">{formatDisplayDate(data.filingDeadline)}</Fact>
              <Fact label={data.summary.netLossPence > 0 ? 'Net loss' : 'Net profit'}>
                <span className="tabular text-base font-semibold text-accent-soft">
                  {formatGBP(data.summary.netLossPence || data.summary.netProfitPence)}
                </span>
              </Fact>
            </Card>

            {today <= data.taxYear.endDate && (
              <Alert tone="warning">This tax year hasn't finished yet, so these are the figures so far, not final ones.</Alert>
            )}
            {data.summary.turnoverOverShortFormLimit && (
              <Alert tone="warning">
                Your turnover is {whole(data.summary.form.turnoverLimitPence)} or more, so you'll need the full self-employment pages (SA103F) rather than the short ones.
              </Alert>
            )}

            {data.summary.form.assumed && (
              <Alert tone="warning">
                The app hasn't been checked against HMRC's {displayTaxYear(data.taxYear.label)} form yet, so this uses the box numbers from the{' '}
                {displayTaxYear(data.summary.form.label)} form.
              </Alert>
            )}

            {data.mileageCheck && <MileageCheckAlert check={data.mileageCheck} />}

            <Card className="print:break-inside-avoid">
              <CardHeader icon={<FileText className="size-5 text-accent-soft" />} title="Self-employment (short) – SA103S" />
              <Sa103sTable data={data} />
            </Card>

            <NotOnForm data={data} names={names} />
            <TradingAllowance data={data} />

            <p className="text-xs text-faint">
              A summary of the transactions in this app, laid out like HMRC's SA103S (box numbers from the {displayTaxYear(data.summary.form.label)} form). It isn't tax
              advice and doesn't cover the rest of your return or the tax due. Check the box numbers against the {displayTaxYear(data.taxYear.label)}{' '}
              form and notes on GOV.UK when you file.
            </p>
          </>
        )}
    </div>
  );
}

// Year-end figures for the Self Assessment 'Self-employment (short)' pages
// (SA103S), worked out from the same MTD period summary used elsewhere.
//
// Box numbers and wording follow HMRC's form for each tax year, in SA103S_FORMS.
// Each year, compare HMRC's new form with the latest entry and add the year,
// reusing the same form if the boxes this app fills in haven't changed.
import type { MtdPeriodSummary } from './mtd';

export interface Sa103sLine {
  box: string;
  label: string;
}

export interface Sa103sBoxDefinition extends Sa103sLine {
  /** MTD category codes whose allowable amounts go in this box. */
  codes: string[];
}

export interface Sa103sForm {
  incomeBoxes: Sa103sBoxDefinition[];
  expenseBoxes: Sa103sBoxDefinition[];
  totalExpenses: Sa103sLine;
  netProfit: Sa103sLine;
  netLoss: Sa103sLine;
  tradingAllowanceBox: string;
  /** Turnover at or above this means the full SA103F form is needed. */
  turnoverLimitPence: number;
}

const FORM_2024_25: Sa103sForm = {
  incomeBoxes: [
    { box: '9', label: 'Your turnover – the takings, fees, sales or money earned by your business', codes: ['turnover'] },
    { box: '10', label: 'Any other business income not included in box 9', codes: ['other'] },
  ],
  expenseBoxes: [
    { box: '11', label: 'Costs of goods bought for resale or goods used', codes: ['costOfGoods'] },
    { box: '12', label: 'Car, van and travel expenses – after private use proportion', codes: ['carVanTravelExpenses'] },
    { box: '13', label: 'Wages, salaries and other staff costs', codes: ['wagesAndStaffCosts'] },
    { box: '14', label: 'Rent, rates, power and insurance costs', codes: ['premisesRunningCosts'] },
    { box: '15', label: 'Repairs and maintenance of property and equipment', codes: ['maintenanceCosts'] },
    { box: '16', label: 'Accountancy, legal and other professional fees', codes: ['professionalFees'] },
    { box: '17', label: 'Interest and bank and credit card financial charges', codes: ['interestOnBankOtherLoans', 'financeCharges'] },
    { box: '18', label: 'Phone, fax, stationery and other office costs', codes: ['adminCosts'] },
    {
      box: '19',
      label: 'Other allowable business expenses – client entertaining costs are not an allowable expense',
      codes: ['advertisingCosts', 'otherExpenses', 'paymentsToSubcontractors', 'irrecoverableDebts'],
    },
  ],
  totalExpenses: { box: '20', label: 'Total allowable expenses – total of boxes 11 to 19' },
  netProfit: { box: '21', label: 'Net profit – if your business income is more than your expenses (if box 9 + box 10 minus box 20 is positive)' },
  netLoss: { box: '22', label: 'Net loss – if your expenses exceed your business income (if box 20 minus (box 9 + box 10) is positive)' },
  tradingAllowanceBox: '10.1',
  turnoverLimitPence: 9_000_000,
};

/** Forms by tax year label, each checked against HMRC's. 2025-26 only changed the business details boxes, which this app doesn't fill in. */
export const SA103S_FORMS: Record<string, Sa103sForm> = {
  '2024-25': FORM_2024_25,
  '2025-26': FORM_2024_25,
};

/** The form for a tax year, or the nearest known one (flagged as assumed) for a year not in the table. */
export function sa103sFormFor(label: string): { form: Sa103sForm; formLabel: string; assumed: boolean } {
  if (SA103S_FORMS[label]) return { form: SA103S_FORMS[label], formLabel: label, assumed: false };
  const known = Object.keys(SA103S_FORMS).sort();
  const formLabel = label < known[0] ? known[0] : known[known.length - 1];
  return { form: SA103S_FORMS[formLabel], formLabel, assumed: true };
}

export interface TradingAllowance {
  pence: number;
  /** Shown beside the allowance while it has been announced but isn't law. */
  provisional?: string;
}

/** The allowance by the tax year it starts from; each lasts until the next. It's a tax rule, so it changes before that year's form appears. */
export const TRADING_ALLOWANCES: Record<string, TradingAllowance> = {
  '2017-18': { pence: 100_000 },
  '2027-28': {
    pence: 300_000,
    provisional: 'The £3,000 allowance from 6 April 2027 was announced in Budget 2026 and depends on Finance Bill 2026-27 becoming law.',
  },
};

/** The trading allowance in force for a tax year. */
export function tradingAllowanceFor(label: string): TradingAllowance {
  const from = Object.keys(TRADING_ALLOWANCES)
    .sort()
    .filter((start) => start <= label)
    .at(-1);
  return TRADING_ALLOWANCES[from ?? '2017-18'];
}

/** MTD categories that can never be claimed, so they never go in a box. */
/** Always disallowable: lines in these categories are saved that way, whatever the form sends. */
export const isNeverAllowable = (hmrcCode: string): boolean => hmrcCode in SA103S_NOT_ALLOWABLE;

/** Nothing to record on the cash basis, so it isn't offered for new lines. Kept as an MTD field, sent as zero. */
export const CASH_BASIS_UNUSED_CODE = 'depreciation';

export const SA103S_NOT_ALLOWABLE: Record<string, string> = {
  businessEntertainmentCosts: 'Business and client entertaining is not an allowable expense.',
  depreciation:
    'Depreciation is not allowable. Under the cash basis, equipment is claimed as an expense when bought (cars use capital allowances instead).',
};

/** Categories that need a second look before filing, if they have amounts. */
export const SA103S_CHECK: Record<string, string> = {
  irrecoverableDebts: 'Under the cash basis, income is only recorded when received, so bad debts are not usually claimed.',
  paymentsToSubcontractors: 'Construction Industry Scheme payments go in this box on the short form.',
};

export interface Sa103sBox {
  box: string;
  label: string;
  amountPence: number;
}

export interface ExcludedAmount {
  hmrcCode: string;
  amountPence: number;
  reason: string;
}

export interface SelfAssessmentSummary {
  /** The form these boxes come from; assumed if the tax year's own form hasn't been checked. */
  form: Omit<Sa103sForm, 'incomeBoxes' | 'expenseBoxes'> & { label: string; assumed: boolean };
  incomeBoxes: Sa103sBox[];
  expenseBoxes: Sa103sBox[];
  totalIncomePence: number;
  totalAllowableExpensesPence: number;
  /** Zero if there is a loss. */
  netProfitPence: number;
  /** Zero if there is a profit. */
  netLossPence: number;
  /** Amounts recorded as disallowable on line items, by MTD category. */
  disallowable: { hmrcCode: string; amountPence: number }[];
  /** Whole categories that can't be claimed (entertaining, depreciation). */
  notAllowable: ExcludedAmount[];
  /** Categories with amounts that are worth checking. */
  checks: (ExcludedAmount & { box: string })[];
  tradingAllowance: {
    allowancePence: number;
    provisional?: string;
    profitWithExpensesPence: number;
    profitWithAllowancePence: number;
    /** Which gives the lower taxable profit. */
    better: 'expenses' | 'allowance' | 'same';
    /** Income within the allowance may not need reporting at all. */
    incomeWithinAllowance: boolean;
  };
  /** Turnover at or above the limit means the full SA103F form is needed. */
  turnoverOverShortFormLimit: boolean;
}

/** What a filed return said, box by box, to compare with the figures now. */
export const sa103sFigures = ({ incomeBoxes, expenseBoxes }: SelfAssessmentSummary): Record<string, number> =>
  Object.fromEntries([...incomeBoxes, ...expenseBoxes].map((b) => [b.box, b.amountPence]));

export function buildSelfAssessmentSummary(mtd: MtdPeriodSummary, taxYearLabel: string): SelfAssessmentSummary {
  const { form, formLabel, assumed } = sa103sFormFor(taxYearLabel);
  const { incomeBoxes: incomeDefinitions, expenseBoxes: expenseDefinitions, ...formDetails } = form;
  const allowable = (code: string) =>
    (mtd.periodExpenses[code] ?? 0) - (mtd.periodDisallowableExpenses[`${code}Disallowable`] ?? 0);
  const sum = (codes: string[], value: (code: string) => number) => codes.reduce((acc, code) => acc + value(code), 0);

  const incomeBoxes = incomeDefinitions.map((b) => ({
    box: b.box,
    label: b.label,
    amountPence: sum(b.codes, (c) => mtd.periodIncome[c] ?? 0),
  }));
  const expenseBoxes = expenseDefinitions.map((b) => ({ box: b.box, label: b.label, amountPence: sum(b.codes, allowable) }));
  const totalIncomePence = incomeBoxes.reduce((acc, b) => acc + b.amountPence, 0);
  const totalAllowableExpensesPence = expenseBoxes.reduce((acc, b) => acc + b.amountPence, 0);
  const net = totalIncomePence - totalAllowableExpensesPence;

  const disallowable = Object.entries(mtd.periodDisallowableExpenses)
    .map(([key, amountPence]) => ({ hmrcCode: key.replace(/Disallowable$/, ''), amountPence }))
    .filter((d) => d.amountPence > 0 && !(d.hmrcCode in SA103S_NOT_ALLOWABLE));
  const notAllowable = Object.entries(SA103S_NOT_ALLOWABLE)
    .map(([hmrcCode, reason]) => ({ hmrcCode, amountPence: mtd.periodExpenses[hmrcCode] ?? 0, reason }))
    .filter((e) => e.amountPence > 0);
  const checks = Object.entries(SA103S_CHECK)
    .map(([hmrcCode, reason]) => ({
      hmrcCode,
      amountPence: allowable(hmrcCode),
      reason,
      box: expenseDefinitions.find((b) => b.codes.includes(hmrcCode))!.box,
    }))
    .filter((e) => e.amountPence > 0);

  const profitWithExpensesPence = Math.max(0, net);
  const allowance = tradingAllowanceFor(taxYearLabel);
  const profitWithAllowancePence = Math.max(0, totalIncomePence - allowance.pence);

  return {
    form: { ...formDetails, label: formLabel, assumed },
    incomeBoxes,
    expenseBoxes,
    totalIncomePence,
    totalAllowableExpensesPence,
    netProfitPence: Math.max(0, net),
    netLossPence: Math.max(0, -net),
    disallowable,
    notAllowable,
    checks,
    tradingAllowance: {
      allowancePence: allowance.pence,
      provisional: allowance.provisional,
      profitWithExpensesPence,
      profitWithAllowancePence,
      better:
        profitWithAllowancePence < profitWithExpensesPence
          ? 'allowance'
          : profitWithAllowancePence > profitWithExpensesPence
            ? 'expenses'
            : 'same',
      incomeWithinAllowance: totalIncomePence <= allowance.pence,
    },
    turnoverOverShortFormLimit: (mtd.periodIncome.turnover ?? 0) >= form.turnoverLimitPence,
  };
}

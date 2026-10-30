// Year-end figures for the Self Assessment 'Self-employment (short)' pages
// (SA103S), worked out from the same MTD period summary used elsewhere.
//
// Box numbers and wording follow HMRC's SA103S for 2024-25. If HMRC changes
// the form, update SA103S_BOXES (the mapping from MTD categories to boxes).
import type { MtdPeriodSummary } from './mtd';

export interface Sa103sBoxDefinition {
  box: string;
  label: string;
  /** MTD category codes whose allowable amounts go in this box. */
  codes: string[];
}

export const SA103S_INCOME_BOXES: Sa103sBoxDefinition[] = [
  { box: '9', label: 'Your turnover – the takings, fees, sales or money earned by your business', codes: ['turnover'] },
  { box: '10', label: 'Any other business income not included in box 9', codes: ['other'] },
];

export const SA103S_EXPENSE_BOXES: Sa103sBoxDefinition[] = [
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
    label: 'Other allowable business expenses',
    codes: ['advertisingCosts', 'otherExpenses', 'paymentsToSubcontractors', 'irrecoverableDebts'],
  },
];

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
  paymentsToSubcontractors: 'Construction Industry Scheme payments are included in box 19 on the short form.',
};

export const TRADING_ALLOWANCE_PENCE = 100_000;
export const SA103S_TURNOVER_LIMIT_PENCE = 9_000_000;

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
  incomeBoxes: Sa103sBox[];
  expenseBoxes: Sa103sBox[];
  totalIncomePence: number;
  /** Box 20. */
  totalAllowableExpensesPence: number;
  /** Box 21 (zero if there is a loss). */
  netProfitPence: number;
  /** Box 22 (zero if there is a profit). */
  netLossPence: number;
  /** Amounts recorded as disallowable on line items, by MTD category. */
  disallowable: { hmrcCode: string; amountPence: number }[];
  /** Whole categories that can't be claimed (entertaining, depreciation). */
  notAllowable: ExcludedAmount[];
  /** Categories with amounts that are worth checking. */
  checks: ExcludedAmount[];
  tradingAllowance: {
    profitWithExpensesPence: number;
    profitWithAllowancePence: number;
    /** Which gives the lower taxable profit. */
    better: 'expenses' | 'allowance' | 'same';
    /** Income of £1,000 or less may not need reporting at all. */
    incomeWithinAllowance: boolean;
  };
  /** Turnover at or above the limit means the full SA103F form is needed. */
  turnoverOverShortFormLimit: boolean;
}

export function buildSelfAssessmentSummary(mtd: MtdPeriodSummary): SelfAssessmentSummary {
  const allowable = (code: string) =>
    (mtd.periodExpenses[code] ?? 0) - (mtd.periodDisallowableExpenses[`${code}Disallowable`] ?? 0);
  const sum = (codes: string[], value: (code: string) => number) => codes.reduce((acc, code) => acc + value(code), 0);

  const incomeBoxes = SA103S_INCOME_BOXES.map((b) => ({
    box: b.box,
    label: b.label,
    amountPence: sum(b.codes, (c) => mtd.periodIncome[c] ?? 0),
  }));
  const expenseBoxes = SA103S_EXPENSE_BOXES.map((b) => ({ box: b.box, label: b.label, amountPence: sum(b.codes, allowable) }));
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
    .map(([hmrcCode, reason]) => ({ hmrcCode, amountPence: allowable(hmrcCode), reason }))
    .filter((e) => e.amountPence > 0);

  const profitWithExpensesPence = Math.max(0, net);
  const profitWithAllowancePence = Math.max(0, totalIncomePence - TRADING_ALLOWANCE_PENCE);

  return {
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
      profitWithExpensesPence,
      profitWithAllowancePence,
      better:
        profitWithAllowancePence < profitWithExpensesPence
          ? 'allowance'
          : profitWithAllowancePence > profitWithExpensesPence
            ? 'expenses'
            : 'same',
      incomeWithinAllowance: totalIncomePence <= TRADING_ALLOWANCE_PENCE,
    },
    turnoverOverShortFormLimit: (mtd.periodIncome.turnover ?? 0) >= SA103S_TURNOVER_LIMIT_PENCE,
  };
}

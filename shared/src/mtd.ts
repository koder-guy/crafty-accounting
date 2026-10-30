import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type CategorySeed } from './categories';
import type { MtdExpenses } from './schemas';
import { SA103S_NOT_ALLOWABLE } from './selfAssessment';

// Aggregates transactions into the shape of an MTD Self-Employment period
// summary. Amounts stay in pence here; convert with penceToMtdAmount when
// building an API payload, which expects pounds to two decimal places.
//
// Disallowable expenses are included in periodExpenses and also reported
// separately under "<code>Disallowable", matching HMRC's SA103 boxes.

export interface MtdIncomeEntry {
  hmrcCode: string;
  amountPence: number;
}

export interface MtdExpenseEntry {
  hmrcCode: string;
  amountPence: number;
  disallowable: boolean;
}

export interface MtdPeriodSummary {
  periodIncome: Record<string, number>;
  periodExpenses: Record<string, number>;
  periodDisallowableExpenses: Record<string, number>;
  totals: {
    incomePence: number;
    expensesPence: number;
    disallowablePence: number;
    allowableExpensesPence: number;
    netProfitPence: number;
  };
}

const add = (target: Record<string, number>, key: string, amount: number) => {
  target[key] = (target[key] ?? 0) + amount;
};

export function buildMtdPeriodSummary(incomes: MtdIncomeEntry[], expenses: MtdExpenseEntry[]): MtdPeriodSummary {
  const periodIncome: Record<string, number> = {};
  const periodExpenses: Record<string, number> = {};
  const periodDisallowableExpenses: Record<string, number> = {};
  let incomePence = 0;
  let expensesPence = 0;
  let disallowablePence = 0;

  for (const income of incomes) {
    add(periodIncome, income.hmrcCode, income.amountPence);
    incomePence += income.amountPence;
  }
  for (const expense of expenses) {
    add(periodExpenses, expense.hmrcCode, expense.amountPence);
    expensesPence += expense.amountPence;
    if (expense.disallowable) {
      add(periodDisallowableExpenses, `${expense.hmrcCode}Disallowable`, expense.amountPence);
      disallowablePence += expense.amountPence;
    }
  }

  const allowableExpensesPence = expensesPence - disallowablePence;
  return {
    periodIncome,
    periodExpenses,
    periodDisallowableExpenses,
    totals: {
      incomePence,
      expensesPence,
      disallowablePence,
      allowableExpensesPence,
      netProfitPence: incomePence - allowableExpensesPence,
    },
  };
}

export function penceToMtdAmount(pence: number): number {
  return Math.round(pence) / 100;
}

/** One total can be sent for expenses while annual turnover is below this, the VAT registration threshold. */
export const VAT_REGISTRATION_THRESHOLD_PENCE = 9_000_000;

/**
 * Expenses as one total: HMRC wants allowable expenses only. Entertainment and
 * depreciation are left out even when not marked disallowable, as on the SA103S.
 */
export function mtdConsolidatedExpensesPence(summary: MtdPeriodSummary): number {
  return Object.keys(SA103S_NOT_ALLOWABLE).reduce(
    (total, code) => total - (summary.periodExpenses[code] ?? 0) + (summary.periodDisallowableExpenses[`${code}Disallowable`] ?? 0),
    summary.totals.allowableExpensesPence,
  );
}

export interface MtdPayload {
  periodDates: { periodStartDate: string; periodEndDate: string };
  periodIncome: Record<string, number>;
  periodExpenses: Record<string, number>;
  periodDisallowableExpenses?: Record<string, number>;
}

/**
 * MTD-shaped figures in pounds: the body of HMRC's cumulative period summary
 * request. HMRC wants every income and expense field even when it's zero;
 * disallowable amounts are only listed when there are some. With one total for
 * expenses, HMRC refuses any other expense field or disallowable amount.
 */
export function mtdPayload(summary: MtdPeriodSummary, periodStartDate: string, periodEndDate: string, expenses: MtdExpenses): MtdPayload {
  const every = (categories: CategorySeed[], values: Record<string, number>) =>
    Object.fromEntries(categories.map((c) => [c.hmrcCode, penceToMtdAmount(values[c.hmrcCode] ?? 0)]));
  const disallowable = Object.fromEntries(
    EXPENSE_CATEGORIES.map((c) => `${c.hmrcCode}Disallowable`)
      .filter((key) => summary.periodDisallowableExpenses[key])
      .map((key) => [key, penceToMtdAmount(summary.periodDisallowableExpenses[key])]),
  );
  const periodDates = { periodStartDate, periodEndDate };
  const periodIncome = every(INCOME_CATEGORIES, summary.periodIncome);
  if (expenses === 'consolidated') {
    return { periodDates, periodIncome, periodExpenses: { consolidatedExpenses: penceToMtdAmount(mtdConsolidatedExpensesPence(summary)) } };
  }
  return {
    periodDates,
    periodIncome,
    periodExpenses: every(EXPENSE_CATEGORIES, summary.periodExpenses),
    ...(Object.keys(disallowable).length ? { periodDisallowableExpenses: disallowable } : {}),
  };
}

// ---- Quarterly update periods ----
//
// Standard MTD update periods follow the tax year: 6 Apr–5 Jul, 6 Jul–5 Oct,
// 6 Oct–5 Jan and 6 Jan–5 Apr, each due by the 7th of the following month.
// Updates are cumulative: each one reports the tax year to date.

export interface MtdQuarter {
  quarter: 1 | 2 | 3 | 4;
  startDate: string;
  endDate: string;
  deadline: string;
}

export function mtdQuarters(startYear: number): MtdQuarter[] {
  const next = startYear + 1;
  return [
    { quarter: 1, startDate: `${startYear}-04-06`, endDate: `${startYear}-07-05`, deadline: `${startYear}-08-07` },
    { quarter: 2, startDate: `${startYear}-07-06`, endDate: `${startYear}-10-05`, deadline: `${startYear}-11-07` },
    { quarter: 3, startDate: `${startYear}-10-06`, endDate: `${next}-01-05`, deadline: `${next}-02-07` },
    { quarter: 4, startDate: `${next}-01-06`, endDate: `${next}-04-05`, deadline: `${next}-05-07` },
  ];
}

/** HMRC won't take an update more than 10 days before the end of its period. */
export const MTD_EARLY_SEND_DAYS = 10;

/** The first day a quarter's update can be sent to HMRC. */
export function mtdEarliestSendDate(quarter: Pick<MtdQuarter, 'endDate'>): string {
  const [y, m, d] = quarter.endDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - MTD_EARLY_SEND_DAYS)).toISOString().slice(0, 10);
}

/** Cumulative updates go to HMRC from the 2025-26 tax year; earlier years used a different API. */
export const MTD_FIRST_SEND_YEAR = 2025;

export type MtdQuarterStatus = 'upcoming' | 'open' | 'due' | 'overdue' | 'submitted';

export function mtdQuarterStatus(quarter: MtdQuarter, today: string, submitted: boolean): MtdQuarterStatus {
  if (submitted) return 'submitted';
  if (today < quarter.startDate) return 'upcoming';
  if (today <= quarter.endDate) return 'open';
  if (today <= quarter.deadline) return 'due';
  return 'overdue';
}

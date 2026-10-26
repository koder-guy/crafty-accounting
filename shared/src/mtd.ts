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

/** MTD-shaped figures in pounds, as an API payload would carry them. */
export function mtdPayload(summary: MtdPeriodSummary) {
  const toPounds = (values: Record<string, number>) =>
    Object.fromEntries(Object.entries(values).map(([key, pence]) => [key, penceToMtdAmount(pence)]));
  return {
    periodIncome: toPounds(summary.periodIncome),
    periodExpenses: toPounds(summary.periodExpenses),
    periodDisallowableExpenses: toPounds(summary.periodDisallowableExpenses),
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

export type MtdQuarterStatus = 'upcoming' | 'open' | 'due' | 'overdue' | 'submitted';

export function mtdQuarterStatus(quarter: MtdQuarter, today: string, submitted: boolean): MtdQuarterStatus {
  if (submitted) return 'submitted';
  if (today < quarter.startDate) return 'upcoming';
  if (today <= quarter.endDate) return 'open';
  if (today <= quarter.deadline) return 'due';
  return 'overdue';
}

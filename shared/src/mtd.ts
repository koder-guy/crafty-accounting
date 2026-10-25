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

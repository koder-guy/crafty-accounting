// Standard categories for self-employment income and expenses. Display names
// follow HMRC's SA103 wording; hmrcCode is the matching field name in the MTD
// Self-Employment Business API (periodIncome / periodExpenses).

export type CategoryType = 'INCOME' | 'EXPENSE';

export interface CategorySeed {
  type: CategoryType;
  name: string;
  hmrcCode: string;
  /** Fits a list column; the full name stays on the MTD and year-end pages. */
  shortName: string;
}

export const INCOME_CATEGORIES: CategorySeed[] = [
  { type: 'INCOME', name: 'Turnover – takings, fees, sales or money earned', hmrcCode: 'turnover', shortName: 'Turnover' },
  { type: 'INCOME', name: 'Other business income', hmrcCode: 'other', shortName: 'Other business income' },
];

export const EXPENSE_CATEGORIES: CategorySeed[] = [
  { type: 'EXPENSE', name: 'Cost of goods bought for resale or goods used', hmrcCode: 'costOfGoods', shortName: 'Cost of goods' },
  { type: 'EXPENSE', name: 'Construction industry – payments to subcontractors', hmrcCode: 'paymentsToSubcontractors', shortName: 'Subcontractors' },
  { type: 'EXPENSE', name: 'Wages, salaries and other staff costs', hmrcCode: 'wagesAndStaffCosts', shortName: 'Staff costs' },
  { type: 'EXPENSE', name: 'Car, van and travel expenses', hmrcCode: 'carVanTravelExpenses', shortName: 'Car, van and travel' },
  { type: 'EXPENSE', name: 'Rent, rates, power and insurance costs', hmrcCode: 'premisesRunningCosts', shortName: 'Rent, rates and power' },
  { type: 'EXPENSE', name: 'Repairs and maintenance of property and equipment', hmrcCode: 'maintenanceCosts', shortName: 'Repairs and maintenance' },
  { type: 'EXPENSE', name: 'Phone, fax, stationery and other office costs', hmrcCode: 'adminCosts', shortName: 'Phone and office costs' },
  { type: 'EXPENSE', name: 'Business entertainment costs', hmrcCode: 'businessEntertainmentCosts', shortName: 'Entertainment' },
  { type: 'EXPENSE', name: 'Advertising costs', hmrcCode: 'advertisingCosts', shortName: 'Advertising' },
  { type: 'EXPENSE', name: 'Interest on bank and other loans', hmrcCode: 'interestOnBankOtherLoans', shortName: 'Loan interest' },
  { type: 'EXPENSE', name: 'Bank, credit card and other financial charges', hmrcCode: 'financeCharges', shortName: 'Bank and card charges' },
  { type: 'EXPENSE', name: 'Irrecoverable debts written off', hmrcCode: 'irrecoverableDebts', shortName: 'Bad debts' },
  { type: 'EXPENSE', name: 'Accountancy, legal and other professional fees', hmrcCode: 'professionalFees', shortName: 'Professional fees' },
  { type: 'EXPENSE', name: 'Depreciation and loss or profit on sale of assets', hmrcCode: 'depreciation', shortName: 'Depreciation' },
  { type: 'EXPENSE', name: 'Other business expenses', hmrcCode: 'otherExpenses', shortName: 'Other expenses' },
];

export const ALL_CATEGORIES: CategorySeed[] = [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES];

const SHORT_NAMES = new Map(ALL_CATEGORIES.map((c) => [c.name, c.shortName]));

/** A standard category's short name for lists; custom categories keep their own name. */
export const shortCategoryName = (name: string): string => SHORT_NAMES.get(name) ?? name;

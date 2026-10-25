// Standard categories for self-employment income and expenses. Display names
// follow HMRC's SA103 wording; hmrcCode is the matching field name in the MTD
// Self-Employment Business API (periodIncome / periodExpenses).

export type CategoryType = 'INCOME' | 'EXPENSE';

export interface CategorySeed {
  type: CategoryType;
  name: string;
  hmrcCode: string;
}

export const INCOME_CATEGORIES: CategorySeed[] = [
  { type: 'INCOME', name: 'Turnover – takings, fees, sales or money earned', hmrcCode: 'turnover' },
  { type: 'INCOME', name: 'Other business income', hmrcCode: 'other' },
];

export const EXPENSE_CATEGORIES: CategorySeed[] = [
  { type: 'EXPENSE', name: 'Cost of goods bought for resale or goods used', hmrcCode: 'costOfGoods' },
  { type: 'EXPENSE', name: 'Construction industry – payments to subcontractors', hmrcCode: 'paymentsToSubcontractors' },
  { type: 'EXPENSE', name: 'Wages, salaries and other staff costs', hmrcCode: 'wagesAndStaffCosts' },
  { type: 'EXPENSE', name: 'Car, van and travel expenses', hmrcCode: 'carVanTravelExpenses' },
  { type: 'EXPENSE', name: 'Rent, rates, power and insurance costs', hmrcCode: 'premisesRunningCosts' },
  { type: 'EXPENSE', name: 'Repairs and maintenance of property and equipment', hmrcCode: 'maintenanceCosts' },
  { type: 'EXPENSE', name: 'Phone, fax, stationery and other office costs', hmrcCode: 'adminCosts' },
  { type: 'EXPENSE', name: 'Business entertainment costs', hmrcCode: 'businessEntertainmentCosts' },
  { type: 'EXPENSE', name: 'Advertising costs', hmrcCode: 'advertisingCosts' },
  { type: 'EXPENSE', name: 'Interest on bank and other loans', hmrcCode: 'interestOnBankOtherLoans' },
  { type: 'EXPENSE', name: 'Bank, credit card and other financial charges', hmrcCode: 'financeCharges' },
  { type: 'EXPENSE', name: 'Irrecoverable debts written off', hmrcCode: 'irrecoverableDebts' },
  { type: 'EXPENSE', name: 'Accountancy, legal and other professional fees', hmrcCode: 'professionalFees' },
  { type: 'EXPENSE', name: 'Depreciation and loss or profit on sale of assets', hmrcCode: 'depreciation' },
  { type: 'EXPENSE', name: 'Other business expenses', hmrcCode: 'otherExpenses' },
];

export const ALL_CATEGORIES: CategorySeed[] = [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES];

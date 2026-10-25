// Shapes returned by the API.
import type { CategoryType } from './categories';
import type { PaymentMethod } from './schemas';
import type { MtdPeriodSummary } from './mtd';

export interface TaxYear {
  id: number;
  label: string;
  startDate: string;
  endDate: string;
  incomeCount: number;
  expenseCount: number;
  documentCount: number;
}

export interface TaxYearsResponse {
  taxYears: TaxYear[];
  activeTaxYearId: number | null;
}

export interface Category {
  id: number;
  type: CategoryType;
  name: string;
  hmrcCode: string;
}

export interface Income {
  id: number;
  taxYearId: number;
  date: string;
  description: string;
  source: string | null;
  reference: string | null;
  paymentMethod: PaymentMethod;
  amountPence: number;
  categoryId: number;
  categoryName: string;
  hmrcCode: string;
  notes: string | null;
  documentFilename: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LineItem {
  id: number;
  description: string;
  amountPence: number;
  categoryId: number;
  categoryName: string;
  hmrcCode: string;
  disallowable: boolean;
}

export interface Expense {
  id: number;
  taxYearId: number;
  date: string;
  supplier: string;
  invoiceNumber: string | null;
  description: string | null;
  paymentMethod: PaymentMethod;
  totalPence: number;
  disallowablePence: number;
  notes: string | null;
  documentFilename: string | null;
  lineItemCount: number;
  categoryNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseWithLineItems extends Expense {
  lineItems: LineItem[];
}

export interface CategoryTotal {
  categoryId: number;
  name: string;
  hmrcCode: string;
  totalPence: number;
  disallowablePence: number;
}

export interface DashboardData {
  taxYear: TaxYear;
  totals: {
    incomePence: number;
    cardIncomePence: number;
    cashIncomePence: number;
    bankIncomePence: number;
    expensesPence: number;
    disallowablePence: number;
    allowableExpensesPence: number;
    netProfitPence: number;
  };
  monthly: { index: number; label: string; range: string; incomePence: number; expensesPence: number }[];
  incomeByCategory: CategoryTotal[];
  expensesByCategory: CategoryTotal[];
  recentIncomes: Income[];
  recentExpenses: Expense[];
  mtd: MtdPeriodSummary;
}

export interface ApiErrorBody {
  error: string;
  details?: { path: string; message: string }[];
}

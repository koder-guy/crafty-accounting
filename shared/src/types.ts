// Shapes returned by the API.
import type { CategoryType } from './categories';
import type { PaymentMethod } from './schemas';
import type { MtdPeriodSummary, MtdQuarter } from './mtd';
import type { SelfAssessmentSummary } from './selfAssessment';

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
  /** User-defined name that maps onto one of the standard MTD categories. */
  isCustom: boolean;
  /** Incoming transactions plus outgoing line items using this category. */
  usageCount: number;
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
  payee: string;
  invoiceNumber: string | null;
  orderNumber: string | null;
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

export interface MtdQuarterSubmission {
  submittedOn: string;
  reference: string | null;
}

export interface MtdQuarterSummary extends MtdQuarter {
  /** Figures for transactions dated within this quarter only. */
  period: MtdPeriodSummary;
  /** Figures from the start of the tax year to the end of this quarter (what MTD submits). */
  cumulative: MtdPeriodSummary;
  submission: MtdQuarterSubmission | null;
}

export interface MtdQuartersResponse {
  taxYear: TaxYear;
  quarters: MtdQuarterSummary[];
}

export interface YearEndSummaryResponse {
  taxYear: TaxYear;
  /** Online filing and payment deadline (31 January after the tax year). */
  filingDeadline: string;
  summary: SelfAssessmentSummary;
}

export interface BreakdownCategory {
  categoryId: number;
  name: string;
  isCustom: boolean;
  totalPence: number;
  disallowablePence: number;
  /** Incoming transactions or outgoing line items. */
  count: number;
}

/** One standard MTD category, with any custom categories mapped to it. */
export interface BreakdownGroup {
  hmrcCode: string;
  /** The standard category itself (amounts recorded directly against it). */
  standard: BreakdownCategory;
  custom: BreakdownCategory[];
  totalPence: number;
  disallowablePence: number;
  count: number;
}

export interface BreakdownSection {
  totalPence: number;
  disallowablePence: number;
  groups: BreakdownGroup[];
}

export interface BreakdownResponse {
  from: string;
  to: string;
  income: BreakdownSection;
  expenses: BreakdownSection;
  /** Outgoing transactions by payee, largest first. */
  payees: { payee: string; totalPence: number; count: number }[];
}

export interface BreakdownItem {
  kind: 'income' | 'expense';
  /** The incoming or outgoing transaction to link to. */
  transactionId: number;
  date: string;
  payee: string | null;
  description: string;
  categoryName: string;
  amountPence: number;
  disallowable: boolean;
}

export interface AutoBackupStatus {
  enabled: boolean;
  time: string;
  keep: number;
  /** Folder on the server (inside the container for Docker). */
  folder: string;
  folderWritable: boolean;
  nextRunAt: string | null;
  lastRun: {
    at: string;
    status: 'created' | 'skipped' | 'failed';
    file: string | null;
    error: string | null;
  } | null;
  backups: { name: string; sizeBytes: number; createdAt: string }[];
}

export interface ApiErrorBody {
  error: string;
  details?: { path: string; message: string }[];
}

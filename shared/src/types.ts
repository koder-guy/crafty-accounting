// Shapes returned by the API.
import type { CategoryType } from './categories';
import type { PaymentMethod } from './schemas';
import type { MtdPayload, MtdPeriodSummary, MtdQuarter } from './mtd';
import type { SelfAssessmentSummary } from './selfAssessment';
import type { Vehicle } from './mileage';
import type { TaxEstimate } from './taxEstimate';
import type { Role } from './schemas';

export interface TaxYear {
  id: number;
  label: string;
  startDate: string;
  endDate: string;
  incomeCount: number;
  expenseCount: number;
  documentCount: number;
  mileageCount: number;
  /** Other taxable income for the year (salary, pension…), used by the tax estimate. */
  otherIncomePence: number;
}

export interface User {
  id: number;
  name: string;
  role: Role;
  createdAt: string;
}

export interface MeResponse {
  authenticated: boolean;
  user?: User;
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

export interface TransactionDocument {
  id: number;
  /** The original filename, which is also how it's stored and downloaded. */
  filename: string;
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
  /** Attached documents (receipts, invoices…), in the order they were added. */
  documents: TransactionDocument[];
  createdAt: string;
  updatedAt: string;
  /** Name of the person who added it (null for records made before sign-ins, or by sample data). */
  createdBy: string | null;
  /** Name of the person who last changed it. */
  updatedBy: string | null;
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
  /** Attached documents (receipts, invoices…), in the order they were added. */
  documents: TransactionDocument[];
  lineItemCount: number;
  categoryNames: string[];
  createdAt: string;
  updatedAt: string;
  /** Name of the person who added it (null for records made before sign-ins, or by sample data). */
  createdBy: string | null;
  /** Name of the person who last changed it. */
  updatedBy: string | null;
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
  /** Mileage claimed so far this year (included in the expenses above). */
  mileagePence: number;
  /** Use of home flat rate claimed this year (included in the expenses above). */
  useOfHomePence: number;
  taxEstimate: TaxEstimate;
}

export interface MtdQuarterSubmission {
  submittedOn: string;
  reference: string | null;
  /** Set when the app sent the update to HMRC itself, rather than it being recorded by hand. */
  sent: {
    by: string;
    at: string;
    environment: HmrcEnvironment;
    /** HMRC's reference for the call; it answers an update with no other receipt. */
    correlationId: string | null;
    /** Exactly what was sent. */
    payload: MtdPayload;
  } | null;
}

export interface MtdQuarterSummary extends MtdQuarter {
  /** Figures for transactions dated within this quarter only. */
  period: MtdPeriodSummary;
  /** Figures from the start of the tax year to the end of this quarter (what MTD submits). */
  cumulative: MtdPeriodSummary;
  submission: MtdQuarterSubmission | null;
  /** An update the app sent to the other HMRC service (such as the sandbox), which doesn't count here. */
  otherServiceSend: { environment: HmrcEnvironment; at: string; by: string } | null;
}

export interface MtdQuartersResponse {
  taxYear: TaxYear;
  quarters: MtdQuarterSummary[];
}

export interface YearEndSummaryResponse {
  taxYear: TaxYear;
  mileageCheck: MileageCheck | null;
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
export type FlatRateKind = 'mileage' | 'home';

/** Claims worked out at an HMRC flat rate rather than recorded as outgoing. */
export interface BreakdownFlatRate {
  kind: FlatRateKind;
  name: string;
  totalPence: number;
  /** Trips or months. */
  count: number;
}

export interface BreakdownGroup {
  hmrcCode: string;
  /** The standard category itself (amounts recorded directly against it). */
  standard: BreakdownCategory;
  custom: BreakdownCategory[];
  /** Mileage (car, van and travel) or use of home (premises costs) in this group, if any. */
  flatRates: BreakdownFlatRate[];
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
  kind: 'income' | 'expense' | 'mileage' | 'home';
  /** The incoming or outgoing transaction (or mileage trip) to link to. */
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

export interface MileageTrip {
  id: number;
  taxYearId: number;
  date: string;
  description: string;
  vehicle: Vehicle;
  distanceTenths: number;
  /** Worked out at HMRC's rates, in date order through the tax year. */
  claimPence: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface MileageResponse {
  trips: MileageTrip[];
  totals: {
    distanceTenths: number;
    claimPence: number;
    /** Car and van miles, which count towards the 10,000-mile threshold. */
    carDistanceTenths: number;
  };
  /** Outgoing in the same category as mileage, which may be a double claim (see MileageCheck). */
  check: MileageCheck | null;
}

/**
 * Set when a tax year has both mileage claims and outgoing in "Car, van and
 * travel expenses". HMRC doesn't allow the mileage rate and actual running
 * costs (fuel, insurance, repairs) for the same vehicle, though parking,
 * tolls and fares are fine, so it's a prompt to check rather than an error.
 */
export interface MileageCheck {
  mileagePence: number;
  outgoingPence: number;
  /** Outgoing line items in the category (allowable ones only). */
  outgoingCount: number;
  /** The standard category, for linking to the outgoing list. */
  categoryId: number;
}

export interface TaxEstimateResponse {
  taxYear: TaxYear;
  estimate: TaxEstimate;
  /** Whether the trading allowance gave a lower profit than expenses, so the estimate uses it. */
  usesTradingAllowance: boolean;
  /** Profit before choosing the trading allowance, and the loss if there is one. */
  profitWithExpensesPence: number;
  netLossPence: number;
  dueDates: { balancing: string; secondPaymentOnAccount: string };
  /** Last date with any transaction or trip, so the page can say the figures are "so far". */
  recordedTo: string | null;
}

export interface UseOfHomeMonth {
  index: number;
  label: string;
  range: string;
  startDate: string;
  endDate: string;
  hours: number;
  claimPence: number;
}

export interface UseOfHomeResponse {
  months: UseOfHomeMonth[];
  totals: { hours: number; claimPence: number; monthsClaimed: number };
  /** When the hours were last saved, and by whom (null if never). */
  updatedAt: string | null;
  updatedBy: string | null;
}

export type HmrcEnvironment = 'sandbox' | 'production';

export interface HmrcStatus {
  /** Set by HMRC_ENV on the server: HMRC's test service or the live one. */
  environment: HmrcEnvironment;
  /** Whether HMRC_CLIENT_ID and HMRC_CLIENT_SECRET are set. */
  configured: boolean;
  /** Where HMRC sends people back after they sign in; it must be registered with the HMRC app. */
  redirectUri: string;
  nino: string | null;
  /** The self-employment business at HMRC that updates are sent for. */
  business: HmrcBusiness | null;
  connection: {
    connectedBy: string;
    connectedAt: string;
    /** After this HMRC needs signing in to again (18 months after connecting). */
    expiresAt: string;
  } | null;
}

export interface HmrcBusiness {
  businessId: string;
  tradingName: string | null;
}

/** A quarterly update HMRC expects, from its Obligations API. */
export interface HmrcObligation {
  periodStartDate: string;
  periodEndDate: string;
  dueDate: string;
  status: 'open' | 'fulfilled';
  receivedDate: string | null;
}

/** HMRC's verdict on the fraud prevention headers, from its sandbox test API. */
export interface HmrcFraudHeaderCheck {
  code: string;
  message: string;
  errors: { code: string; message: string; headers: string[] }[];
  warnings: { code: string; message: string; headers: string[] }[];
}

import { z } from 'zod';
import { isValidIsoDate } from './taxYear';

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
};

const MAX_PENCE = 100_000_000_00; // £100m sanity ceiling

const isoDate = z.string().refine(isValidIsoDate, 'Enter a valid date');
const pence = z
  .number()
  .int('Amount must be in whole pence')
  .positive('Amount must be more than £0.00')
  .max(MAX_PENCE, 'Amount is too large');
const id = z.number().int().positive();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const createTaxYearSchema = z.object({
  startYear: z.number().int().min(2000).max(2099),
});

export const setActiveTaxYearSchema = z.object({ taxYearId: id });

export const incomeInputSchema = z.object({
  taxYearId: id,
  date: isoDate,
  description: z.string().trim().min(1, 'Description is required').max(500),
  source: optionalText(200),
  reference: optionalText(100),
  paymentMethod: z.enum(PAYMENT_METHODS, 'Choose a payment method'),
  amountPence: pence,
  categoryId: id,
  notes: optionalText(2000),
  removeDocument: z.boolean().optional(),
});
export type IncomeInput = z.infer<typeof incomeInputSchema>;

export const lineItemInputSchema = z.object({
  id: id.optional(),
  description: z.string().trim().min(1, 'Line item description is required').max(500),
  amountPence: pence,
  categoryId: id,
  disallowable: z.boolean().default(false),
});
export type LineItemInput = z.infer<typeof lineItemInputSchema>;

export const expenseInputSchema = z
  .object({
    taxYearId: id,
    date: isoDate,
    supplier: z.string().trim().min(1, 'Supplier is required').max(200),
    invoiceNumber: optionalText(100),
    orderNumber: optionalText(100),
    description: optionalText(500),
    paymentMethod: z.enum(PAYMENT_METHODS, 'Choose a payment method'),
    totalPence: pence,
    notes: optionalText(2000),
    lineItems: z.array(lineItemInputSchema).min(1, 'Add at least one line item'),
    removeDocument: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const sum = value.lineItems.reduce((acc, item) => acc + item.amountPence, 0);
    if (sum !== value.totalPence) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalPence'],
        message: 'The transaction amount must equal the sum of its line items',
      });
    }
  });
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

const optionalQueryText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

/** Query-string filters shared by the incoming/outgoing list and CSV export. */
export const transactionFiltersSchema = z.object({
  taxYearId: z.coerce.number().int().positive(),
  search: optionalQueryText,
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  minPence: z.coerce.number().int().nonnegative().optional(),
  maxPence: z.coerce.number().int().nonnegative().optional(),
});
type ParsedFilters = z.infer<typeof transactionFiltersSchema>;
export type TransactionFilters = Pick<ParsedFilters, 'taxYearId'> & Partial<Omit<ParsedFilters, 'taxYearId'>>;

export const mtdSubmissionSchema = z.object({
  submittedOn: isoDate,
  reference: optionalText(100),
});

export const loginSchema = z.object({ password: z.string().min(1, 'Enter the password') });

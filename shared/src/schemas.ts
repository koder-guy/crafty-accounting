import { z } from 'zod';
import { VEHICLES } from './mileage';
import { MAX_MONTH_HOURS } from './useOfHome';
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

/** Most documents one transaction can have. */
export const MAX_DOCUMENTS = 10;

/** On an edit, the attached documents to remove (new ones come as files alongside). */
const removeDocumentIds = z.array(id).max(MAX_DOCUMENTS).optional();

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
  removeDocumentIds,
  /** On an edit, the updatedAt the form was loaded with; the save is refused if it has changed since. */
  expectedUpdatedAt: z.string().optional(),
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
    payee: z.string().trim().min(1, 'Payee is required').max(200),
    invoiceNumber: optionalText(100),
    orderNumber: optionalText(100),
    description: optionalText(500),
    paymentMethod: z.enum(PAYMENT_METHODS, 'Choose a payment method'),
    totalPence: pence,
    notes: optionalText(2000),
    lineItems: z.array(lineItemInputSchema).min(1, 'Add at least one line item'),
    removeDocumentIds,
    expectedUpdatedAt: z.string().optional(),
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

export const customCategorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60, 'Keep the name under 60 characters'),
  /** The standard MTD category this one maps to; it also sets income/expense. */
  mapsToCategoryId: id,
});

export const mtdSubmissionSchema = z.object({
  submittedOn: isoDate,
  reference: optionalText(100),
});

export const autoBackupSettingsSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 02:00'),
  keep: z.number().int().min(1, 'Keep at least 1 backup').max(365, 'Keep at most 365 backups'),
});

/** A date range for reports; it may span tax years. */
export const reportRangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, { message: 'The start date must be on or before the end date', path: ['to'] });

/** What to list in a breakdown drill-down: one category, a category group, or a payee. */
export const breakdownItemsSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    categoryId: z.coerce.number().int().positive().optional(),
    group: z.enum(['0', '1']).optional(),
    payee: z.string().trim().min(1).optional(),
    /** Mileage or use of home claims on their own. */
    flatRate: z.enum(['mileage', 'home']).optional(),
  })
  .refine(
    (q) => [q.categoryId, q.payee, q.flatRate].filter((v) => v !== undefined).length === 1,
    'Choose a category, a payee or a flat rate',
  );

export const mileageInputSchema = z.object({
  taxYearId: id,
  date: isoDate,
  description: z.string().trim().min(1, 'Say where you went and why').max(300),
  vehicle: z.enum(VEHICLES, 'Choose a vehicle'),
  distanceTenths: z
    .number()
    .int('Enter the distance to one decimal place')
    .positive('Enter a distance above zero')
    .max(100_000, 'That trip is too long'),
  notes: optionalText(2000),
  /** On an edit, the updatedAt the form was loaded with. */
  expectedUpdatedAt: z.string().optional(),
});
export type MileageInput = z.infer<typeof mileageInputSchema>;

export const useOfHomeInputSchema = z.object({
  taxYearId: id,
  /** Hours for each tax month that has any; months left out have none. */
  months: z
    .array(
      z.object({
        index: z.number().int().min(0).max(11),
        hours: z.number().int('Enter whole hours').min(0).max(MAX_MONTH_HOURS, `A month has at most ${MAX_MONTH_HOURS} hours`),
      }),
    )
    .max(12),
  /** The updatedAt the page was loaded with (null if nothing was saved yet); refused if it has changed since. */
  expectedUpdatedAt: z.string().nullable().optional(),
});
export type UseOfHomeInput = z.infer<typeof useOfHomeInputSchema>;

export const taxSettingsSchema = z.object({
  otherIncomePence: z.number().int().min(0, 'Enter zero or more').max(MAX_PENCE, 'Amount is too large'),
});

export const loginSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name'),
  password: z.string().min(1, 'Enter your password'),
});

/** Editors can change everything; read-only people can view, export and print, but not change the books. */
export const ROLES = ['editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  editor: 'Editor',
  viewer: 'Read-only',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  editor: 'Can add, change and delete anything, manage people and settings, and download backups',
  viewer: 'Can view everything, export CSVs and print reports, but not change anything or download backups',
};

const userName = z.string().trim().min(1, 'Enter a name').max(50, 'Use 50 characters or fewer');
const newPassword = z.string().min(8, 'Use at least 8 characters').max(200);
const role = z.enum(ROLES, 'Choose what they can do');

export const createUserSchema = z.object({ name: userName, password: newPassword, role: role.default('editor') });

export const updateUserSchema = z
  .object({ name: userName.optional(), password: newPassword.optional(), role: role.optional() })
  .refine((v) => v.name !== undefined || v.password !== undefined || v.role !== undefined, 'Nothing to change');

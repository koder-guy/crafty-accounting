// The Square connection (Settings → Square Integration) and importing its payouts as income (Income → Import from Square).
// Each payout Square makes to the bank becomes one income of the day's card sales (before Square's
// fees, less refunds), dated the day of the sales, plus one expense for Square's fees.
import { z } from 'zod';

export const SQUARE_ENVIRONMENTS = ['production', 'sandbox'] as const;
export type SquareEnvironment = (typeof SQUARE_ENVIRONMENTS)[number];

/** Who the fees expense is paid to, and the income's source. */
export const SQUARE_PAYEE = 'Square';
export const SQUARE_INCOME_DESCRIPTION = 'Square card sales';
export const SQUARE_FEES_DESCRIPTION = 'Square card processing fees';

const id = z.number().int().positive();

/** Saving the settings: a new access token, the environment it's for, the categories, or any of them. */
export const squareSettingsSchema = z
  .object({
    accessToken: z
      .string()
      .trim()
      .min(1, 'Enter the access token')
      .max(500, 'That is too long for an access token')
      .regex(/^\S+$/, 'An access token has no spaces in it')
      .optional(),
    /** Only sent with a new token: a token belongs to one or the other. */
    environment: z.enum(SQUARE_ENVIRONMENTS, 'Choose production or sandbox').optional(),
    incomeCategoryId: id.optional(),
    feeCategoryId: id.optional(),
  })
  .refine((v) => v.accessToken !== undefined || v.incomeCategoryId !== undefined || v.feeCategoryId !== undefined, 'Nothing to save')
  .refine((v) => v.environment === undefined || v.accessToken !== undefined, { message: 'Enter the access token for that environment', path: ['accessToken'] });

export type SquareSettingsInput = z.infer<typeof squareSettingsSchema>;

/** Enough of a token to recognise it: its last four characters. */
export const squareTokenHint = (token: string): string => `…${token.slice(-4)}`;

export interface SquareStatus {
  /** A token is saved, so payouts can be imported. */
  configured: boolean;
  tokenHint: string | null;
  environment: SquareEnvironment;
  /** The Square business the token is for, as Square names it. */
  merchantName: string | null;
  tokenAddedBy: string | null;
  tokenAddedAt: string | null;
  /** Where imported sales and fees go: the saved choices, or the standard Turnover and Bank, credit card and other financial charges. */
  incomeCategoryId: number;
  feeCategoryId: number;
}

/** Listing payouts: those for one tax year's sales. */
export const squarePayoutsQuerySchema = z.object({
  taxYearId: z.coerce.number().int().positive(),
});

export interface SquarePayout {
  id: string;
  /** When it was paid into the bank. */
  arrivalDate: string;
  /** What reached the bank. */
  netPence: number;
  /** Already in the books: the income it was imported as. */
  incomeId: number | null;
  /** The day of the sales, which the income and fees are dated (the latest, if more than one); for one imported, the income's date. */
  saleDate: string | null;
  /** The rest are only worked out for payouts not yet imported. */
  /** Every day with sales in it, earliest first. */
  saleDates: string[];
  /** Card sales less refunds: the income. */
  incomePence: number;
  /** Square's fees: the expense. */
  feesPence: number;
  /** Refunds taken off the sales (shown as a positive amount). */
  refundsPence: number;
  taxYearId: number | null;
  taxYearLabel: string | null;
  /** Why it can't be imported, to add by hand instead. */
  problem: string | null;
  /** An income already in the books on that day for the same amount, perhaps added by hand. */
  possibleDuplicate: { id: number; description: string; amountPence: number } | null;
}

export interface SquarePayoutList {
  taxYearId: number;
  payouts: SquarePayout[];
}

export const squareImportSchema = z.object({
  /** The tax year being imported into; a payout for sales outside it is refused. */
  taxYearId: id,
  payoutIds: z
    .array(z.string().regex(/^[\w-]{1,100}$/, 'Not a Square payout id'))
    .min(1, 'Choose at least one payout')
    .max(500, 'Import at most 500 payouts at a time'),
});

export interface SquareImportResult {
  imported: number;
  /** Chosen but imported already, perhaps from another browser. */
  alreadyImported: number;
  incomePence: number;
  feesPence: number;
  /** Each tax year added to, with its earliest date, for SubmittedFiguresNotice. */
  years: { taxYearId: number; label: string; firstDate: string }[];
}

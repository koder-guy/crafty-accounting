// Reads an invoice or receipt with an AI (Claude or Gemini, `readers/`) and returns what a new
// expense needs. Nothing is saved: the form is filled in for the person to check. The prompt, the
// schema the reply must follow and the checks on it are shared, so both read the same way.
import path from 'node:path';
import { z } from 'zod';
import { AI_PROVIDER_INFO, parsePoundsToPence, PAYMENT_METHODS, type AiModel, type AiProvider, type InvoiceReading } from '@crafty/shared';
import { HttpError } from './http';

export type InvoiceMediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif';

export interface ReadableCategory {
  id: number;
  name: string;
  hmrcCode: string;
  isCustom: boolean;
}

export interface InvoiceInput {
  data: Buffer;
  mediaType: InvoiceMediaType;
  /** The expense categories a line may go in. */
  categories: ReadableCategory[];
}

/** Calls to one AI provider, with the key saved in Settings → AI Document Scanning. Tests replace them. */
export interface DocumentReader {
  /** Refuses (HttpError 422) a key the provider doesn't accept, or one that can't use the model. */
  checkKey(apiKey: string, model: AiModel): Promise<void>;
  readInvoice(apiKey: string, model: AiModel, input: InvoiceInput): Promise<InvoiceReading>;
}

/** The payee for every order placed on Amazon. */
export const AMAZON_PAYEE = 'Amazon';

/** The payee for every order placed on Temu, which sells through Whaleco UK Limited. */
export const TEMU_PAYEE = 'Whaleco UK Limited (Temu)';

/** The largest image Anthropic's API takes. */
export const MAX_CLAUDE_IMAGE_BYTES = 5 * 1024 * 1024;

/** The largest file sent to Gemini: Google takes 20 MB a request, and the file goes as base64, a third larger. */
export const MAX_GEMINI_FILE_BYTES = 14 * 1024 * 1024;

const COMMON_TYPES: Record<string, InvoiceMediaType> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** The files each provider can read, by extension. Gemini also reads iPhone photos (HEIC). */
const READABLE: Record<AiProvider, Record<string, InvoiceMediaType>> = {
  claude: COMMON_TYPES,
  gemini: { ...COMMON_TYPES, '.heic': 'image/heic', '.heif': 'image/heif' },
};

export function invoiceMediaType(provider: AiProvider, name: string): InvoiceMediaType | undefined {
  return READABLE[provider][path.extname(name).toLowerCase()];
}

/** Why the provider can't read a file with this name and size, or null if it can. */
export function unreadableReason(provider: AiProvider, name: string, sizeBytes: number): string | null {
  const who = AI_PROVIDER_INFO[provider].name;
  const mediaType = invoiceMediaType(provider, name);
  if (!mediaType) {
    const kinds = provider === 'gemini' ? 'PDF, JPG, PNG, WebP and HEIC' : 'PDF, JPG, PNG and WebP';
    return `${who} can read ${kinds} files, not this one. Check it and fill it in yourself.`;
  }
  if (provider === 'claude' && mediaType !== 'application/pdf' && sizeBytes > MAX_CLAUDE_IMAGE_BYTES) {
    return `The image is too large for ${who} to read (the most is 5 MB). Check it and fill it in yourself.`;
  }
  if (provider === 'gemini' && sizeBytes > MAX_GEMINI_FILE_BYTES) {
    return `The file is too large for ${who} to read (the most is 14 MB). Check it and fill it in yourself.`;
  }
  return null;
}

export const SYSTEM = `You read invoices and receipts for the bookkeeping of a UK sole trader who uses the cash basis and isn't VAT registered.
Read the document and fill in one expense:
- date: when it was paid if shown, else the invoice date, as YYYY-MM-DD. UK documents write dates day first. null if there is none.
- payee: the business that was paid, as it names itself.
- amazonOrder: true when the order was placed on Amazon, even if another seller is named ("Sold by …", "Dispatched by …"). Signs include "Amazon EU S.à r.l." (however it's written, e.g. "Amazon EU S.a.r.L."), "Amazon.co.uk", "Amazon Services Europe", "Amazon Payments" or an Amazon order number such as 205-1234567-1234567. Otherwise false.
- temuOrder: true when the order was placed on Temu: Temu is named, or the seller is Whaleco (e.g. "Whaleco UK Limited"). Otherwise false.
- invoiceNumber and orderNumber: as printed, or "" if absent.
- paymentMethod: "card", "cash" or "bank_transfer" only when the document says how it was paid (a card receipt, "paid by BACS"); otherwise null.
- lineItems: what was bought, one line per item or group of similar items, with the amount actually paid including any VAT. Put delivery or postage on its own line. Spread a discount over the lines it applies to, so every amount is above zero and the lines add up to the total paid. If the lines can't be read, give one line for the whole total.
- description: for each line, what was bought, as it would be written in a ledger: about 60 characters at most. A short description stays as printed. Shorten a long one, such as an Amazon product title, to what the item is, the brand if it helps, and the size or quantity; leave out sales wording, lists of uses or compatible models, and colour or style options unless they matter. For example "SUNNYCLUE 1 Box 600Pcs Assorted Glass Beads for Jewellery Making Kit, Mixed Colour Loose Spacer Beads Craft Supplies for Bracelets Necklaces DIY" becomes "SUNNYCLUE assorted glass beads, 600 pcs".
- categoryId: for each line, the id of the category from the list that fits best, or null if none does. The owner's own categories say which standard category they come under; prefer one of the owner's own when it fits.
- total: the total paid, or null if the document shows none.
Amounts are pounds as plain numbers in strings, e.g. "4.99", without £ or commas.
Copy names and numbers faithfully; don't invent anything the document doesn't show.`;

const replySchema = z.object({
  date: z.string().nullable(),
  payee: z.string(),
  amazonOrder: z.boolean().optional(),
  temuOrder: z.boolean().optional(),
  invoiceNumber: z.string(),
  orderNumber: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  lineItems: z.array(z.object({ description: z.string(), amount: z.string(), categoryId: z.string().nullable() })),
  total: z.string().nullable(),
});

export function outputSchema(categoryIds: string[]) {
  const nullableString = { type: ['string', 'null'] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'payee', 'amazonOrder', 'temuOrder', 'invoiceNumber', 'orderNumber', 'paymentMethod', 'lineItems', 'total'],
    properties: {
      date: nullableString,
      payee: { type: 'string' },
      amazonOrder: { type: 'boolean' },
      temuOrder: { type: 'boolean' },
      invoiceNumber: { type: 'string' },
      orderNumber: { type: 'string' },
      paymentMethod: { anyOf: [{ type: 'string', enum: [...PAYMENT_METHODS] }, { type: 'null' }] },
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'amount', 'categoryId'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'string' },
            categoryId: { anyOf: [{ type: 'string', enum: categoryIds }, { type: 'null' }] },
          },
        },
      },
      total: nullableString,
    },
  };
}

/**
 * The categories as the prompt lists them, one per line as `id: name`. The owner's own categories
 * also say which standard category they come under, which helps when the name alone is vague.
 */
export function categoryListText(categories: ReadableCategory[]): string {
  const standard = new Map(categories.filter((c) => !c.isCustom).map((c) => [c.hmrcCode, c.name]));
  return categories
    .map((c) => {
      const under = c.isCustom ? standard.get(c.hmrcCode) : undefined;
      return c.isCustom ? `${c.id}: ${c.name} (owner's own${under ? `, under ${under}` : ''})` : `${c.id}: ${c.name}`;
    })
    .join('\n');
}

/** The message sent with the document. */
export const readRequest = (categories: ReadableCategory[]) => `Expense categories (id: name):\n${categoryListText(categories)}\n\nRead this document.`;

/** Turns the AI's reply into a reading, keeping only what fits the form, with warnings for what to check. */
export function toInvoiceReading(reply: unknown, categories: InvoiceInput['categories'], provider: AiProvider = 'claude'): InvoiceReading {
  const parsed = replySchema.safeParse(reply);
  if (!parsed.success) throw new HttpError(502, `${AI_PROVIDER_INFO[provider].name}'s reply couldn't be understood. Try again, or fill in the expense yourself.`);
  const r = parsed.data;
  const warnings: string[] = [];
  const known = new Set(categories.map((c) => c.id));

  const lineItems = r.lineItems.flatMap((line) => {
    const amountPence = parsePoundsToPence(line.amount);
    if (amountPence === null || amountPence <= 0) {
      warnings.push(`A line couldn't be read ("${line.description}", ${line.amount}), so it was left out.`);
      return [];
    }
    const id = line.categoryId === null ? null : Number(line.categoryId);
    return [{ description: line.description.trim().slice(0, 500), amountPence, categoryId: id !== null && known.has(id) ? id : null }];
  });
  if (lineItems.some((l) => l.categoryId === null)) warnings.push('Choose a category for the lines left without one.');

  const totalPence = r.total === null ? null : parsePoundsToPence(r.total);
  const linesPence = lineItems.reduce((sum, l) => sum + l.amountPence, 0);
  if (totalPence !== null && totalPence !== linesPence) {
    warnings.push(`The lines add up to £${(linesPence / 100).toFixed(2)}, but the invoice's total is £${(totalPence / 100).toFixed(2)}.`);
  }

  const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && !Number.isNaN(Date.parse(r.date)) ? r.date : null;
  if (!date) warnings.push('No date could be read; enter it yourself.');
  // Amazon and Temu orders are paid by card.
  const paymentMethod = r.amazonOrder || r.temuOrder ? 'card' : r.paymentMethod;
  if (!paymentMethod) warnings.push('The invoice doesn\'t say how it was paid; choose the payment method.');

  return {
    date,
    // Amazon and Temu orders always go under one payee each, whichever seller the invoice names.
    payee: r.amazonOrder ? AMAZON_PAYEE : r.temuOrder ? TEMU_PAYEE : r.payee.trim().slice(0, 200),
    invoiceNumber: r.invoiceNumber.trim().slice(0, 100),
    orderNumber: r.orderNumber.trim().slice(0, 100),
    paymentMethod,
    lineItems,
    totalPence,
    warnings,
  };
}


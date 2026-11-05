// Reads an invoice or receipt with Claude (Anthropic API) and returns what a new expense
// needs. Nothing is saved: the form is filled in for the person to check.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { parsePoundsToPence, PAYMENT_METHODS, type ClaudeModel, type InvoiceReading } from '@crafty/shared';
import { HttpError } from './http';

export type InvoiceMediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export interface InvoiceInput {
  data: Buffer;
  mediaType: InvoiceMediaType;
  /** The expense categories a line may go in. */
  categories: { id: number; name: string; hmrcCode: string }[];
}

/** Calls to Claude through the Anthropic API, with the key saved in Settings → Claude Integration. Tests replace it. */
export interface ClaudeApi {
  /** Refuses (HttpError 422) a key Anthropic doesn't accept, or one that can't use the model. */
  checkKey(apiKey: string, model: ClaudeModel): Promise<void>;
  readInvoice(apiKey: string, model: ClaudeModel, input: InvoiceInput): Promise<InvoiceReading>;
}

/** The largest image the API takes. */
export const MAX_INVOICE_IMAGE_BYTES = 5 * 1024 * 1024;

const SYSTEM = `You read invoices and receipts for the bookkeeping of a UK sole trader who uses the cash basis and isn't VAT registered.
Read the document and fill in one expense:
- date: when it was paid if shown, else the invoice date, as YYYY-MM-DD. UK documents write dates day first. null if there is none.
- payee: the business that was paid, as it names itself.
- invoiceNumber and orderNumber: as printed, or "" if absent.
- paymentMethod: "card", "cash" or "bank_transfer" only when the document says how it was paid (a card receipt, "paid by BACS"); otherwise null.
- lineItems: what was bought, one line per item or group of similar items, with the amount actually paid including any VAT. Put delivery or postage on its own line. Spread a discount over the lines it applies to, so every amount is above zero and the lines add up to the total paid. If the lines can't be read, give one line for the whole total.
- categoryId: for each line, the id of the category from the list that fits best, or null if none does.
- total: the total paid, or null if the document shows none.
Amounts are pounds as plain numbers in strings, e.g. "4.99", without £ or commas.
Copy names and descriptions faithfully; don't invent anything the document doesn't show.`;

const replySchema = z.object({
  date: z.string().nullable(),
  payee: z.string(),
  invoiceNumber: z.string(),
  orderNumber: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  lineItems: z.array(z.object({ description: z.string(), amount: z.string(), categoryId: z.string().nullable() })),
  total: z.string().nullable(),
});

function outputSchema(categoryIds: string[]) {
  const nullableString = { type: ['string', 'null'] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'payee', 'invoiceNumber', 'orderNumber', 'paymentMethod', 'lineItems', 'total'],
    properties: {
      date: nullableString,
      payee: { type: 'string' },
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

/** Turns Claude's reply into a reading, keeping only what fits the form, with warnings for what to check. */
export function toInvoiceReading(reply: unknown, categories: InvoiceInput['categories']): InvoiceReading {
  const parsed = replySchema.safeParse(reply);
  if (!parsed.success) throw new HttpError(502, 'Claude\'s reply couldn\'t be understood. Try again, or fill in the expense yourself.');
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
  if (!r.paymentMethod) warnings.push('The invoice doesn\'t say how it was paid; choose the payment method.');

  return {
    date,
    payee: r.payee.trim().slice(0, 200),
    invoiceNumber: r.invoiceNumber.trim().slice(0, 100),
    orderNumber: r.orderNumber.trim().slice(0, 100),
    paymentMethod: r.paymentMethod,
    lineItems,
    totalPence,
    warnings,
  };
}

/** Turns the SDK's errors into ones the app can show. Never 401: the client would take it as being signed out. */
function apiError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new HttpError(502, 'Anthropic refused the API key saved in Settings → Claude Integration.');
  }
  if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'The Anthropic API is busy or the account is out of credit. Try again later.');
  if (err instanceof Anthropic.BadRequestError) throw new HttpError(422, `Claude couldn't read that file: ${err.message}`);
  if (err instanceof Anthropic.APIError) throw new HttpError(502, `The Anthropic API didn't answer properly (${err.status ?? 'no connection'}). Try again later.`);
  throw err;
}

export const anthropicApi: ClaudeApi = {
  async checkKey(apiKey, model) {
    try {
      await new Anthropic({ apiKey, maxRetries: 0 }).models.retrieve(model);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new HttpError(422, 'Anthropic didn\'t accept that key. Check you copied all of it.');
      if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
        throw new HttpError(422, 'That key can\'t use the chosen model. Try another model, or check the key\'s workspace in the Anthropic Console.');
      }
      if (err instanceof Anthropic.APIConnectionError) throw new HttpError(502, 'Couldn\'t reach Anthropic to check the key. Check the server is online.');
      apiError(err);
    }
  },

  async readInvoice(apiKey, model, { data, mediaType, categories }) {
    const client = new Anthropic({ apiKey });
    const categoryList = categories.map((c) => `${c.id}: ${c.name}`).join('\n');
    const source = { type: 'base64' as const, data: data.toString('base64') };
    const document =
      mediaType === 'application/pdf'
        ? { type: 'document' as const, source: { ...source, media_type: mediaType } }
        : { type: 'image' as const, source: { ...source, media_type: mediaType } };

    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // If a safety check declines the request, the API retries it on another model. Haiku has no fallback.
        ...(model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: outputSchema(categories.map((c) => String(c.id))) },
        },
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [document, { type: 'text', text: `Expense categories (id: name):\n${categoryList}\n\nRead this document.` }],
          },
        ],
      });
    } catch (err) {
      apiError(err);
    }

    if (response.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to read this document.');
    if (response.stop_reason === 'max_tokens') throw new HttpError(422, 'The invoice was too long to read in one go.');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      reply = null;
    }
    return toInvoiceReading(reply, categories);
  },
};

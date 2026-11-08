// The name given to an invoice once the AI has read it, so documents sort by date and say what they are.
// It follows a pattern chosen in Settings → AI Document Scanning, such as the default
// {date}_{payee}_{invoice}_£{amount} → 2025-07-24_Amazon_DS-AEU-INV-GB-2025-394494656_£31.33.pdf
// Only documents the AI read are renamed; files chosen any other way keep their names.

import { penceToPounds } from './money';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from './schemas';

export const DEFAULT_FILENAME_PATTERN = '{date}_{payee}_{invoice}_£{amount}';
export const MAX_FILENAME_PATTERN_LENGTH = 200;
/** The longest name, before its extension. */
const MAX_NAME_LENGTH = 200;

/** What the AI read, as far as naming the file goes. */
export interface InvoiceNameParts {
  date: string | null;
  payee: string;
  invoiceNumber: string;
  orderNumber?: string;
  amountPence: number | null;
  paymentMethod?: PaymentMethod | null;
  /** The category of the largest line. */
  category?: string | null;
  /** The first line's description. */
  description?: string | null;
}

/** Characters that aren't safe in a filename on some systems, and control characters. */
const UNSAFE = /[\\/:*?"<>|\x00-\x1f\x7f]+/g;
const UNSAFE_TEST = /[\\/:*?"<>|\x00-\x1f\x7f]/;

function part(text: string | null | undefined, max: number): string {
  return (text ?? '').replace(UNSAFE, '-').replace(/\s+/g, ' ').replace(/\.{2,}/g, '.').trim().slice(0, max).trim();
}

const datePart = (date: string | null, from: number, to: number) => (date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(from, to) : '');

/** The fields a pattern can use, in the order Settings lists them. */
export const FILENAME_FIELDS = [
  { token: 'date', label: 'Date', example: '2025-07-24', value: (i: InvoiceNameParts) => part(i.date, 10) },
  { token: 'year', label: 'Year', example: '2025', value: (i: InvoiceNameParts) => datePart(i.date, 0, 4) },
  { token: 'month', label: 'Month', example: '07', value: (i: InvoiceNameParts) => datePart(i.date, 5, 7) },
  { token: 'day', label: 'Day', example: '24', value: (i: InvoiceNameParts) => datePart(i.date, 8, 10) },
  { token: 'payee', label: 'Payee', example: 'Amazon', value: (i: InvoiceNameParts) => part(i.payee, 80) },
  { token: 'invoice', label: 'Invoice number', example: 'INV-1042', value: (i: InvoiceNameParts) => part(i.invoiceNumber, 80) },
  { token: 'order', label: 'Order number', example: '205-1234567-7654321', value: (i: InvoiceNameParts) => part(i.orderNumber, 80) },
  {
    token: 'amount',
    label: 'Amount',
    example: '31.33',
    value: (i: InvoiceNameParts) => (i.amountPence !== null && i.amountPence > 0 ? penceToPounds(i.amountPence) : ''),
  },
  { token: 'payment', label: 'Payment method', example: 'Card', value: (i: InvoiceNameParts) => (i.paymentMethod ? PAYMENT_METHOD_LABELS[i.paymentMethod] : '') },
  { token: 'category', label: 'Category (largest line)', example: 'Cost of goods', value: (i: InvoiceNameParts) => part(i.category, 60) },
  { token: 'description', label: 'First line', example: 'Glass seed beads, 500g', value: (i: InvoiceNameParts) => part(i.description, 60) },
] as const;

export type FilenameToken = (typeof FILENAME_FIELDS)[number]['token'];

/** An invoice to show what a pattern gives, made from the fields' examples. */
export const EXAMPLE_INVOICE: InvoiceNameParts = {
  date: '2025-07-24',
  payee: 'Amazon',
  invoiceNumber: 'INV-1042',
  orderNumber: '205-1234567-7654321',
  amountPence: 3133,
  paymentMethod: 'card',
  category: 'Cost of goods',
  description: 'Glass seed beads, 500g',
};

const fieldsByToken = new Map<string, (typeof FILENAME_FIELDS)[number]>(FILENAME_FIELDS.map((f) => [f.token, f]));

/** Why a pattern can't be used, or null when it can. */
export function filenamePatternProblem(pattern: string): string | null {
  if (!pattern.trim()) return 'Enter a pattern';
  if (pattern.length > MAX_FILENAME_PATTERN_LENGTH) return `Keep the pattern under ${MAX_FILENAME_PATTERN_LENGTH} characters`;
  const unknown = [...pattern.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).find((t) => !fieldsByToken.has(t));
  if (unknown !== undefined) return `{${unknown}} isn't one of the fields`;
  const literal = pattern.replace(/\{[^{}]*\}/g, '');
  if (/[{}]/.test(literal)) return 'Each field needs both its braces, like {date}';
  if (UNSAFE_TEST.test(literal)) return 'Filenames can\'t contain \\ / : * ? " < > |';
  if (!/\{[^{}]+\}/.test(pattern)) return 'Use at least one field, such as {date}';
  return null;
}

/**
 * The name for a read invoice, such as "2025-07-24_Amazon_INV-1_£31.33.pdf". A field the invoice
 * doesn't give is left out with the text before it (so "_£{amount}" goes as a whole), and text
 * between fields is kept only between fields that are there. Null when the invoice gives none of
 * the pattern's fields, so the file keeps its own name. A pattern that can't be used falls back
 * to the default.
 */
export function invoiceFilename(invoice: InvoiceNameParts, extension: string, pattern: string = DEFAULT_FILENAME_PATTERN): string | null {
  if (filenamePatternProblem(pattern)) pattern = DEFAULT_FILENAME_PATTERN;
  // [text, token, text, token, …, text]
  const pieces = pattern.split(/\{([^{}]+)\}/);
  let name = pieces[0];
  let found = false;
  for (let i = 1; i < pieces.length; i += 2) {
    const value = fieldsByToken.get(pieces[i])!.value(invoice);
    if (!value) continue;
    // Text before the first field after the start only joins it to fields that aren't there,
    // except what belongs to the field itself, such as the £ in "_£{amount}".
    const before = i === 1 ? '' : found ? pieces[i - 1] : pieces[i - 1].replace(/^[\s_.,-]+/, '');
    name += before + value;
    found = true;
  }
  if (!found) return null;
  name += pieces[pieces.length - 1];
  name = name.replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, MAX_NAME_LENGTH).trim();
  return name ? `${name}${extension.toLowerCase()}` : null;
}

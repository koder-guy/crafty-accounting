// The name given to an invoice once Claude has read it, so documents sort by date and say what they are:
// <date>_<payee>_<invoice number>_<amount>, e.g. 2025-07-24_Amazon_DS-AEU-INV-GB-2025-394494656_£31.33.pdf

import { penceToPounds } from './money';

/** Characters that aren't safe in a filename on some systems, and control characters. */
const UNSAFE = /[\\/:*?"<>|\x00-\x1f\x7f]+/g;

function part(text: string | null | undefined, max: number): string {
  return (text ?? '').replace(UNSAFE, '-').replace(/\s+/g, ' ').replace(/\.{2,}/g, '.').trim().slice(0, max).trim();
}

/**
 * Such as "2025-07-24_Amazon_INV-1_£31.33.pdf". Parts the invoice doesn't give are left out;
 * null when it gives none of them, so the file keeps its own name.
 */
export function invoiceFilename(
  invoice: { date: string | null; payee: string; invoiceNumber: string; amountPence: number | null },
  extension: string,
): string | null {
  const parts = [
    part(invoice.date, 10),
    part(invoice.payee, 80),
    part(invoice.invoiceNumber, 80),
    invoice.amountPence !== null && invoice.amountPence > 0 ? `£${penceToPounds(invoice.amountPence)}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts.join('_').replace(/^\.+/, '')}${extension.toLowerCase()}`;
}

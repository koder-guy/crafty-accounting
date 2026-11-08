// A PDF statement of one Square payout, attached to the income and the fee expense it's imported
// as. Square's API has no statement or fee invoice to download, so this is made from what it
// does give: the payout, its entries and, where Square lets the token read them, the payments
// behind them (receipt numbers, links to Square's receipt pages, cards).
import { formatDisplayDate, formatGBP } from '@crafty/shared';
import { PageSizes, PDFDocument, PDFString, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

export interface StatementPayment {
  receiptNumber: string | null;
  receiptUrl: string | null;
  card: string | null;
}

export interface StatementRow {
  /** London time, as "03/10/2026 10:40"; empty for the payout's own fee. */
  when: string;
  type: string;
  payment: StatementPayment | null;
  grossPence: number;
  feePence: number;
  netPence: number;
}

export interface PayoutStatement {
  merchantName: string | null;
  payoutId: string;
  arrivalDate: string;
  netPence: number;
  salesPence: number;
  refundsPence: number;
  incomePence: number;
  feesPence: number;
  rows: StatementRow[];
  /** Whether receipt numbers could be read from Square. */
  receiptsRead: boolean;
  madeOn: string;
}

const TYPE_NAMES: Record<string, string> = { CHARGE: 'Sale', REFUND: 'Refund' };

export const entryTypeName = (type: string): string => TYPE_NAMES[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');

export const londonDateTime = (instant: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(instant))
    .replace(',', '');

// ---- Drawing ----

const MARGIN = 40;
const [PAGE_W, PAGE_H] = PageSizes.A4;
const LINE = 15;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.48);
const ACCENT = rgb(0.31, 0.27, 0.9);
const RULE = rgb(0.82, 0.82, 0.86);

/** Columns: left edge for text, right edge for amounts. */
const COLS = {
  when: MARGIN,
  type: 132,
  receipt: 212,
  card: 268,
  gross: 425,
  fee: 490,
  net: PAGE_W - MARGIN,
};

export async function payoutStatementPdf(s: PayoutStatement): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const known = new Set(regular.getCharacterSet());
  // Helvetica only has Western European characters; anything else would stop the PDF being made, so it's left out.
  const clean = (text: string) =>
    [...text]
      .filter((c) => known.has(c.codePointAt(0)!))
      .join('')
      .replace(/ {2,}/g, ' ');

  const title = `Square payout ${s.payoutId}`;
  doc.setTitle(title);
  doc.setSubject(`Square payout of ${formatGBP(s.netPence)} paid into the bank on ${formatDisplayDate(s.arrivalDate)}`);
  doc.setCreator('Crafty Accounting');
  doc.setProducer('Crafty Accounting');

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const text = (
    str: string,
    x: number,
    at: number,
    opts: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      right?: boolean;
    } = {},
  ) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 9;
    const t = clean(str);
    const width = font.widthOfTextAtSize(t, size);
    page.drawText(t, {
      x: opts.right ? x - width : x,
      y: at,
      size,
      font,
      color: opts.color ?? INK,
    });
    return width;
  };
  const rule = (at: number) =>
    page.drawLine({
      start: { x: MARGIN, y: at },
      end: { x: PAGE_W - MARGIN, y: at },
      thickness: 0.6,
      color: RULE,
    });
  const link = (url: string, x: number, at: number, width: number) => {
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, at - 2, x + width, at + 9],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    });
    page.node.addAnnot(doc.context.register(annot));
  };

  const tableHeader = () => {
    text('Date and time', COLS.when, y, { font: bold, color: MUTED });
    text('Type', COLS.type, y, { font: bold, color: MUTED });
    text('Receipt', COLS.receipt, y, { font: bold, color: MUTED });
    text('Card', COLS.card, y, { font: bold, color: MUTED });
    text('Amount', COLS.gross, y, { font: bold, color: MUTED, right: true });
    text('Fee', COLS.fee, y, { font: bold, color: MUTED, right: true });
    text('Net', COLS.net, y, { font: bold, color: MUTED, right: true });
    rule(y - 5);
    y -= LINE + 3;
  };
  const newPage = (withTable: boolean) => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN - 10;
    if (pages.length > 1) {
      text(`${title} (continued)`, MARGIN, y, { font: bold, size: 10 });
      y -= LINE * 2;
    }
    if (withTable) tableHeader();
  };

  // ---- The summary ----
  newPage(false);
  text('Square payout statement', MARGIN, y, { font: bold, size: 18 });
  y -= 24;
  if (s.merchantName) {
    text(s.merchantName, MARGIN, y, { size: 11, color: MUTED });
    y -= LINE + 6;
  } else y -= 6;

  const facts: [string, string][] = [
    ['Payout', s.payoutId],
    ['Paid into the bank', formatDisplayDate(s.arrivalDate)],
    ['Amount paid', formatGBP(s.netPence)],
  ];
  for (const [label, value] of facts) {
    text(label, MARGIN, y, { color: MUTED, size: 10 });
    text(value, MARGIN + 120, y, {
      size: 10,
      font: label === 'Amount paid' ? bold : regular,
    });
    y -= LINE;
  }
  y -= 10;

  const summaryRight = MARGIN + 300;
  const sums: [string, number, boolean][] = [
    ['Card sales', s.salesPence, false],
    ...(s.refundsPence ? ([['Less refunds', -s.refundsPence, false]] as [string, number, boolean][]) : []),
    ['Sales (recorded as income)', s.incomePence, true],
    ['Square’s fees (recorded as an expense)', -s.feesPence, false],
    ['Paid into the bank', s.netPence, true],
  ];
  for (const [label, pence, strong] of sums) {
    if (strong) {
      page.drawLine({
        start: { x: MARGIN, y: y + LINE - 3 },
        end: { x: summaryRight, y: y + LINE - 3 },
        thickness: 0.6,
        color: RULE,
      });
    }
    text(label, MARGIN, y, { size: 10, font: strong ? bold : regular });
    text(formatGBP(pence), summaryRight, y, {
      size: 10,
      font: strong ? bold : regular,
      right: true,
    });
    y -= LINE + (strong ? 4 : 0);
  }
  y -= 16;

  // ---- The entries ----
  text(`What the payout is made of (${s.rows.length} ${s.rows.length === 1 ? 'entry' : 'entries'})`, MARGIN, y, { font: bold, size: 11 });
  y -= LINE + 6;
  tableHeader();
  let gross = 0;
  let fee = 0;
  let net = 0;
  for (const row of s.rows) {
    if (y < MARGIN + 40) newPage(true);
    text(row.when, COLS.when, y);
    text(row.type, COLS.type, y);
    const receipt = row.payment?.receiptNumber;
    if (receipt) {
      const url = row.payment?.receiptUrl;
      const width = text(receipt, COLS.receipt, y, url ? { color: ACCENT } : {});
      if (url && /^https:\/\//.test(url)) link(url, COLS.receipt, y, width);
    }
    if (row.payment?.card) text(row.payment.card, COLS.card, y);
    text(formatGBP(row.grossPence), COLS.gross, y, { right: true });
    text(formatGBP(row.feePence), COLS.fee, y, { right: true });
    text(formatGBP(row.netPence), COLS.net, y, { right: true });
    gross += row.grossPence;
    fee += row.feePence;
    net += row.netPence;
    y -= LINE;
  }
  if (y < MARGIN + 40) newPage(true);
  rule(y + LINE - 4);
  text('Total', COLS.when, y, { font: bold });
  text(formatGBP(gross), COLS.gross, y, { font: bold, right: true });
  text(formatGBP(fee), COLS.fee, y, { font: bold, right: true });
  text(formatGBP(net), COLS.net, y, { font: bold, right: true });

  // ---- Footers ----
  const notes = [
    `Made by Crafty Accounting on ${formatDisplayDate(s.madeOn)} from Square’s record of this payout. Times are UK time.`,
    s.receiptsRead
      ? 'Receipt numbers link to Square’s receipt for each sale; every sale is also in Square Dashboard under Transactions.'
      : 'Square didn’t give receipt numbers for these sales; every sale is in Square Dashboard under Transactions.',
  ];
  pages.forEach((p, i) => {
    page = p;
    let at = MARGIN - 4;
    if (i === pages.length - 1) {
      for (const note of [...notes].reverse()) {
        at += 11;
        text(note, MARGIN, at, { size: 7.5, color: MUTED });
      }
    }
    text(`Page ${i + 1} of ${pages.length}`, PAGE_W - MARGIN, MARGIN - 4, {
      size: 7.5,
      color: MUTED,
      right: true,
    });
  });
  return doc.save();
}

// All money is held as integer pence to avoid floating-point rounding.

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

/** Parses "12", "12.5", "£1,234.56" into pence. Returns null if invalid. */
export function parsePoundsToPence(input: string | number): number | null {
  const text = String(input).trim().replace(/^£/, '').replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const pence = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(pence)) return null;
  return match[1] ? -pence : pence;
}

/** Formats pence as a plain decimal string, e.g. 123456 -> "1234.56". */
export function penceToPounds(pence: number): string {
  const abs = Math.abs(pence);
  return `${pence < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatGBP(pence: number): string {
  return gbp.format(pence / 100);
}

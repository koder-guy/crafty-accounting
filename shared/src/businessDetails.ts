// Settings → Business Details: who the sole trader is and what the business does,
// plus an optional logo. The app needs at least the required fields before anything else.
import { z } from 'zod';
import { isValidIsoDate } from './taxYear';

/** Most bytes a stored logo can take. The browser makes logos much smaller than this before uploading. */
export const MAX_LOGO_BYTES = 512 * 1024;
/** What the browser aims for when it makes a logo smaller. */
export const TARGET_LOGO_BYTES = 300 * 1024;
/** Longest side, in pixels, the browser scales a logo down to. */
export const MAX_LOGO_DIMENSION = 1200;
/** Logos are stored as PNG or JPEG, the formats pdf-lib can put in a PDF. */
export const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/** The image type a file's first bytes show, or null for anything but PNG and JPEG. */
export function logoTypeOf(bytes: Uint8Array): LogoType | null {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

const optionalText = (max: number, message?: string) =>
  z
    .string()
    .trim()
    .max(max, message ?? `Use ${max} characters or fewer`)
    .nullish()
    .transform((v) => (v ? v : null));

/** A UK postcode such as OX10 8BA, upper-cased with one space before the last three characters. */
export function normalisePostcode(value: string): string {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  return compact.length > 3 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : compact;
}

const POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?|GIR) ?(\d[A-Z]{2}|0AA)$/;

const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidIsoDate(v), 'Enter a valid date');

export const businessDetailsSchema = z
  .object({
    ownerName: z.string().trim().min(1, 'Enter your full name').max(100, 'Use 100 characters or fewer'),
    tradingName: optionalText(100),
    description: z
      .string()
      .trim()
      .min(1, 'Say what the business does')
      .max(200, 'Keep it short: 200 characters or fewer'),
    addressLine1: optionalText(100),
    addressLine2: optionalText(100),
    town: optionalText(60),
    county: optionalText(60),
    postcode: z
      .string()
      .trim()
      .min(1, 'Enter the business postcode')
      .transform(normalisePostcode)
      .refine((v) => POSTCODE.test(v), 'Enter a UK postcode like OX10 8BA'),
    email: optionalText(200).refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter an email address like name@example.com'),
    phone: optionalText(30).refine((v) => v === null || /^\+?[\d\s()-]{6,}$/.test(v), 'Enter a phone number using digits'),
    website: optionalText(200).refine((v) => v === null || /^(https?:\/\/)?[^\s./]+(\.[^\s./]+)+(\/\S*)?$/i.test(v), 'Enter a web address like example.co.uk'),
    startDate: optionalDate,
    endDate: optionalDate,
    utr: z
      .string()
      .nullish()
      .transform((v) => (v ? v.replace(/\s+/g, '') : null))
      .refine((v) => v === null || /^\d{10}$/.test(v), 'A UTR is 10 digits'),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
    message: 'The business can’t stop before it started',
    path: ['endDate'],
  });

export type BusinessDetails = z.output<typeof businessDetailsSchema>;
export type BusinessDetailsInput = z.input<typeof businessDetailsSchema>;

/** Saving the details: the fields, plus whether to drop the logo and the version being edited. A new logo comes as a file alongside. */
export const businessSaveSchema = z.object({
  details: businessDetailsSchema,
  removeLogo: z.boolean().optional(),
  expectedUpdatedAt: z.string().nullable().optional(),
});

export type BusinessSaveInput = z.input<typeof businessSaveSchema>;

export interface BusinessLogo {
  type: LogoType;
  bytes: number;
  /** Changes whenever the logo does, so browsers can keep it cached. */
  url: string;
}

export interface BusinessResponse {
  /** Null until someone sets the business up; the app asks for it before anything else. */
  details: BusinessDetails | null;
  logo: BusinessLogo | null;
  /** The made-up business that comes with the sample data, until someone edits it. */
  isSample: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The name the business goes by: its trading name, else the owner's own. */
export const businessName = (details: Pick<BusinessDetails, 'ownerName' | 'tradingName'>) => details.tradingName ?? details.ownerName;

/** The address on one line, leaving out what isn't filled in. */
export const businessAddress = (d: Pick<BusinessDetails, 'addressLine1' | 'addressLine2' | 'town' | 'county' | 'postcode'>) =>
  [d.addressLine1, d.addressLine2, d.town, d.county, d.postcode].filter(Boolean).join(', ');

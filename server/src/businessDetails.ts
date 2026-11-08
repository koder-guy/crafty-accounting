// The business's details and logo (one row in business_details). Until they're saved,
// businessSetupGuard keeps the books closed.
import type { BusinessDetails, BusinessResponse, LogoType } from '@crafty/shared';
import type { Db } from './db';

interface Row {
  owner_name: string;
  trading_name: string | null;
  description: string;
  address_line1: string | null;
  address_line2: string | null;
  town: string | null;
  county: string | null;
  postcode: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  start_date: string | null;
  end_date: string | null;
  utr: string | null;
  logo_type: LogoType | null;
  logo_bytes: number | null;
  is_sample: number;
  updated_at: string;
  updated_by: string;
}

const SELECT = `SELECT owner_name, trading_name, description, address_line1, address_line2, town, county, postcode, email, phone, website,
  start_date, end_date, utr, logo_type, length(logo) AS logo_bytes, is_sample, updated_at, updated_by FROM business_details WHERE id = 1`;

export function businessIsSetUp(db: Db): boolean {
  return db.prepare('SELECT 1 FROM business_details WHERE id = 1').get() !== undefined;
}

export function getBusiness(db: Db): BusinessResponse {
  const row = db.prepare(SELECT).get() as Row | undefined;
  if (!row) return { details: null, logo: null, isSample: false, updatedAt: null, updatedBy: null };
  const details: BusinessDetails = {
    ownerName: row.owner_name,
    tradingName: row.trading_name,
    description: row.description,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    town: row.town,
    county: row.county,
    postcode: row.postcode,
    email: row.email,
    phone: row.phone,
    website: row.website,
    startDate: row.start_date,
    endDate: row.end_date,
    utr: row.utr,
  };
  return {
    details,
    logo:
      row.logo_type && row.logo_bytes
        ? { type: row.logo_type, bytes: row.logo_bytes, url: `/api/business/logo?v=${encodeURIComponent(row.updated_at)}` }
        : null,
    isSample: row.is_sample === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function getBusinessLogo(db: Db): { data: Buffer; type: LogoType } | null {
  const row = db.prepare('SELECT logo, logo_type FROM business_details WHERE id = 1 AND logo IS NOT NULL').get() as
    | { logo: Buffer; logo_type: LogoType }
    | undefined;
  return row ? { data: row.logo, type: row.logo_type } : null;
}

/**
 * Saves the details. `logo` replaces the logo, null removes it, undefined leaves it as it is.
 * Saved by a person, the details are no longer the sample business.
 */
export function saveBusiness(
  db: Db,
  details: BusinessDetails,
  { by, logo, isSample = false, updatedAt }: { by: string; logo?: { data: Buffer; type: LogoType } | null; isSample?: boolean; updatedAt: string },
): void {
  const fields = {
    owner_name: details.ownerName,
    trading_name: details.tradingName,
    description: details.description,
    address_line1: details.addressLine1,
    address_line2: details.addressLine2,
    town: details.town,
    county: details.county,
    postcode: details.postcode,
    email: details.email,
    phone: details.phone,
    website: details.website,
    start_date: details.startDate,
    end_date: details.endDate,
    utr: details.utr,
    is_sample: isSample ? 1 : 0,
    updated_at: updatedAt,
    updated_by: by,
  };
  const columns = Object.keys(fields);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO business_details (id, ${columns.join(', ')}) VALUES (1, ${columns.map((c) => `@${c}`).join(', ')})
       ON CONFLICT (id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    ).run(fields);
    if (logo !== undefined) {
      db.prepare('UPDATE business_details SET logo = ?, logo_type = ? WHERE id = 1').run(logo?.data ?? null, logo?.type ?? null);
    }
  })();
}

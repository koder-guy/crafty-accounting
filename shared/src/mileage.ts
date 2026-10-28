// Business mileage claimed at HMRC's approved mileage rates (a "simplified
// expense"). The claim counts as car, van and travel expenses
// (carVanTravelExpenses), so it goes in SA103S box 12 and the MTD figures.
//
// Distances are stored in tenths of a mile so they stay whole numbers, like money.

export const VEHICLES = ['car', 'motorcycle', 'bicycle'] as const;
export type Vehicle = (typeof VEHICLES)[number];

export const VEHICLE_LABELS: Record<Vehicle, string> = {
  car: 'Car or van',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
};

/** The MTD category mileage claims count towards. */
export const MILEAGE_HMRC_CODE = 'carVanTravelExpenses';

/**
 * HMRC approved mileage rates in pence per mile. Cars and vans get the higher
 * rate for the first 10,000 business miles in a tax year (all cars and vans
 * together), then the lower rate.
 */
export const MILEAGE_RATES = {
  car: { firstPence: 45, afterPence: 25, thresholdMiles: 10_000 },
  motorcycle: 24,
  bicycle: 20,
} as const;

export const MILEAGE_RATE_LABELS: Record<Vehicle, string> = {
  car: '45p a mile for the first 10,000 miles in the tax year, then 25p',
  motorcycle: '24p a mile',
  bicycle: '20p a mile',
};

export interface MileageTripForClaim {
  id: number;
  date: string;
  vehicle: Vehicle;
  distanceTenths: number;
}

/**
 * The claim in pence for each trip, keyed by trip id. Pass every trip in one
 * tax year: the 10,000-mile car and van threshold is counted in date order.
 */
export function mileageClaims(trips: MileageTripForClaim[]): Map<number, number> {
  const threshold = MILEAGE_RATES.car.thresholdMiles * 10;
  let carTenths = 0;
  const claims = new Map<number, number>();
  const ordered = [...trips].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  for (const trip of ordered) {
    let tenthPence: number;
    if (trip.vehicle === 'car') {
      const atFirstRate = Math.max(0, Math.min(trip.distanceTenths, threshold - carTenths));
      tenthPence = atFirstRate * MILEAGE_RATES.car.firstPence + (trip.distanceTenths - atFirstRate) * MILEAGE_RATES.car.afterPence;
      carTenths += trip.distanceTenths;
    } else {
      tenthPence = trip.distanceTenths * MILEAGE_RATES[trip.vehicle];
    }
    claims.set(trip.id, Math.round(tenthPence / 10));
  }
  return claims;
}

/** "23.5" or "23" → tenths of a mile; null if it isn't a distance above zero with at most one decimal place. */
export function parseMilesToTenths(value: string): number | null {
  const text = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d)?$/.test(text)) return null;
  const tenths = Math.round(Number(text) * 10);
  return tenths > 0 ? tenths : null;
}

/** 235 → "23.5", 230 → "23". */
export const tenthsToMiles = (tenths: number) => (tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1));

export const formatMiles = (tenths: number) =>
  `${(tenths / 10).toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${tenths === 10 ? 'mile' : 'miles'}`;

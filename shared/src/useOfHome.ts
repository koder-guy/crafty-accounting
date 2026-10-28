// Working from home claimed at HMRC's flat rate (a "simplified expense"):
// a fixed amount for each month with 25 or more hours of business work at
// home, instead of a share of household bills. The claim counts as rent,
// rates, power and insurance costs (premisesRunningCosts, SA103S box 14).
//
// The app uses its tax months (6th to the 5th), so each month falls in one
// MTD quarter. If HMRC changes the rates, update USE_OF_HOME_BANDS.

export const USE_OF_HOME_HMRC_CODE = 'premisesRunningCosts';

/** Hours of business work at home in a month, and the flat rate for them, highest band first. */
export const USE_OF_HOME_BANDS = [
  { minHours: 101, pence: 2600, label: '101 hours or more' },
  { minHours: 51, pence: 1800, label: '51 to 100 hours' },
  { minHours: 25, pence: 1000, label: '25 to 50 hours' },
] as const;

/** Most hours a month can have (31 days). */
export const MAX_MONTH_HOURS = 744;

/** The flat rate in pence for a month's hours (nothing under 25 hours). */
export function useOfHomeClaim(hours: number): number {
  return USE_OF_HOME_BANDS.find((b) => hours >= b.minHours)?.pence ?? 0;
}

export function useOfHomeBandLabel(hours: number): string | null {
  return USE_OF_HOME_BANDS.find((b) => hours >= b.minHours)?.label ?? null;
}

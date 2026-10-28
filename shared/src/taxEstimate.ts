// A rough estimate of the Income Tax and Class 4 National Insurance due on
// the business's profit, for setting money aside. Uses the rates for England,
// Wales and Northern Ireland; Scottish Income Tax bands differ. It leaves out
// things the app doesn't know about, such as student loans, the High Income
// Child Benefit Charge, pension contributions and Gift Aid.
//
// Amounts are in pence. If HMRC changes the rates, add the new tax year to TAX_RATES.

export interface TaxRates {
  personalAllowancePence: number;
  /** Above this income the personal allowance shrinks by £1 for every £2. */
  allowanceTaperFromPence: number;
  /** Width of the basic rate band (taxable income, after the allowance). */
  basicRateBandPence: number;
  /** Taxable income above this is taxed at the additional rate. */
  additionalRateFromPence: number;
  basicRate: number;
  higherRate: number;
  additionalRate: number;
  class4LowerLimitPence: number;
  class4UpperLimitPence: number;
  class4MainRate: number;
  class4UpperRate: number;
}

const FROZEN_THRESHOLDS: TaxRates = {
  personalAllowancePence: 12_570_00,
  allowanceTaperFromPence: 100_000_00,
  basicRateBandPence: 37_700_00,
  additionalRateFromPence: 125_140_00,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  class4LowerLimitPence: 12_570_00,
  class4UpperLimitPence: 50_270_00,
  class4MainRate: 0.06,
  class4UpperRate: 0.02,
};

/** Rates by tax year label. Thresholds have been frozen since 2021, and Class 4 has been 6% since April 2024. */
export const TAX_RATES: Record<string, TaxRates> = {
  '2024-25': FROZEN_THRESHOLDS,
  '2025-26': FROZEN_THRESHOLDS,
  '2026-27': FROZEN_THRESHOLDS,
};

/** Payments on account are needed when the bill is over this (and less than 80% was taxed at source). */
export const PAYMENTS_ON_ACCOUNT_THRESHOLD_PENCE = 1_000_00;

/** The rates for a tax year, or the latest known rates (flagged as assumed) for a year not in the table. */
export function taxRatesFor(label: string): { rates: TaxRates; ratesLabel: string; assumed: boolean } {
  if (TAX_RATES[label]) return { rates: TAX_RATES[label], ratesLabel: label, assumed: false };
  const known = Object.keys(TAX_RATES).sort();
  const ratesLabel = label < known[0] ? known[0] : known[known.length - 1];
  return { rates: TAX_RATES[ratesLabel], ratesLabel, assumed: true };
}

/** Income Tax on a year's total taxable income, and the personal allowance it gets. */
export function incomeTaxOn(totalPence: number, r: TaxRates): { taxPence: number; personalAllowancePence: number } {
  const income = Math.max(0, totalPence);
  const reduction = income > r.allowanceTaperFromPence ? Math.floor((income - r.allowanceTaperFromPence) / 2) : 0;
  const personalAllowancePence = Math.max(0, r.personalAllowancePence - reduction);
  const taxable = Math.max(0, income - personalAllowancePence);
  const basic = Math.min(taxable, r.basicRateBandPence);
  const higher = Math.min(Math.max(taxable - r.basicRateBandPence, 0), r.additionalRateFromPence - r.basicRateBandPence);
  const additional = Math.max(taxable - r.additionalRateFromPence, 0);
  return {
    taxPence: Math.round(basic * r.basicRate + higher * r.higherRate + additional * r.additionalRate),
    personalAllowancePence,
  };
}

/** Class 4 National Insurance on self-employed profit. */
export function class4On(profitPence: number, r: TaxRates): { mainPence: number; upperPence: number } {
  const main = Math.max(0, Math.min(profitPence, r.class4UpperLimitPence) - r.class4LowerLimitPence);
  const upper = Math.max(0, profitPence - r.class4UpperLimitPence);
  return { mainPence: Math.round(main * r.class4MainRate), upperPence: Math.round(upper * r.class4UpperRate) };
}

export interface TaxEstimate {
  /** Tax year the rates come from; differs from the year asked for when `ratesAssumed`. */
  ratesLabel: string;
  ratesAssumed: boolean;
  /** Taxable profit from the business (never below zero). */
  profitPence: number;
  /** Other taxable income for the year, such as a salary or pension, before tax. */
  otherIncomePence: number;
  personalAllowancePence: number;
  /**
   * Income Tax caused by the business: tax on profit plus other income, less
   * the tax on the other income alone (assumed already paid, e.g. through PAYE).
   */
  incomeTaxPence: number;
  class4MainPence: number;
  class4UpperPence: number;
  class4Pence: number;
  totalPence: number;
  /** Share of the profit to set aside, 0 to 1. */
  setAsideRate: number;
  /** Each of the two payments on account towards next year, if they're needed. */
  paymentOnAccountPence: number | null;
}

export function estimateTax(input: { label: string; profitPence: number; otherIncomePence: number }): TaxEstimate {
  const { rates, ratesLabel, assumed } = taxRatesFor(input.label);
  const profitPence = Math.max(0, input.profitPence);
  const otherIncomePence = Math.max(0, input.otherIncomePence);

  const withBusiness = incomeTaxOn(profitPence + otherIncomePence, rates);
  const withoutBusiness = incomeTaxOn(otherIncomePence, rates);
  const incomeTaxPence = withBusiness.taxPence - withoutBusiness.taxPence;
  const class4 = class4On(profitPence, rates);
  const class4Pence = class4.mainPence + class4.upperPence;
  const totalPence = incomeTaxPence + class4Pence;

  return {
    ratesLabel,
    ratesAssumed: assumed,
    profitPence,
    otherIncomePence,
    personalAllowancePence: withBusiness.personalAllowancePence,
    incomeTaxPence,
    class4MainPence: class4.mainPence,
    class4UpperPence: class4.upperPence,
    class4Pence,
    totalPence,
    setAsideRate: profitPence > 0 ? totalPence / profitPence : 0,
    paymentOnAccountPence: totalPence > PAYMENTS_ON_ACCOUNT_THRESHOLD_PENCE ? Math.round(totalPence / 2) : null,
  };
}

/** When the bill for a tax year (and next year's payments on account) fall due. */
export function taxPaymentDates(startYear: number): { balancing: string; secondPaymentOnAccount: string } {
  return { balancing: `${startYear + 2}-01-31`, secondPaymentOnAccount: `${startYear + 2}-07-31` };
}

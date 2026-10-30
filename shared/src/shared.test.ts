import { describe, expect, it } from 'vitest';
import {
  buildMtdPeriodSummary,
  buildSelfAssessmentSummary,
  estimateTax,
  expenseInputSchema,
  formatGBP,
  isDateInTaxYear,
  isValidIsoDate,
  mileageClaims,
  mtdEarliestSendDate,
  mtdExpensesToSend,
  mtdPayload,
  mtdQuarters,
  mtdQuarterStatus,
  parseMilesToTenths,
  parsePoundsToPence,
  photoFilename,
  penceToPounds,
  selfAssessmentDeadline,
  startYearFromLabel,
  taxMonthIndex,
  taxMonths,
  taxPaymentDates,
  taxRatesFor,
  taxYearFromStartYear,
  taxYearStartYearForDate,
  tenthsToMiles,
  shortCategoryName,
  useOfHomeClaim,
  useOfHomeNextBand,
} from './index';

describe('tax years', () => {
  it('builds UK tax year dates and MTD labels', () => {
    expect(taxYearFromStartYear(2025)).toEqual({ label: '2025-26', startDate: '2025-04-06', endDate: '2026-04-05' });
    expect(taxYearFromStartYear(1999).label).toBe('1999-00');
    expect(startYearFromLabel('2025-26')).toBe(2025);
    expect(startYearFromLabel('2025-27')).toBeNull();
  });

  it('treats 5 April as the last day and 6 April as the first day', () => {
    expect(taxYearStartYearForDate('2026-04-05')).toBe(2025);
    expect(taxYearStartYearForDate('2026-04-06')).toBe(2026);
    expect(taxYearStartYearForDate('2026-01-01')).toBe(2025);
    const year = taxYearFromStartYear(2025);
    expect(isDateInTaxYear('2025-04-05', year)).toBe(false);
    expect(isDateInTaxYear('2025-04-06', year)).toBe(true);
    expect(isDateInTaxYear('2026-04-05', year)).toBe(true);
    expect(isDateInTaxYear('2026-04-06', year)).toBe(false);
  });

  it('validates ISO dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2025-02-29')).toBe(false);
    expect(isValidIsoDate('2025-4-6')).toBe(false);
  });

  it('maps dates to tax months', () => {
    expect(taxMonthIndex('2025-04-06', 2025)).toBe(0);
    expect(taxMonthIndex('2025-05-05', 2025)).toBe(0);
    expect(taxMonthIndex('2025-05-06', 2025)).toBe(1);
    expect(taxMonthIndex('2026-01-05', 2025)).toBe(8);
    expect(taxMonthIndex('2026-04-05', 2025)).toBe(11);
    expect(taxMonthIndex('2026-04-06', 2025)).toBe(-1);
    const months = taxMonths(2025);
    expect(months).toHaveLength(12);
    expect(months[0].range).toBe('6 Apr 2025 – 5 May 2025');
    expect(months[8].range).toBe('6 Dec 2025 – 5 Jan 2026');
    expect(months[11].label).toBe('Mar 26');
  });

  it('gives the Self Assessment deadline', () => {
    expect(selfAssessmentDeadline(2025)).toBe('2027-01-31');
  });
});

describe('money', () => {
  it('parses pounds into pence exactly', () => {
    expect(parsePoundsToPence('12')).toBe(1200);
    expect(parsePoundsToPence('12.5')).toBe(1250);
    expect(parsePoundsToPence('£1,234.56')).toBe(123456);
    expect(parsePoundsToPence('0.29')).toBe(29);
    expect(parsePoundsToPence('1.234')).toBeNull();
    expect(parsePoundsToPence('abc')).toBeNull();
  });

  it('formats pence', () => {
    expect(penceToPounds(123456)).toBe('1234.56');
    expect(penceToPounds(5)).toBe('0.05');
    expect(penceToPounds(-150)).toBe('-1.50');
    expect(formatGBP(51800)).toBe('£518.00');
  });
});

describe('expense schema', () => {
  const base = {
    taxYearId: 1,
    date: '2025-06-01',
    payee: 'Craft Supplies Ltd',
    paymentMethod: 'card',
    lineItems: [
      { description: 'Beads', amountPence: 1000, categoryId: 3 },
      { description: 'Thread', amountPence: 550, categoryId: 3 },
    ],
  };

  it('accepts a total equal to the line items', () => {
    expect(expenseInputSchema.safeParse({ ...base, totalPence: 1550 }).success).toBe(true);
  });

  it('rejects a total that does not match the line items', () => {
    const result = expenseInputSchema.safeParse({ ...base, totalPence: 1500 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['totalPence']);
  });

  it('requires at least one line item', () => {
    expect(expenseInputSchema.safeParse({ ...base, totalPence: 0, lineItems: [] }).success).toBe(false);
  });
});

describe('MTD quarters', () => {
  it('splits the tax year into standard update periods with deadlines', () => {
    const quarters = mtdQuarters(2025);
    expect(quarters.map((q) => [q.startDate, q.endDate, q.deadline])).toEqual([
      ['2025-04-06', '2025-07-05', '2025-08-07'],
      ['2025-07-06', '2025-10-05', '2025-11-07'],
      ['2025-10-06', '2026-01-05', '2026-02-07'],
      ['2026-01-06', '2026-04-05', '2026-05-07'],
    ]);
  });

  it('works out each quarter’s status', () => {
    const [q1] = mtdQuarters(2025);
    expect(mtdQuarterStatus(q1, '2025-04-05', false)).toBe('upcoming');
    expect(mtdQuarterStatus(q1, '2025-07-05', false)).toBe('open');
    expect(mtdQuarterStatus(q1, '2025-08-07', false)).toBe('due');
    expect(mtdQuarterStatus(q1, '2025-08-08', false)).toBe('overdue');
    expect(mtdQuarterStatus(q1, '2025-08-08', true)).toBe('submitted');
  });

  it('converts a summary to an MTD payload in pounds', () => {
    const summary = buildMtdPeriodSummary(
      [{ hmrcCode: 'turnover', amountPence: 51805 }],
      [{ hmrcCode: 'adminCosts', amountPence: 1001, disallowable: true }],
    );
    const payload = mtdPayload(summary, '2025-04-06', '2025-07-05', 'itemised');
    expect(payload).toMatchObject({
      periodDates: { periodStartDate: '2025-04-06', periodEndDate: '2025-07-05' },
      // HMRC wants every field, zeros included.
      periodIncome: { turnover: 518.05, other: 0 },
      periodExpenses: { adminCosts: 10.01, costOfGoods: 0, otherExpenses: 0 },
      periodDisallowableExpenses: { adminCostsDisallowable: 10.01 },
    });
    expect(Object.keys(payload.periodExpenses)).toHaveLength(15);
    expect(Object.keys(payload.periodDisallowableExpenses!)).toEqual(['adminCostsDisallowable']);
    expect(mtdPayload(buildMtdPeriodSummary([], []), '2025-04-06', '2025-07-05', 'itemised')).not.toHaveProperty('periodDisallowableExpenses');
  });

  it('sends one total for expenses, allowable only', () => {
    const summary = buildMtdPeriodSummary(
      [{ hmrcCode: 'turnover', amountPence: 51805 }],
      [
        { hmrcCode: 'adminCosts', amountPence: 2000, disallowable: false },
        { hmrcCode: 'adminCosts', amountPence: 1001, disallowable: true },
        { hmrcCode: 'businessEntertainmentCosts', amountPence: 500, disallowable: true },
        { hmrcCode: 'depreciation', amountPence: 300, disallowable: true },
      ],
    );
    expect(mtdPayload(summary, '2025-04-06', '2025-07-05', 'consolidated')).toEqual({
      periodDates: { periodStartDate: '2025-04-06', periodEndDate: '2025-07-05' },
      periodIncome: { turnover: 518.05, other: 0 },
      periodExpenses: { consolidatedExpenses: 20 },
    });
    expect(buildSelfAssessmentSummary(summary).totalAllowableExpensesPence).toBe(2000);
  });

  it('goes by category once turnover reaches the VAT registration threshold', () => {
    expect(mtdExpensesToSend('consolidated', 8_999_999)).toBe('consolidated');
    expect(mtdExpensesToSend('consolidated', 9_000_000)).toBe('itemised');
    expect(mtdExpensesToSend('itemised', 100)).toBe('itemised');
  });

  it('knows the first day a quarter can be sent', () => {
    expect(mtdEarliestSendDate({ endDate: '2026-07-05' })).toBe('2026-06-25');
    expect(mtdEarliestSendDate({ endDate: '2027-01-05' })).toBe('2026-12-26');
  });
});

describe('Self Assessment (SA103S) summary', () => {
  const box = (s: ReturnType<typeof buildSelfAssessmentSummary>, n: string) =>
    [...s.incomeBoxes, ...s.expenseBoxes].find((b) => b.box === n)!.amountPence;

  it('puts allowable amounts in the right boxes and works out profit', () => {
    const s = buildSelfAssessmentSummary(
      buildMtdPeriodSummary(
        [
          { hmrcCode: 'turnover', amountPence: 1_200_000 },
          { hmrcCode: 'other', amountPence: 20_000 },
        ],
        [
          { hmrcCode: 'costOfGoods', amountPence: 300_000, disallowable: false },
          { hmrcCode: 'adminCosts', amountPence: 6_000, disallowable: false },
          { hmrcCode: 'adminCosts', amountPence: 4_000, disallowable: true },
          { hmrcCode: 'financeCharges', amountPence: 1_500, disallowable: false },
          { hmrcCode: 'interestOnBankOtherLoans', amountPence: 2_500, disallowable: false },
          { hmrcCode: 'advertisingCosts', amountPence: 5_000, disallowable: false },
          { hmrcCode: 'businessEntertainmentCosts', amountPence: 9_000, disallowable: false },
          { hmrcCode: 'depreciation', amountPence: 7_000, disallowable: false },
        ],
      ),
    );
    expect(box(s, '9')).toBe(1_200_000);
    expect(box(s, '10')).toBe(20_000);
    expect(box(s, '11')).toBe(300_000);
    expect(box(s, '17')).toBe(4_000);
    expect(box(s, '18')).toBe(6_000);
    expect(box(s, '19')).toBe(5_000);
    expect(s.totalAllowableExpensesPence).toBe(315_000);
    expect(s.netProfitPence).toBe(905_000);
    expect(s.netLossPence).toBe(0);
    expect(s.disallowable).toEqual([{ hmrcCode: 'adminCosts', amountPence: 4_000 }]);
    expect(s.notAllowable.map((e) => [e.hmrcCode, e.amountPence])).toEqual([
      ['businessEntertainmentCosts', 9_000],
      ['depreciation', 7_000],
    ]);
    expect(s.tradingAllowance.better).toBe('expenses');
  });

  it('reports a loss and recommends the trading allowance when it is better', () => {
    const loss = buildSelfAssessmentSummary(
      buildMtdPeriodSummary([{ hmrcCode: 'turnover', amountPence: 50_000 }], [
        { hmrcCode: 'costOfGoods', amountPence: 80_000, disallowable: false },
      ]),
    );
    expect(loss.netLossPence).toBe(30_000);
    expect(loss.tradingAllowance).toMatchObject({ better: 'same', incomeWithinAllowance: true });

    const small = buildSelfAssessmentSummary(
      buildMtdPeriodSummary([{ hmrcCode: 'turnover', amountPence: 300_000 }], [
        { hmrcCode: 'costOfGoods', amountPence: 40_000, disallowable: false },
      ]),
    );
    expect(small.tradingAllowance).toMatchObject({
      profitWithExpensesPence: 260_000,
      profitWithAllowancePence: 200_000,
      better: 'allowance',
      incomeWithinAllowance: false,
    });
  });

  it('flags turnover too high for the short form', () => {
    const big = buildSelfAssessmentSummary(buildMtdPeriodSummary([{ hmrcCode: 'turnover', amountPence: 9_000_000 }], []));
    expect(big.turnoverOverShortFormLimit).toBe(true);
  });
});

describe('MTD period summary', () => {
  it('includes disallowable amounts in expenses and reports them separately', () => {
    const summary = buildMtdPeriodSummary(
      [
        { hmrcCode: 'turnover', amountPence: 50000 },
        { hmrcCode: 'turnover', amountPence: 1800 },
        { hmrcCode: 'other', amountPence: 200 },
      ],
      [
        { hmrcCode: 'costOfGoods', amountPence: 10000, disallowable: false },
        { hmrcCode: 'adminCosts', amountPence: 3000, disallowable: false },
        { hmrcCode: 'adminCosts', amountPence: 1000, disallowable: true },
      ],
    );
    expect(summary.periodIncome).toEqual({ turnover: 51800, other: 200 });
    expect(summary.periodExpenses).toEqual({ costOfGoods: 10000, adminCosts: 4000 });
    expect(summary.periodDisallowableExpenses).toEqual({ adminCostsDisallowable: 1000 });
    expect(summary.totals).toEqual({
      incomePence: 52000,
      expensesPence: 14000,
      disallowablePence: 1000,
      allowableExpensesPence: 13000,
      netProfitPence: 39000,
    });
  });
});

describe('mileage', () => {
  const trip = (id: number, date: string, vehicle: 'car' | 'motorcycle' | 'bicycle', miles: number) => ({
    id,
    date,
    vehicle,
    distanceTenths: miles * 10,
  });

  it('claims 45p a mile for the first 10,000 car and van miles in date order, then 25p', () => {
    const claims = mileageClaims([
      trip(3, '2025-09-01', 'car', 100),
      trip(1, '2025-05-01', 'car', 9_950),
      trip(2, '2025-06-01', 'car', 100),
    ]);
    expect(claims.get(1)).toBe(447_750); // 9,950 × 45p
    expect(claims.get(2)).toBe(50 * 45 + 50 * 25); // splits across the threshold
    expect(claims.get(3)).toBe(100 * 25);
  });

  it('uses the flat rates for motorcycles and bicycles, which do not count towards the car threshold', () => {
    const claims = mileageClaims([trip(1, '2025-05-01', 'motorcycle', 10), trip(2, '2025-05-01', 'bicycle', 10), trip(3, '2025-05-02', 'car', 10)]);
    expect([claims.get(1), claims.get(2), claims.get(3)]).toEqual([240, 200, 450]);
    expect(mileageClaims([{ id: 1, date: '2025-05-01', vehicle: 'car', distanceTenths: 235 }]).get(1)).toBe(1058); // 23.5 × 45p, rounded
  });

  it('reads distances to one decimal place', () => {
    expect(parseMilesToTenths('23.5')).toBe(235);
    expect(parseMilesToTenths('1,200')).toBe(12000);
    expect(parseMilesToTenths('2.25')).toBeNull();
    expect(parseMilesToTenths('0')).toBeNull();
    expect(tenthsToMiles(230)).toBe('23');
    expect(tenthsToMiles(235)).toBe('23.5');
  });
});

describe('tax estimate', () => {
  const pounds = (n: number) => Math.round(n * 100);

  it('works out Income Tax and Class 4 on a basic-rate profit', () => {
    const e = estimateTax({ label: '2025-26', profitPence: pounds(30_000), otherIncomePence: 0 });
    expect(e.incomeTaxPence).toBe(pounds(3_486)); // (30,000 − 12,570) × 20%
    expect(e.class4Pence).toBe(pounds(1_045.8)); // (30,000 − 12,570) × 6%
    expect(e.totalPence).toBe(pounds(4_531.8));
    expect(e.paymentOnAccountPence).toBe(pounds(2_265.9));
    expect(e.ratesAssumed).toBe(false);
  });

  it('uses the higher rates above the basic rate band', () => {
    const e = estimateTax({ label: '2026-27', profitPence: pounds(60_000), otherIncomePence: 0 });
    expect(e.incomeTaxPence).toBe(pounds(37_700 * 0.2 + 9_730 * 0.4));
    expect(e.class4MainPence).toBe(pounds(37_700 * 0.06));
    expect(e.class4UpperPence).toBe(pounds(9_730 * 0.02));
  });

  it('counts only the extra tax the business causes on top of other income', () => {
    const e = estimateTax({ label: '2025-26', profitPence: pounds(10_000), otherIncomePence: pounds(20_000) });
    expect(e.incomeTaxPence).toBe(pounds(2_000)); // all £10,000 at 20%: the salary used the allowance
    expect(e.class4Pence).toBe(0); // Class 4 is on profit alone, which is under the lower limit
    expect(e.paymentOnAccountPence).toBe(pounds(1_000)); // a £2,000 bill is over £1,000
  });

  it('tapers the personal allowance above £100,000', () => {
    const e = estimateTax({ label: '2025-26', profitPence: pounds(110_000), otherIncomePence: 0 });
    expect(e.personalAllowancePence).toBe(pounds(7_570));
    expect(e.incomeTaxPence).toBe(pounds(37_700 * 0.2 + (102_430 - 37_700) * 0.4));
  });

  it('owes nothing on a loss or a small profit, and needs no payments on account under £1,000', () => {
    expect(estimateTax({ label: '2025-26', profitPence: -pounds(500), otherIncomePence: 0 }).totalPence).toBe(0);
    const small = estimateTax({ label: '2025-26', profitPence: pounds(15_000), otherIncomePence: 0 });
    expect(small.totalPence).toBe(pounds(2_430 * 0.26));
    expect(small.paymentOnAccountPence).toBeNull();
  });

  it('assumes the latest known rates for a later year', () => {
    expect(taxRatesFor('2030-31')).toMatchObject({ ratesLabel: '2026-27', assumed: true });
    expect(taxPaymentDates(2026)).toEqual({ balancing: '2028-01-31', secondPaymentOnAccount: '2028-07-31' });
  });
});

describe('use of home', () => {
  it('pays the flat rate for the band the month’s hours fall in', () => {
    expect([0, 24, 25, 50, 51, 100, 101, 744].map(useOfHomeClaim)).toEqual([0, 0, 1000, 1000, 1800, 1800, 2600, 2600]);
  });

  it('says how many more hours reach the next band', () => {
    expect(useOfHomeNextBand(15)).toEqual({ hoursToGo: 10, pence: 1000 });
    expect(useOfHomeNextBand(43)).toEqual({ hoursToGo: 8, pence: 1800 });
    expect(useOfHomeNextBand(100)).toEqual({ hoursToGo: 1, pence: 2600 });
    expect(useOfHomeNextBand(101)).toBeNull();
  });

  it('gives each tax month its dates, from the 6th to the 5th', () => {
    const months = taxMonths(2025);
    expect(months[0]).toMatchObject({ startDate: '2025-04-06', endDate: '2025-05-05' });
    expect(months[8]).toMatchObject({ startDate: '2025-12-06', endDate: '2026-01-05' });
    expect(months[11]).toMatchObject({ startDate: '2026-03-06', endDate: '2026-04-05' });
  });
});

describe('photo filenames', () => {
  const at = new Date(2026, 9, 30, 14, 5, 9);

  it('names a photo by when it was taken, in local time, with a random part', () => {
    expect(photoFilename({ type: 'image/jpeg', name: 'image.jpg' }, at)).toMatch(/^Photo 2026-10-30 14-05-09 [0-9a-f]{4}\.jpg$/);
  });

  it('takes the extension from the type, then the old name, then assumes JPEG', () => {
    expect(photoFilename({ type: 'image/heic', name: 'image.jpg' }, at)).toMatch(/\.heic$/);
    expect(photoFilename({ type: '', name: 'IMG_0001.HEIC' }, at)).toMatch(/\.heic$/);
    expect(photoFilename({ type: '' }, at)).toMatch(/\.jpg$/);
  });
});

describe('category short names', () => {
  it('shortens standard categories and leaves custom ones alone', () => {
    expect(shortCategoryName('Turnover – takings, fees, sales or money earned')).toBe('Turnover');
    expect(shortCategoryName('Stall fees')).toBe('Stall fees');
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildMtdPeriodSummary,
  expenseInputSchema,
  formatGBP,
  isDateInTaxYear,
  isValidIsoDate,
  mtdPayload,
  mtdQuarters,
  mtdQuarterStatus,
  parsePoundsToPence,
  penceToPounds,
  selfAssessmentDeadline,
  startYearFromLabel,
  taxMonthIndex,
  taxMonths,
  taxYearFromStartYear,
  taxYearStartYearForDate,
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
    expect(mtdPayload(summary, '2025-04-06', '2025-07-05')).toEqual({
      periodDates: { periodStartDate: '2025-04-06', periodEndDate: '2025-07-05' },
      periodIncome: { turnover: 518.05 },
      periodExpenses: { adminCosts: 10.01 },
      periodDisallowableExpenses: { adminCostsDisallowable: 10.01 },
    });
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

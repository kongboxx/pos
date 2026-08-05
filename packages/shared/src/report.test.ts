import { describe, expect, it } from 'vitest';
import {
  breakEvenSalesSatang,
  contributionMarginBp,
  coverageIsPoor,
  daysInMonth,
  expenseCategoryLabel,
  expenseKindOf,
  expenseRequestSchema,
  isFixedExpense,
  monthRange,
  percentBp,
  voidReportQuerySchema,
  yearMonthOf,
  EXPENSE_CATEGORIES,
  ExpenseCategory,
} from './report.js';

describe('expense categories', () => {
  it('has exactly one variable category — วัตถุดิบ', () => {
    // The break-even split depends on this: everything else is treated as a
    // cost that has to be paid whether or not a bowl is sold.
    const variable = EXPENSE_CATEGORIES.filter((c) => c.kind === 'VARIABLE');
    expect(variable.map((c) => c.key)).toEqual([ExpenseCategory.INGREDIENT]);
  });

  it('renders an unknown stored value as itself rather than as blank', () => {
    expect(expenseCategoryLabel('INGREDIENT')).toBe('วัตถุดิบ');
    expect(expenseCategoryLabel('ค่าน้ำมันเครื่อง')).toBe('ค่าน้ำมันเครื่อง');
  });

  it('treats an unknown category as FIXED', () => {
    // Wrong in the safe direction: it can only push the break-even target up.
    expect(expenseKindOf('SOMETHING_NEW')).toBe('FIXED');
    expect(isFixedExpense('SOMETHING_NEW')).toBe(true);
    expect(isFixedExpense(ExpenseCategory.INGREDIENT)).toBe(false);
  });
});

describe('percentBp', () => {
  it('returns basis points', () => {
    expect(percentBp(3500, 10_000)).toBe(3500); // 35.00%
  });

  it('returns null on a zero denominator instead of 0', () => {
    // "ยังไม่มียอดขาย" is not the same answer as "ต้นทุน 0%".
    expect(percentBp(0, 0)).toBeNull();
  });
});

describe('contributionMarginBp', () => {
  it('is what is left of a baht of sales after the food in the bowl', () => {
    expect(contributionMarginBp(10_000, 3_000)).toBe(7000); // 70%
  });

  it('goes negative when a dish is priced below its ingredients', () => {
    // Clamping this to zero would hide the single most important thing a
    // report can say.
    expect(contributionMarginBp(10_000, 12_000)).toBe(-2000);
  });

  it('is null with no sales', () => {
    expect(contributionMarginBp(0, 0)).toBeNull();
  });
});

describe('breakEvenSalesSatang', () => {
  it('divides fixed cost by the margin', () => {
    // 20,000 baht of fixed cost at a 70% margin = 28,571.43 baht of sales.
    expect(breakEvenSalesSatang(2_000_000, 7000)).toBe(2_857_143);
  });

  it('rounds up, because it is a target to clear', () => {
    // 3.0000...4 baht would round down to a target that is met while still
    // losing a satang.
    expect(breakEvenSalesSatang(1, 3333)).toBe(4);
  });

  it('is null when every bowl loses money', () => {
    // No amount of selling breaks even, and the screen has to say so rather
    // than print an enormous number.
    expect(breakEvenSalesSatang(2_000_000, -500)).toBeNull();
    expect(breakEvenSalesSatang(2_000_000, 0)).toBeNull();
    expect(breakEvenSalesSatang(2_000_000, null)).toBeNull();
  });

  it('is zero when there is nothing fixed to cover', () => {
    expect(breakEvenSalesSatang(0, 7000)).toBe(0);
  });
});

describe('month arithmetic', () => {
  it('gives a half-open range', () => {
    expect(monthRange('2026-07')).toEqual({ start: '2026-07-01', endExclusive: '2026-08-01' });
  });

  it('rolls over the year in December', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01' });
  });

  it('counts days, including a leap February', () => {
    expect(daysInMonth('2026-07')).toBe(31);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
  });

  it('rejects a month that is not a month', () => {
    expect(() => monthRange('2026-13')).toThrow(TypeError);
    expect(() => daysInMonth('2026-7')).toThrow(TypeError);
  });

  it('reads the month off a business date', () => {
    expect(yearMonthOf('2026-07-30')).toBe('2026-07');
  });
});

describe('expenseRequestSchema', () => {
  it('accepts a typed-in expense and defaults to cash', () => {
    const parsed = expenseRequestSchema.parse({
      date: '2026-07-30',
      category: 'INGREDIENT',
      amountSatang: 80_000,
    });
    expect(parsed.paidBy).toBe('CASH');
    expect(parsed.note).toBeUndefined();
  });

  it('refuses zero and negative amounts', () => {
    // A negative row would silently cancel out a real one inside every
    // grouped total, and nobody would notice for a month.
    const base = { date: '2026-07-30', category: 'OTHER' };
    expect(expenseRequestSchema.safeParse({ ...base, amountSatang: 0 }).success).toBe(false);
    expect(expenseRequestSchema.safeParse({ ...base, amountSatang: -500 }).success).toBe(false);
  });

  it('refuses a fractional amount (rule #2)', () => {
    expect(
      expenseRequestSchema.safeParse({
        date: '2026-07-30',
        category: 'OTHER',
        amountSatang: 12.5,
      }).success,
    ).toBe(false);
  });

  it('refuses a category that is not on the list', () => {
    expect(
      expenseRequestSchema.safeParse({
        date: '2026-07-30',
        category: 'ค่าเช่า',
        amountSatang: 100,
      }).success,
    ).toBe(false);
  });
});

describe('voidReportQuerySchema', () => {
  it('refuses a backwards range', () => {
    expect(voidReportQuerySchema.safeParse({ from: '2026-07-30', to: '2026-07-01' }).success).toBe(
      false,
    );
    expect(voidReportQuerySchema.safeParse({ from: '2026-07-01', to: '2026-07-01' }).success).toBe(
      true,
    );
  });
});

describe('coverageIsPoor', () => {
  it('flags any sold line with no recipe behind it', () => {
    // unitCostSatang = 0 does not read as "unknown" on a report, it reads as
    // "free" — so the caveat has to travel with the number.
    expect(coverageIsPoor({ soldLineCount: 100, linesWithoutRecipeCount: 0 })).toBe(false);
    expect(coverageIsPoor({ soldLineCount: 100, linesWithoutRecipeCount: 1 })).toBe(true);
  });
});

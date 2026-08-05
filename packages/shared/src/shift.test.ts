import { describe, expect, it } from 'vitest';
import {
  cashVarianceSatang,
  closeShiftRequestSchema,
  describeVariance,
  expectedCashSatang,
  isVarianceWorthAsking,
  MAX_DRAWER_SATANG,
  openShiftRequestSchema,
} from './shift.js';

describe('expectedCashSatang', () => {
  it('adds the float to the cash taken', () => {
    expect(
      expectedCashSatang({
        openingCashSatang: 100_000,
        cashSalesSatang: 350_000,
        cashOutSatang: 0,
      }),
    ).toBe(450_000);
  });

  it('subtracts money taken out of the drawer during the shift', () => {
    // ฿500 to the market at lunchtime is not a missing ฿500 at closing.
    expect(
      expectedCashSatang({
        openingCashSatang: 100_000,
        cashSalesSatang: 350_000,
        cashOutSatang: 50_000,
      }),
    ).toBe(400_000);
  });

  it('can go negative when more went out than came in', () => {
    // Unusual but real: a quiet morning and a big cash purchase. The number is
    // still the truth, and clamping it at zero would hide the mistake.
    expect(
      expectedCashSatang({ openingCashSatang: 0, cashSalesSatang: 10_000, cashOutSatang: 50_000 }),
    ).toBe(-40_000);
  });

  it('refuses a float sneaking into any of the three', () => {
    expect(() =>
      expectedCashSatang({ openingCashSatang: 0.5, cashSalesSatang: 0, cashOutSatang: 0 }),
    ).toThrow(TypeError);
  });
});

describe('cashVarianceSatang', () => {
  it('is negative when money is missing', () => {
    expect(cashVarianceSatang(395_000, 400_000)).toBe(-5000);
  });

  it('is positive when there is more than there should be', () => {
    expect(cashVarianceSatang(402_000, 400_000)).toBe(2000);
  });

  it('is zero on a perfect count', () => {
    expect(cashVarianceSatang(400_000, 400_000)).toBe(0);
  });
});

describe('describeVariance', () => {
  it('says short, over, or exact — in that order of what a person cares about', () => {
    expect(describeVariance(-5000)).toBe('เงินขาด 50.00 บาท');
    expect(describeVariance(2000)).toBe('เงินเกิน 20.00 บาท');
    expect(describeVariance(0)).toBe('ตรงพอดี');
  });
});

describe('isVarianceWorthAsking', () => {
  it('ignores the loose change a real till drifts by', () => {
    expect(isVarianceWorthAsking(500)).toBe(false);
    expect(isVarianceWorthAsking(-2000)).toBe(false);
  });

  it('flags a note-sized gap in either direction', () => {
    // Cash appearing from nowhere is as odd as cash going missing.
    expect(isVarianceWorthAsking(-2001)).toBe(true);
    expect(isVarianceWorthAsking(10_000)).toBe(true);
  });
});

describe('opening the till', () => {
  it('accepts an empty drawer — some shops start at zero', () => {
    expect(openShiftRequestSchema.parse({ openingCashSatang: 0 })).toMatchObject({
      openingCashSatang: 0,
    });
  });

  it('refuses a negative float', () => {
    expect(openShiftRequestSchema.safeParse({ openingCashSatang: -100 }).success).toBe(false);
  });

  it('refuses a fat-fingered extra digit rather than recording it', () => {
    expect(
      openShiftRequestSchema.safeParse({ openingCashSatang: MAX_DRAWER_SATANG + 1 }).success,
    ).toBe(false);
  });

  it('refuses satang that are not whole', () => {
    expect(openShiftRequestSchema.safeParse({ openingCashSatang: 100.5 }).success).toBe(false);
  });
});

describe('closing the till', () => {
  it('sends the counted figure and nothing else about the money', () => {
    const parsed = closeShiftRequestSchema.parse({
      countedCashSatang: 400_000,
      note: 'ลูกค้าจ่ายแบงก์พัน',
    });
    expect(parsed).toMatchObject({ countedCashSatang: 400_000 });
    // A client that could name its own expected total could close every shift
    // dead level; the server works that out from the bills.
    expect('expectedCashSatang' in parsed).toBe(false);
    expect('varianceSatang' in parsed).toBe(false);
  });

  it('needs the count — closing without one is not a close', () => {
    expect(closeShiftRequestSchema.safeParse({}).success).toBe(false);
  });
});

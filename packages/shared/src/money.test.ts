import { describe, expect, it } from 'vitest';
import {
  assertSatang,
  bahtToSatang,
  calculateChange,
  formatSatang,
  multiplySatang,
  parseBahtToSatang,
  roundHalfUp,
  satangToBaht,
  sumSatang,
} from './money.js';

describe('roundHalfUp', () => {
  it('rounds .5 away from zero in both directions', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
    expect(roundHalfUp(-2.4)).toBe(-2);
  });

  it('differs from Math.round on negatives, which is the whole point', () => {
    expect(Math.round(-2.5)).toBe(-2);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });
});

describe('bahtToSatang', () => {
  it('converts whole and fractional baht', () => {
    expect(bahtToSatang(60)).toBe(6000);
    expect(bahtToSatang(60.5)).toBe(6050);
    expect(bahtToSatang(0)).toBe(0);
  });

  it('survives binary floating point representation', () => {
    // 0.1 + 0.2 === 0.30000000000000004 — must still land on 30 satang.
    expect(bahtToSatang(0.1 + 0.2)).toBe(30);
    expect(bahtToSatang(1.005)).toBe(100);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => bahtToSatang(Number.NaN)).toThrow(RangeError);
    expect(() => bahtToSatang(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('parseBahtToSatang', () => {
  it('parses what a cashier actually types', () => {
    expect(parseBahtToSatang('60')).toBe(6000);
    expect(parseBahtToSatang('60.50')).toBe(6050);
    expect(parseBahtToSatang(' 1,234.50 ')).toBe(123450);
    expect(parseBahtToSatang('60.-')).toBe(6000);
    expect(parseBahtToSatang('฿60')).toBe(6000);
  });

  it('returns null for garbage instead of silently producing 0', () => {
    expect(parseBahtToSatang('')).toBeNull();
    expect(parseBahtToSatang('abc')).toBeNull();
    expect(parseBahtToSatang('6 0')).toBeNull();
    expect(parseBahtToSatang('60.5.5')).toBeNull();
  });
});

describe('formatSatang / satangToBaht', () => {
  it('always shows two decimals', () => {
    expect(formatSatang(6000)).toBe('60.00');
    expect(formatSatang(6050)).toBe('60.50');
    expect(formatSatang(0)).toBe('0.00');
    expect(formatSatang(123450)).toBe('1,234.50');
  });

  it('can prefix the baht symbol', () => {
    expect(formatSatang(6000, { withSymbol: true })).toBe('฿60.00');
  });

  it('round-trips through baht', () => {
    expect(satangToBaht(6050)).toBe(60.5);
  });
});

describe('assertSatang', () => {
  it('rejects a float that leaked into a money field', () => {
    expect(() => assertSatang(60.5)).toThrow(TypeError);
    expect(() => assertSatang(0.1 + 0.2)).toThrow(TypeError);
  });

  it('accepts integers including zero and negatives', () => {
    expect(() => assertSatang(0)).not.toThrow();
    expect(() => assertSatang(-500)).not.toThrow();
  });

  it('rejects values past the safe integer range', () => {
    expect(() => assertSatang(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe('sumSatang / multiplySatang', () => {
  it('sums exactly, where floats would drift', () => {
    const prices = Array.from({ length: 10 }, () => 10); // 0.10 THB x 10
    expect(sumSatang(prices)).toBe(100);
  });

  it('multiplies by whole quantities', () => {
    expect(multiplySatang(6000, 3)).toBe(18000);
    expect(multiplySatang(6000, 0)).toBe(0);
  });

  it('refuses fractional or negative quantities', () => {
    expect(() => multiplySatang(6000, 0.5)).toThrow(RangeError);
    expect(() => multiplySatang(6000, -1)).toThrow(RangeError);
  });
});

describe('calculateChange', () => {
  it('computes change for the classic case', () => {
    expect(calculateChange(6000, 10000)).toBe(4000);
    expect(calculateChange(6000, 6000)).toBe(0);
  });

  it('returns null when the customer paid too little', () => {
    expect(calculateChange(6000, 5000)).toBeNull();
  });
});

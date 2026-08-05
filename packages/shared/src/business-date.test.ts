import { describe, expect, it } from 'vitest';
import { businessDateRange, toBusinessDate, toYearMonth } from './business-date.js';

const BKK = { timezone: 'Asia/Bangkok', dayCutoffHour: 4 };

describe('toBusinessDate — the after-midnight case', () => {
  it('counts a 00:20 bill as the previous day', () => {
    // 2026-07-29T17:20:00Z === 2026-07-30 00:20 in Bangkok (UTC+7)
    const instant = new Date('2026-07-29T17:20:00Z');
    expect(toBusinessDate(instant, BKK)).toBe('2026-07-29');
  });

  it('counts a 03:59 bill as the previous day', () => {
    // local 2026-07-30 03:59
    expect(toBusinessDate(new Date('2026-07-29T20:59:00Z'), BKK)).toBe('2026-07-29');
  });

  it('flips to the new day exactly at the cutoff', () => {
    // local 2026-07-30 04:00
    expect(toBusinessDate(new Date('2026-07-29T21:00:00Z'), BKK)).toBe('2026-07-30');
  });

  it('handles a normal lunchtime bill', () => {
    // local 2026-07-30 12:00
    expect(toBusinessDate(new Date('2026-07-30T05:00:00Z'), BKK)).toBe('2026-07-30');
  });
});

describe('toBusinessDate — boundaries', () => {
  it('rolls back across a month boundary', () => {
    // local 2026-08-01 01:00 -> business date 2026-07-31
    expect(toBusinessDate(new Date('2026-07-31T18:00:00Z'), BKK)).toBe('2026-07-31');
  });

  it('rolls back across a year boundary', () => {
    // local 2027-01-01 02:00 -> business date 2026-12-31
    expect(toBusinessDate(new Date('2026-12-31T19:00:00Z'), BKK)).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    // local 2028-03-01 01:00 -> business date 2028-02-29
    expect(toBusinessDate(new Date('2028-02-29T18:00:00Z'), BKK)).toBe('2028-02-29');
  });
});

describe('toBusinessDate — configuration', () => {
  it('respects a per-branch cutoff hour', () => {
    const instant = new Date('2026-07-29T18:30:00Z'); // local 2026-07-30 01:30
    expect(toBusinessDate(instant, { ...BKK, dayCutoffHour: 0 })).toBe('2026-07-30');
    expect(toBusinessDate(instant, { ...BKK, dayCutoffHour: 2 })).toBe('2026-07-29');
    expect(toBusinessDate(instant, { ...BKK, dayCutoffHour: 6 })).toBe('2026-07-29');
  });

  it('does not depend on the server timezone', () => {
    // Same instant, read through a different branch timezone.
    const instant = new Date('2026-07-29T17:20:00Z');
    expect(toBusinessDate(instant, { timezone: 'UTC', dayCutoffHour: 4 })).toBe('2026-07-29');
    expect(toBusinessDate(instant, { timezone: 'Asia/Bangkok', dayCutoffHour: 4 })).toBe(
      '2026-07-29',
    );
  });

  it('rejects an invalid cutoff hour', () => {
    expect(() => toBusinessDate(new Date(), { dayCutoffHour: 24 })).toThrow(RangeError);
    expect(() => toBusinessDate(new Date(), { dayCutoffHour: -1 })).toThrow(RangeError);
  });
});

describe('businessDateRange', () => {
  it('spans exactly 24 hours from cutoff to cutoff', () => {
    const { startUtc, endUtc } = businessDateRange('2026-07-29', BKK);
    expect(startUtc.toISOString()).toBe('2026-07-28T21:00:00.000Z'); // 2026-07-29 04:00 BKK
    expect(endUtc.toISOString()).toBe('2026-07-29T21:00:00.000Z'); // 2026-07-30 04:00 BKK
    expect(endUtc.getTime() - startUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('agrees with toBusinessDate at both ends', () => {
    const date = '2026-07-29';
    const { startUtc, endUtc } = businessDateRange(date, BKK);
    expect(toBusinessDate(startUtc, BKK)).toBe(date);
    expect(toBusinessDate(new Date(endUtc.getTime() - 1), BKK)).toBe(date);
    expect(toBusinessDate(endUtc, BKK)).toBe('2026-07-30');
  });

  it('rejects a malformed date', () => {
    expect(() => businessDateRange('29-07-2026', BKK)).toThrow(TypeError);
  });
});

describe('toYearMonth', () => {
  it('buckets a business date into YYYY-MM', () => {
    expect(toYearMonth('2026-07-29')).toBe('2026-07');
  });
});

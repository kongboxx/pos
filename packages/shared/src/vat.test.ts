import { describe, expect, it } from 'vitest';
import {
  addVatToExclusive,
  calculateVat,
  extractVatFromInclusive,
  formatRateBp,
  VAT_RATE_BP_7,
  type VatConfig,
} from './vat.js';

const VAT_OFF: VatConfig = { enabled: false, rateBp: 0, priceIncludesVat: true };
const VAT_INCLUSIVE: VatConfig = { enabled: true, rateBp: VAT_RATE_BP_7, priceIncludesVat: true };
const VAT_EXCLUSIVE: VatConfig = { enabled: true, rateBp: VAT_RATE_BP_7, priceIncludesVat: false };

describe('extractVatFromInclusive', () => {
  it('carves 7% out of a gross amount', () => {
    // 107.00 gross -> 7.00 VAT, 100.00 net
    expect(extractVatFromInclusive(10700, VAT_RATE_BP_7)).toBe(700);
    // 60.00 gross -> 3.93 VAT (600000/10700 = 392.52 -> 393)
    expect(extractVatFromInclusive(6000, VAT_RATE_BP_7)).toBe(393);
  });

  it('is zero at a zero rate', () => {
    expect(extractVatFromInclusive(6000, 0)).toBe(0);
  });
});

describe('addVatToExclusive', () => {
  it('adds 7% on top of a net amount', () => {
    expect(addVatToExclusive(10000, VAT_RATE_BP_7)).toBe(700);
    expect(addVatToExclusive(6000, VAT_RATE_BP_7)).toBe(420);
  });
});

describe('calculateVat — VAT not registered yet (today)', () => {
  it('passes the amount straight through with zero VAT', () => {
    const result = calculateVat(6000, VAT_OFF);
    expect(result).toMatchObject({
      subtotalExVatSatang: 6000,
      vatAmountSatang: 0,
      totalSatang: 6000,
      vatRateBpSnapshot: 0,
    });
  });

  it('never changes what the customer pays', () => {
    for (const gross of [1, 999, 6000, 123456]) {
      expect(calculateVat(gross, VAT_OFF).totalSatang).toBe(gross);
    }
  });
});

describe('calculateVat — VAT inclusive (prices already contain VAT)', () => {
  it('splits gross into net + VAT without changing the total', () => {
    const result = calculateVat(10700, VAT_INCLUSIVE);
    expect(result.totalSatang).toBe(10700);
    expect(result.vatAmountSatang).toBe(700);
    expect(result.subtotalExVatSatang).toBe(10000);
    expect(result.isVatInclusive).toBe(true);
    expect(result.vatRateBpSnapshot).toBe(700);
  });

  it('keeps net + vat === total for every amount (the invariant that must never break)', () => {
    for (let gross = 0; gross <= 20000; gross += 7) {
      const r = calculateVat(gross, VAT_INCLUSIVE);
      expect(r.subtotalExVatSatang + r.vatAmountSatang).toBe(r.totalSatang);
    }
  });
});

describe('calculateVat — VAT exclusive (VAT added on top)', () => {
  it('adds VAT to the net', () => {
    const result = calculateVat(10000, VAT_EXCLUSIVE);
    expect(result.subtotalExVatSatang).toBe(10000);
    expect(result.vatAmountSatang).toBe(700);
    expect(result.totalSatang).toBe(10700);
    expect(result.isVatInclusive).toBe(false);
  });

  it('keeps net + vat === total for every amount', () => {
    for (let net = 0; net <= 20000; net += 13) {
      const r = calculateVat(net, VAT_EXCLUSIVE);
      expect(r.subtotalExVatSatang + r.vatAmountSatang).toBe(r.totalSatang);
    }
  });
});

describe('calculateVat — guards', () => {
  it('rejects a float amount', () => {
    expect(() => calculateVat(60.5, VAT_INCLUSIVE)).toThrow(TypeError);
  });

  it('rejects an impossible rate', () => {
    expect(() =>
      calculateVat(6000, { enabled: true, rateBp: 7, priceIncludesVat: true }),
    ).not.toThrow();
    expect(() => calculateVat(6000, { enabled: true, rateBp: -1, priceIncludesVat: true })).toThrow(
      RangeError,
    );
    expect(() =>
      calculateVat(6000, { enabled: true, rateBp: 10_001, priceIncludesVat: true }),
    ).toThrow(RangeError);
    expect(() =>
      calculateVat(6000, { enabled: true, rateBp: 7.5, priceIncludesVat: true }),
    ).toThrow(RangeError);
  });
});

describe('formatRateBp', () => {
  it('prints whole and fractional percentages', () => {
    expect(formatRateBp(700)).toBe('7%');
    expect(formatRateBp(725)).toBe('7.25%');
    expect(formatRateBp(0)).toBe('0%');
  });
});

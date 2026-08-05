import { describe, expect, it } from 'vitest';
import {
  calculateLineTotal,
  calculateOrderTotal,
  clampDiscount,
  foodCostPercentBp,
  type OrderLineSnapshot,
} from './order-total.js';
import { VAT_RATE_BP_7, type VatConfig } from './vat.js';

const VAT_OFF: VatConfig = { enabled: false, rateBp: 0, priceIncludesVat: true };
const VAT_INCLUSIVE: VatConfig = { enabled: true, rateBp: VAT_RATE_BP_7, priceIncludesVat: true };

/** ก๋วยเตี๋ยวหมูน้ำตก 60.00 ต้นทุน 22.00 */
const noodle = (over: Partial<OrderLineSnapshot> = {}): OrderLineSnapshot => ({
  nameSnapshot: 'ก๋วยเตี๋ยวหมูน้ำตก',
  qty: 1,
  unitPriceSatang: 6000,
  unitCostSatang: 2200,
  ...over,
});

describe('calculateLineTotal', () => {
  it('totals a plain line', () => {
    expect(calculateLineTotal(noodle({ qty: 3 }))).toEqual({
      effectiveUnitPriceSatang: 6000,
      effectiveUnitCostSatang: 2200,
      lineTotalSatang: 18000,
      lineCostSatang: 6600,
    });
  });

  it('applies positive modifier deltas (พิเศษ +10)', () => {
    const result = calculateLineTotal(
      noodle({
        qty: 2,
        modifiers: [{ nameSnapshot: 'พิเศษ', priceDeltaSatang: 1000, costDeltaSatang: 400 }],
      }),
    );
    expect(result.effectiveUnitPriceSatang).toBe(7000);
    expect(result.lineTotalSatang).toBe(14000);
    expect(result.lineCostSatang).toBe(5200);
  });

  it('applies negative modifier deltas (ไม่ใส่เส้น -5)', () => {
    const result = calculateLineTotal(
      noodle({
        modifiers: [{ nameSnapshot: 'ไม่ใส่เส้น', priceDeltaSatang: -500, costDeltaSatang: -300 }],
      }),
    );
    expect(result.effectiveUnitPriceSatang).toBe(5500);
    expect(result.effectiveUnitCostSatang).toBe(1900);
  });

  it('refuses to produce a negative price', () => {
    expect(() =>
      calculateLineTotal(
        noodle({
          modifiers: [
            { nameSnapshot: 'ส่วนลดเกินจริง', priceDeltaSatang: -9000, costDeltaSatang: 0 },
          ],
        }),
      ),
    ).toThrow(RangeError);
  });
});

describe('calculateOrderTotal', () => {
  it('totals a multi-line bill with VAT off', () => {
    const result = calculateOrderTotal([noodle({ qty: 2 }), noodle({ qty: 1 })], VAT_OFF);
    expect(result.grossSatang).toBe(18000);
    expect(result.costSatang).toBe(6600);
    expect(result.totalSatang).toBe(18000);
    expect(result.vatAmountSatang).toBe(0);
    expect(result.lineCount).toBe(2);
  });

  it('excludes voided lines from sales AND from cost', () => {
    const result = calculateOrderTotal(
      [noodle({ qty: 2 }), noodle({ qty: 5, voidedAt: new Date() })],
      VAT_OFF,
    );
    expect(result.grossSatang).toBe(12000);
    expect(result.costSatang).toBe(4400);
    expect(result.lineCount).toBe(1);
  });

  it('applies VAT once on the order total, not per line', () => {
    // Three lines of 60.00 = 180.00 gross.
    // Per-line VAT would be 3 x 393 = 1179; on the total it is 11775 -> 1178.
    const lines = [noodle(), noodle(), noodle()];
    const result = calculateOrderTotal(lines, VAT_INCLUSIVE);
    expect(result.grossSatang).toBe(18000);
    expect(result.vatAmountSatang).toBe(1178);
    expect(result.subtotalExVatSatang + result.vatAmountSatang).toBe(result.totalSatang);
  });

  it('totals an empty bill to zero without throwing', () => {
    const result = calculateOrderTotal([], VAT_INCLUSIVE);
    expect(result.grossSatang).toBe(0);
    expect(result.totalSatang).toBe(0);
    expect(result.vatAmountSatang).toBe(0);
  });

  it('reports no discount when none was given', () => {
    expect(calculateOrderTotal([noodle()], VAT_OFF).discountSatang).toBe(0);
  });
});

describe('a discount on the bill', () => {
  it('comes off the total but leaves the gross alone', () => {
    const result = calculateOrderTotal([noodle({ qty: 2 })], VAT_OFF, 2000);
    expect(result.grossSatang).toBe(12000);
    expect(result.discountSatang).toBe(2000);
    expect(result.totalSatang).toBe(10000);
  });

  it('does not reduce the food cost — the bowl was still cooked', () => {
    const undiscounted = calculateOrderTotal([noodle({ qty: 2 })], VAT_OFF);
    const discounted = calculateOrderTotal([noodle({ qty: 2 })], VAT_OFF, 2000);
    expect(discounted.costSatang).toBe(undiscounted.costSatang);
  });

  it('is taken off BEFORE VAT, so the shop is not taxed on money it never took', () => {
    // 180.00 gross − 20.00 = 160.00 received. VAT is 7% carved out of 160.00.
    const lines = [noodle(), noodle(), noodle()];
    const result = calculateOrderTotal(lines, VAT_INCLUSIVE, 2000);

    expect(result.totalSatang).toBe(16000);
    expect(result.vatAmountSatang).toBe(1047);
    expect(result.subtotalExVatSatang + result.vatAmountSatang).toBe(result.totalSatang);

    // Taking it off after VAT would have left the 180.00 VAT figure behind.
    expect(result.vatAmountSatang).not.toBe(
      calculateOrderTotal(lines, VAT_INCLUSIVE).vatAmountSatang,
    );
  });

  it('never makes the customer owe less than nothing', () => {
    // Signed off ฿20 on two bowls, then both came back as voids.
    const result = calculateOrderTotal([noodle({ voidedAt: new Date() })], VAT_OFF, 2000);
    expect(result.grossSatang).toBe(0);
    expect(result.discountSatang).toBe(0);
    expect(result.totalSatang).toBe(0);
  });

  it('is clamped to what is left on the bill, not to what was agreed', () => {
    const result = calculateOrderTotal([noodle()], VAT_OFF, 9900);
    expect(result.discountSatang).toBe(6000);
    expect(result.totalSatang).toBe(0);
  });

  it('refuses a negative discount rather than quietly adding money', () => {
    expect(() => calculateOrderTotal([noodle()], VAT_OFF, -100)).toThrow(RangeError);
  });
});

describe('clampDiscount', () => {
  it('leaves a discount the bill can afford alone', () => {
    expect(clampDiscount(2000, 12000)).toBe(2000);
  });

  it('cuts one it cannot down to the whole bill', () => {
    expect(clampDiscount(20000, 12000)).toBe(12000);
  });

  it('rejects a negative discount', () => {
    expect(() => clampDiscount(-1, 12000)).toThrow(RangeError);
  });
});

describe('foodCostPercentBp', () => {
  it('returns basis points, not a float', () => {
    expect(foodCostPercentBp(10000, 3500)).toBe(3500); // 35.00%
    expect(foodCostPercentBp(6000, 2200)).toBe(3667); // 36.67%
  });

  it('returns null instead of NaN when there are no sales', () => {
    expect(foodCostPercentBp(0, 0)).toBeNull();
  });
});

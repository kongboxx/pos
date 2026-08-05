/**
 * The cost of a bowl.
 *
 * Everything downstream — margin on screen, profit in Step 8's P&L, whether an
 * item is worth keeping on the menu — is this function. So what is tested here
 * is not "does it add up" but the two ways it could quietly be wrong: rounding
 * in the wrong place, and a swap that should subtract.
 */

import { describe, expect, it } from 'vitest';
import {
  foodCostBp,
  formatPercentBp,
  formatQuantity,
  grossMarginBp,
  grossProfitSatang,
  isStorableQuantity,
  MAX_RECIPE_QTY,
  recipeCostSatang,
  recipeLineCostSatang,
  scaleQuantity,
} from './recipe.js';

/** ก๋วยเตี๋ยวหมู as seeded: 120g เส้น @3, 50g หมู @20, 300ml ซุป @2, ผัก, ถั่วงอก. */
const PORK_NOODLE = [
  { quantity: 120, unitCostSatang: 3 },
  { quantity: 50, unitCostSatang: 20 },
  { quantity: 300, unitCostSatang: 2 },
  { quantity: 30, unitCostSatang: 4 },
  { quantity: 20, unitCostSatang: 3 },
];

describe('recipeCostSatang', () => {
  it('adds a real bowl up', () => {
    // 360 + 1000 + 600 + 120 + 60
    expect(recipeCostSatang(PORK_NOODLE)).toBe(2140);
  });

  it('is 0 for a dish with no recipe yet', () => {
    expect(recipeCostSatang([])).toBe(0);
  });

  it('rounds once at the end, not once per line', () => {
    // Three half-satang lines. Rounding each first gives 3; the truthful
    // answer is 1.5 -> 2. On a five-ingredient bowl that error is a 2% lie
    // about the margin, which is the number the owner prices from.
    const halves = [
      { quantity: 0.5, unitCostSatang: 1 },
      { quantity: 0.5, unitCostSatang: 1 },
      { quantity: 0.5, unitCostSatang: 1 },
    ];
    expect(recipeCostSatang(halves)).toBe(2);
    expect(halves.map(recipeLineCostSatang).reduce((a, b) => a + b)).toBe(3);
  });

  it('handles a four-decimal quantity without drifting', () => {
    // 0.0001 ขวด of something worth 500 satang a bottle.
    expect(recipeCostSatang([{ quantity: 0.0001, unitCostSatang: 500 }])).toBe(0);
    expect(recipeCostSatang([{ quantity: 0.1, unitCostSatang: 500 }])).toBe(50);
  });

  it('lets an option SWAP an ingredient, not just add one', () => {
    // บะหมี่: take the 120g of เส้นเล็ก @3 back out, put 120g of บะหมี่ @4 in.
    // The option costs the difference, not the whole new noodle.
    const swap = [
      { quantity: -120, unitCostSatang: 3 },
      { quantity: 120, unitCostSatang: 4 },
    ];
    expect(recipeCostSatang(swap)).toBe(120);
  });

  it('gives a removal a negative cost', () => {
    // เกาเหลา (ไม่เอาเส้น) genuinely keeps 3.60 baht in the shop.
    expect(recipeCostSatang([{ quantity: -120, unitCostSatang: 3 }])).toBe(-360);
  });

  it('rounds a negative half away from zero, like every other amount here', () => {
    expect(recipeCostSatang([{ quantity: -0.5, unitCostSatang: 1 }])).toBe(-1);
  });

  it('refuses a fractional satang as an ingredient cost', () => {
    // Rule #2 does not stop at the bill: a 2.5-satang gram would put a float
    // into every dish that uses it.
    expect(() => recipeCostSatang([{ quantity: 1, unitCostSatang: 2.5 }])).toThrow(TypeError);
  });

  it('refuses a quantity nobody meant to type', () => {
    expect(() => recipeCostSatang([{ quantity: MAX_RECIPE_QTY + 1, unitCostSatang: 1 }])).toThrow(
      RangeError,
    );
    expect(() => scaleQuantity(Number.NaN)).toThrow(RangeError);
  });
});

describe('isStorableQuantity', () => {
  it('accepts what Decimal(12,4) can hold', () => {
    expect(isStorableQuantity(120)).toBe(true);
    expect(isStorableQuantity(0.5)).toBe(true);
    // 0.1 * 10000 is 1000.0000000000001 in float. Rejecting it would reject an
    // ordinary "0.1 ขวด" and the owner would never work out why.
    expect(isStorableQuantity(0.1)).toBe(true);
    expect(isStorableQuantity(120.25)).toBe(true);
    expect(isStorableQuantity(-120)).toBe(true);
  });

  it('rejects a fifth decimal place and the absurd', () => {
    expect(isStorableQuantity(0.00001)).toBe(false);
    expect(isStorableQuantity(MAX_RECIPE_QTY * 2)).toBe(false);
    expect(isStorableQuantity(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('margin', () => {
  it('reports profit and food cost for a 50 baht bowl', () => {
    const cost = recipeCostSatang(PORK_NOODLE); // 2140
    expect(grossProfitSatang(5000, cost)).toBe(2860);
    expect(foodCostBp(5000, cost)).toBe(4280); // 42.8%
    expect(grossMarginBp(5000, cost)).toBe(5720);
  });

  it('says nothing rather than something wrong when the price is 0', () => {
    // A free item has no food cost percentage. 0% and ∞% both read as answers.
    expect(foodCostBp(0, 500)).toBeNull();
    expect(grossMarginBp(0, 500)).toBeNull();
  });

  it('does not hide a dish sold below cost', () => {
    expect(grossProfitSatang(1000, 1500)).toBe(-500);
    expect(foodCostBp(1000, 1500)).toBe(15_000); // 150%
    expect(grossMarginBp(1000, 1500)).toBe(-5000);
  });
});

describe('formatting', () => {
  it('writes percentages the way a menu board would', () => {
    expect(formatPercentBp(3500)).toBe('35%');
    expect(formatPercentBp(3450)).toBe('34.5%');
    expect(formatPercentBp(-5000)).toBe('-50%');
  });

  it('drops the trailing zeros off a quantity', () => {
    expect(formatQuantity(120)).toBe('120');
    expect(formatQuantity(0.5)).toBe('0.5');
    expect(formatQuantity(120.25)).toBe('120.25');
    expect(formatQuantity(-0)).toBe('0');
  });
});

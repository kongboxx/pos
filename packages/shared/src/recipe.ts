/**
 * Cost from the recipe (BOM).
 *
 * Until now `MenuItem.costSatang` was a number somebody typed. From Step 6 it
 * is DERIVED: a dish costs the sum of what goes in it, and the column in the
 * database is a cache of the function below. There is no screen to type a cost
 * into, because a hand-typed cost and a recipe are two answers to one question
 * and the wrong one always wins the argument at month end.
 *
 * TWO THINGS ARE LOAD-BEARING HERE.
 *
 * 1. THE ARITHMETIC IS INTEGER. Quantity is a Decimal(12,4) in the database —
 *    120 grams, 0.5 ขวด — and multiplying a float by a satang cost then summing
 *    is exactly how a bowl ends up costing 17.999999 satang. Everything is
 *    scaled to ten-thousandths first, summed as integers, and rounded ONCE at
 *    the end. Rounding each line and then adding drifts by a satang per
 *    ingredient, which on a five-ingredient bowl is a 2% lie about the margin.
 *
 * 2. QUANTITY MAY BE NEGATIVE, and only on an OPTION's recipe. "บะหมี่" does
 *    not add noodles, it swaps them: −120 g เส้นเล็ก, +120 g บะหมี่, and the
 *    cost delta falls out as the difference. "เกาเหลา (ไม่เอาเส้น)" is −120 g
 *    and nothing else, which is why its cost delta is negative — the shop
 *    genuinely keeps that money. A dish's own recipe never has negative lines;
 *    a dish that removes something just does not list it.
 *
 * Nothing here touches an order. Rule #7 says a sold line keeps the cost it was
 * sold at, so recomputing tonight's recipe must not move this afternoon's
 * profit — the recompute writes to MenuItem/Modifier and stops there.
 */

import { assertSatang, roundHalfUp, type Satang } from './money.js';
import { BP_PER_UNIT } from './vat.js';

/** RecipeLine.quantity is Decimal(12,4) — four places, no more. */
export const RECIPE_QTY_DECIMALS = 4;
export const RECIPE_QTY_SCALE = 10 ** RECIPE_QTY_DECIMALS;

/** A sanity ceiling: 100,000 grams of anything in one bowl is a typo. */
export const MAX_RECIPE_QTY = 100_000;

/** Most bowls use five or six things. Thirty is a wall, not a target. */
export const MAX_RECIPE_LINES = 30;

/**
 * A rule of thumb, not a rule: above ~35% food cost a Thai noodle shop is
 * working for the supplier. Used to colour one column, never to block a save —
 * the owner may well want a loss-leader on the menu and knows why.
 */
export const HIGH_FOOD_COST_BP = 3500;

export interface RecipeCostLine {
  /** In the ingredient's base unit. Negative = this option takes it back out. */
  quantity: number;
  /** Cost of ONE base unit, integer satang. */
  unitCostSatang: Satang;
}

/**
 * Turns a quantity into ten-thousandths so the rest of the maths is integer.
 * Throws rather than silently truncating: a quantity the database cannot store
 * is a bug in the caller, and losing it quietly would show up months later as a
 * cost that never quite matches the recipe on screen.
 */
export function scaleQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) {
    throw new RangeError(`quantity must be a finite number, got ${quantity}`);
  }
  if (Math.abs(quantity) > MAX_RECIPE_QTY) {
    throw new RangeError(`quantity exceeds ${MAX_RECIPE_QTY}: ${quantity}`);
  }
  return roundHalfUp(quantity * RECIPE_QTY_SCALE);
}

/** True when the number survives a round trip through Decimal(12,4). */
export function isStorableQuantity(quantity: number): boolean {
  if (!Number.isFinite(quantity) || Math.abs(quantity) > MAX_RECIPE_QTY) return false;
  const scaled = quantity * RECIPE_QTY_SCALE;
  // A float comparison, deliberately: 0.1 * 10000 is 1000.0000000000001, and
  // rejecting that would reject a perfectly ordinary "0.1 ขวด".
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * What one portion costs, in satang.
 *
 * Summed in scaled integers and rounded once at the end — see the file header
 * for why per-line rounding is wrong.
 */
export function recipeCostSatang(lines: readonly RecipeCostLine[]): Satang {
  let scaled = 0;
  for (const line of lines) {
    assertSatang(line.unitCostSatang, 'ingredient unit cost');
    scaled += scaleQuantity(line.quantity) * line.unitCostSatang;
  }
  return roundHalfUp(scaled / RECIPE_QTY_SCALE);
}

/** What one line of the recipe contributes. For the editor's right-hand column. */
export function recipeLineCostSatang(line: RecipeCostLine): Satang {
  return recipeCostSatang([line]);
}

/** Price minus cost. May be negative, and the screen says so rather than hiding it. */
export function grossProfitSatang(priceSatang: Satang, costSatang: Satang): Satang {
  assertSatang(priceSatang, 'price');
  assertSatang(costSatang, 'cost');
  return priceSatang - costSatang;
}

/**
 * Cost as a share of the price, in basis points. 3500 = 35%.
 *
 * Returns null when the price is zero — a free item has no meaningful food cost
 * percentage, and 0 or Infinity would both read as a real answer on screen.
 */
export function foodCostBp(priceSatang: Satang, costSatang: Satang): number | null {
  assertSatang(priceSatang, 'price');
  assertSatang(costSatang, 'cost');
  if (priceSatang <= 0) return null;
  return roundHalfUp((costSatang * BP_PER_UNIT) / priceSatang);
}

/** Profit as a share of the price, in basis points. The complement of foodCostBp. */
export function grossMarginBp(priceSatang: Satang, costSatang: Satang): number | null {
  const cost = foodCostBp(priceSatang, costSatang);
  return cost === null ? null : BP_PER_UNIT - cost;
}

/**
 * Basis points as a percentage for the screen: 3500 -> "35%", 3450 -> "34.5%".
 *
 * Unlike formatRateBp in vat.ts this accepts anything: a margin can exceed 100%
 * (water bought at 5 sold at 10) and can be negative (selling below cost).
 */
export function formatPercentBp(bp: number): string {
  const percent = bp / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * A quantity for the screen: 120 -> "120", 0.5 -> "0.5", 120.2500 -> "120.25".
 *
 * Trailing zeros are dropped because "120.0000 กรัม" on a row the owner is
 * about to retype is four characters of noise on a tablet keyboard.
 */
export function formatQuantity(quantity: number): string {
  const rounded = roundHalfUp(quantity * RECIPE_QTY_SCALE) / RECIPE_QTY_SCALE;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

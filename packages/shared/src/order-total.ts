/**
 * Order totalling.
 *
 * PROJECT RULE #7: an order line carries a SNAPSHOT of the price and cost at
 * the moment of sale. Reports never join back to MenuItem — if they did, last
 * week's profit would change the moment someone edits a menu price.
 *
 * That is why every function here works on snapshot values passed in, and
 * never touches the database.
 */

import { assertSatang, multiplySatang, sumSatang, type Satang } from './money.js';
import { calculateVat, type VatConfig, type VatBreakdown } from './vat.js';

export interface LineModifierSnapshot {
  nameSnapshot: string;
  priceDeltaSatang: Satang;
  costDeltaSatang: Satang;
}

export interface OrderLineSnapshot {
  nameSnapshot: string;
  qty: number;
  unitPriceSatang: Satang;
  unitCostSatang: Satang;
  modifiers?: readonly LineModifierSnapshot[];
  /** A voided line contributes nothing to sales or to food cost. */
  voidedAt?: Date | null;
  /**
   * A customer's QR request that no member of staff has agreed to yet (Step 7).
   *
   * Excluded for a different reason than a voided line, and the difference is
   * worth keeping straight: a voided line WAS sold and then taken back, so it
   * lives on the bill as evidence. This one was never sold at all. Counting it
   * would put money on the bill that the shop has not agreed to take, and the
   * first person to notice would be a customer being asked to pay for a bowl
   * that was refused.
   */
  awaitingApproval?: boolean;
}

export interface LineTotal {
  /** (unit price + modifier deltas) — one portion. */
  effectiveUnitPriceSatang: Satang;
  effectiveUnitCostSatang: Satang;
  /** effective unit x qty. */
  lineTotalSatang: Satang;
  lineCostSatang: Satang;
}

export interface OrderTotal extends VatBreakdown {
  /** Sum of non-voided line totals, BEFORE any discount. */
  grossSatang: Satang;
  /**
   * The discount actually taken off, which is not always the one that was
   * asked for — see `clampDiscount`.
   */
  discountSatang: Satang;
  /** Sum of non-voided line costs — the food cost of this bill. */
  costSatang: Satang;
  lineCount: number;
}

/**
 * A discount can never exceed what is on the bill.
 *
 * This matters because a discount is agreed BEFORE the bill stops changing. A
 * supervisor signs off ฿20 on a ฿235 bill, then two bowls come back as voids
 * and the bill is worth ฿15. Subtracting the signed ฿20 would print a total of
 * −฿5 and turn a sale into the shop owing money.
 *
 * Clamping downward is the only direction that is safe in both readings: the
 * customer never pays a negative amount, and the shop never gives away more
 * than it sold. It is arithmetic, not a change of policy, so it does not need
 * a second signature — but the number on the bill and the number in the audit
 * log can differ afterwards, and the log is the one that says what was agreed.
 */
export function clampDiscount(discountSatang: Satang, grossSatang: Satang): Satang {
  assertSatang(discountSatang, 'discount');
  assertSatang(grossSatang, 'gross');
  if (discountSatang < 0) {
    throw new RangeError(`discount must not be negative, got ${discountSatang}`);
  }
  return Math.min(discountSatang, grossSatang);
}

/** Totals a single line including its modifiers. Modifier deltas may be negative. */
export function calculateLineTotal(line: OrderLineSnapshot): LineTotal {
  assertSatang(line.unitPriceSatang, 'unitPriceSatang');
  assertSatang(line.unitCostSatang, 'unitCostSatang');

  const modifiers = line.modifiers ?? [];
  const priceDelta = sumSatang(modifiers.map((m) => m.priceDeltaSatang));
  const costDelta = sumSatang(modifiers.map((m) => m.costDeltaSatang));

  const effectiveUnitPriceSatang = line.unitPriceSatang + priceDelta;
  const effectiveUnitCostSatang = line.unitCostSatang + costDelta;

  if (effectiveUnitPriceSatang < 0) {
    throw new RangeError(
      `line "${line.nameSnapshot}" has a negative effective price (${effectiveUnitPriceSatang})`,
    );
  }

  return {
    effectiveUnitPriceSatang,
    effectiveUnitCostSatang,
    lineTotalSatang: multiplySatang(effectiveUnitPriceSatang, line.qty),
    lineCostSatang: multiplySatang(effectiveUnitCostSatang, line.qty),
  };
}

/**
 * Totals a whole bill.
 *
 * VAT is applied ONCE on the order gross, never summed from per-line rounding.
 * Voided lines and unapproved QR requests are excluded from both sales and cost.
 *
 * THE DISCOUNT COMES OFF BEFORE VAT, deliberately. VAT is owed on what the shop
 * actually receives, so a ฿20 discount on a ฿235 VAT-inclusive bill leaves ฿215
 * to be split into net and VAT — not ฿235 split first and ฿20 taken off the
 * bottom, which would have the shop paying VAT on money it never took.
 *
 * The discount does NOT touch `costSatang`: the food was cooked and eaten
 * whatever was charged for it. That is what makes a discounted bill show up as
 * a thinner margin in the P&L instead of quietly vanishing.
 */
export function calculateOrderTotal(
  lines: readonly OrderLineSnapshot[],
  vatConfig: VatConfig,
  discountSatang: Satang = 0,
): OrderTotal {
  const active = lines.filter((line) => !line.voidedAt && !line.awaitingApproval);
  const totals = active.map(calculateLineTotal);

  const grossSatang = sumSatang(totals.map((t) => t.lineTotalSatang));
  const costSatang = sumSatang(totals.map((t) => t.lineCostSatang));

  const discount = clampDiscount(discountSatang, grossSatang);
  const vat = calculateVat(grossSatang - discount, vatConfig);

  return {
    ...vat,
    grossSatang,
    discountSatang: discount,
    costSatang,
    lineCount: active.length,
  };
}

/**
 * Food cost percentage in basis points (integer, no float leaking out).
 * 3500 means 35.00%. Returns null on a zero-sales bill instead of NaN.
 */
export function foodCostPercentBp(salesSatang: Satang, costSatang: Satang): number | null {
  assertSatang(salesSatang, 'sales');
  assertSatang(costSatang, 'cost');
  if (salesSatang === 0) return null;
  return Math.round((costSatang * 10_000) / salesSatang);
}

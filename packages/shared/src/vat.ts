/**
 * VAT calculation.
 *
 * PROJECT RULE #3: every bill carries the full set of VAT fields from day one,
 * even while the shop is not VAT-registered. Today `vatEnabled = false` and the
 * amounts come out 0; the day the registration lands we flip one switch per
 * branch and nothing else in the codebase changes.
 *
 * The rate is stored in BASIS POINTS (bp) as an Int: 7% => 700. Storing it as
 * 0.07 would be a float, which rule #2 forbids anywhere near money.
 */

import { assertSatang, roundHalfUp, type Satang } from './money.js';

export const BP_PER_UNIT = 10_000;
/** Thailand standard VAT rate, 7%. */
export const VAT_RATE_BP_7 = 700;

export interface VatConfig {
  /** Master switch per branch. When false everything below returns zeros. */
  enabled: boolean;
  /** Rate in basis points, e.g. 700 for 7%. */
  rateBp: number;
  /** true = menu prices already contain VAT (the usual Thai restaurant case). */
  priceIncludesVat: boolean;
}

export interface VatBreakdown {
  /** Net amount excluding VAT. */
  subtotalExVatSatang: Satang;
  /** The VAT portion. */
  vatAmountSatang: Satang;
  /** What the customer actually pays. */
  totalSatang: Satang;
  /** Snapshot of the rate used, stored on the order so history never shifts. */
  vatRateBpSnapshot: number;
  isVatInclusive: boolean;
}

/**
 * Splits a gross (VAT-inclusive) amount into net + VAT.
 * vat = round(gross * rate / (10000 + rate))
 */
export function extractVatFromInclusive(grossSatang: Satang, rateBp: number): Satang {
  assertSatang(grossSatang, 'gross');
  assertRateBp(rateBp);
  if (rateBp === 0) return 0;
  return roundHalfUp((grossSatang * rateBp) / (BP_PER_UNIT + rateBp));
}

/**
 * Adds VAT on top of a net (VAT-exclusive) amount.
 * vat = round(net * rate / 10000)
 */
export function addVatToExclusive(netSatang: Satang, rateBp: number): Satang {
  assertSatang(netSatang, 'net');
  assertRateBp(rateBp);
  if (rateBp === 0) return 0;
  return roundHalfUp((netSatang * rateBp) / BP_PER_UNIT);
}

/**
 * The single entry point used when closing a bill.
 *
 * `grossOrNetSatang` is interpreted according to `config.priceIncludesVat`:
 *  - inclusive: it is what the customer pays, VAT is carved out of it
 *  - exclusive: it is the net, VAT is added on top
 *
 * VAT is computed on the ORDER TOTAL, not per line, and only once. Summing
 * per-line rounded VAT drifts by a satang or two against the printed total,
 * which is exactly the kind of mismatch the Revenue Department asks about.
 */
export function calculateVat(grossOrNetSatang: Satang, config: VatConfig): VatBreakdown {
  assertSatang(grossOrNetSatang, 'amount');

  if (!config.enabled || config.rateBp === 0) {
    return {
      subtotalExVatSatang: grossOrNetSatang,
      vatAmountSatang: 0,
      totalSatang: grossOrNetSatang,
      vatRateBpSnapshot: 0,
      isVatInclusive: config.priceIncludesVat,
    };
  }

  if (config.priceIncludesVat) {
    const vatAmountSatang = extractVatFromInclusive(grossOrNetSatang, config.rateBp);
    return {
      subtotalExVatSatang: grossOrNetSatang - vatAmountSatang,
      vatAmountSatang,
      totalSatang: grossOrNetSatang,
      vatRateBpSnapshot: config.rateBp,
      isVatInclusive: true,
    };
  }

  const vatAmountSatang = addVatToExclusive(grossOrNetSatang, config.rateBp);
  return {
    subtotalExVatSatang: grossOrNetSatang,
    vatAmountSatang,
    totalSatang: grossOrNetSatang + vatAmountSatang,
    vatRateBpSnapshot: config.rateBp,
    isVatInclusive: false,
  };
}

/** Formats a bp rate for the receipt: 700 -> "7%", 725 -> "7.25%". */
export function formatRateBp(rateBp: number): string {
  assertRateBp(rateBp);
  const percent = rateBp / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

function assertRateBp(rateBp: number): void {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > BP_PER_UNIT) {
    throw new RangeError(
      `vat rate must be an integer 0..${BP_PER_UNIT} basis points, got ${rateBp}`,
    );
  }
}

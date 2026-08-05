/**
 * Money primitives.
 *
 * PROJECT RULE #2: money is ALWAYS an integer number of satang (Int).
 * 60.00 THB is stored and passed around as 6000. Never float, never Decimal,
 * never a string that has been through parseFloat.
 *
 * Every money calculation in this codebase must go through this file so that
 * there is exactly one rounding policy to reason about and to test.
 */

/** Branded type so a raw `number` cannot be passed where satang is expected by mistake. */
export type Satang = number;

export const SATANG_PER_BAHT = 100;

/**
 * Rounds half away from zero (2.5 -> 3, -2.5 -> -3).
 *
 * JS `Math.round` rounds half toward +Infinity, which makes negative amounts
 * (discounts, credit notes) round the wrong way. Thai accounting practice is
 * half-up on the absolute value, so we implement it explicitly.
 */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Converts baht (may have decimals) to satang. Use only at the UI/import boundary. */
export function bahtToSatang(baht: number): Satang {
  if (!Number.isFinite(baht)) throw new RangeError(`bahtToSatang: not a finite number: ${baht}`);
  return roundHalfUp(baht * SATANG_PER_BAHT);
}

/** Converts satang to baht as a float. Use ONLY for display/CSV, never for math. */
export function satangToBaht(satang: Satang): number {
  assertSatang(satang);
  return satang / SATANG_PER_BAHT;
}

/**
 * Parses user-typed baht ("60", "60.5", "1,234.50", " 60.-") into satang.
 * Returns null when the input is not a valid amount, so callers must handle it.
 */
export function parseBahtToSatang(input: string): Satang | null {
  const cleaned = input.trim().replace(/,/g, '').replace(/\.-$/, '').replace(/฿|บาท/g, '').trim();
  if (cleaned === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const asNumber = Number(cleaned);
  if (!Number.isFinite(asNumber)) return null;
  return roundHalfUp(asNumber * SATANG_PER_BAHT);
}

/** Formats satang for Thai UI: 6000 -> "60.00". Grouping on, always 2 decimals. */
export function formatSatang(satang: Satang, opts?: { withSymbol?: boolean }): string {
  assertSatang(satang);
  const text = (satang / SATANG_PER_BAHT).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return opts?.withSymbol ? `฿${text}` : text;
}

/** Throws unless the value is a safe integer. Guards against a float leaking in. */
export function assertSatang(value: number, label = 'amount'): asserts value is Satang {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer satang value, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds safe integer range: ${value}`);
  }
}

/** Sums satang amounts with an integer guard on every term. */
export function sumSatang(amounts: readonly Satang[]): Satang {
  let total = 0;
  for (const amount of amounts) {
    assertSatang(amount);
    total += amount;
  }
  assertSatang(total, 'sum');
  return total;
}

/**
 * Multiplies a unit price by a whole quantity.
 * Quantity must be an integer — half-portions are modelled as a separate
 * menu item or modifier, never as qty 0.5, so that money stays integral.
 */
export function multiplySatang(unitSatang: Satang, qty: number): Satang {
  assertSatang(unitSatang, 'unit price');
  if (!Number.isInteger(qty) || qty < 0) {
    throw new RangeError(`qty must be a non-negative integer, got ${qty}`);
  }
  return unitSatang * qty;
}

/**
 * Cash change. Returns null when the customer handed over too little,
 * so the caller is forced to decide what to show instead of printing a
 * negative change amount on a receipt.
 */
export function calculateChange(totalSatang: Satang, receivedSatang: Satang): Satang | null {
  assertSatang(totalSatang, 'total');
  assertSatang(receivedSatang, 'received');
  if (receivedSatang < totalSatang) return null;
  return receivedSatang - totalSatang;
}

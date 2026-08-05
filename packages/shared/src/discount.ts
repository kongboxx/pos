/**
 * Bill discounts.
 *
 * A discount is the only way money leaves a bill without food leaving the
 * kitchen, which is why rule #8 names it in the same breath as a void: every
 * one of them is signed by a supervisor's PIN and lands in the audit log.
 *
 * THE DISCOUNT IS STORED AS AN AMOUNT, NEVER AS A PERCENTAGE, even when the
 * cashier typed a percentage. The percentage is a calculator on the way in and
 * is recorded in the log so "ลด 10%" is still readable a month later — but what
 * the bill carries is the satang figure that was agreed. Storing the percentage
 * and re-deriving it would mean that adding one more bowl after the approval
 * silently increases the discount, and money would leave the till on a
 * signature nobody gave. The bill only ever changes by someone touching it.
 *
 * WHOLE BILL ONLY. Discounting a single line is a different feature with a
 * different table, and a noodle shop's discount is "ลดให้ 20 บาท" on the whole
 * thing. See the README for where that sits.
 */

import { z } from 'zod';
import { roundHalfUp, assertSatang, type Satang } from './money.js';
import { normalizeNote, MAX_ORDER_NOTE } from './order.js';
// The same percentage formatter the menu screen uses for margins. One rounding
// policy for percentages, in one place, however different the two screens look.
import { formatPercentBp } from './recipe.js';
import { pinSchema, uuidSchema } from './schemas.js';
import { BP_PER_UNIT } from './vat.js';

/**
 * A fixed list, same reasoning as VOID_REASONS.
 *
 * The owner's month-end question is "how much did we give away and to whom",
 * and typed sentences cannot be grouped into an answer. "อื่นๆ" forces a note.
 */
export const DISCOUNT_REASONS = [
  'ลูกค้าประจำ',
  'ขอโทษลูกค้า',
  'โปรโมชั่นร้าน',
  'พนักงาน/เจ้าของ',
  'อื่นๆ',
] as const;
export type DiscountReason = (typeof DISCOUNT_REASONS)[number];

export const discountReasonSchema = z.enum(DISCOUNT_REASONS);

/** How the cashier expressed it. Both end up as satang on the bill. */
export const DISCOUNT_MODES = ['AMOUNT', 'PERCENT'] as const;
export type DiscountMode = (typeof DISCOUNT_MODES)[number];

/**
 * Percentages are basis points, like the VAT rate: 10% is 1000, not 0.1.
 * Rule #2 keeps floats away from anything that ends up multiplying money.
 */
export const MAX_DISCOUNT_PERCENT_BP = BP_PER_UNIT;

/** `discountFromPercentBp(23500, 1000)` -> 2350. Rounds half away from zero. */
export function discountFromPercentBp(grossSatang: Satang, percentBp: number): Satang {
  assertSatang(grossSatang, 'gross');
  if (!Number.isInteger(percentBp) || percentBp < 0 || percentBp > MAX_DISCOUNT_PERCENT_BP) {
    throw new RangeError(
      `percent must be an integer 0..${MAX_DISCOUNT_PERCENT_BP} basis points, got ${percentBp}`,
    );
  }
  return roundHalfUp((grossSatang * percentBp) / BP_PER_UNIT);
}

/**
 * `mode` and `value` travel together rather than as a discriminated union so
 * that one form on the tablet posts one shape. What `value` MEANS depends on
 * the mode — satang for AMOUNT, basis points for PERCENT — and the refinements
 * below are what stop "10" meaning ten satang when the cashier meant ten
 * percent.
 */
export const discountRequestSchema = z
  .object({
    mode: z.enum(DISCOUNT_MODES),
    value: z.number().int('ส่วนลดต้องเป็นจำนวนเต็ม').min(1, 'ส่วนลดต้องมากกว่า 0'),
    reason: discountReasonSchema,
    note: z.string().max(MAX_ORDER_NOTE).nullish().transform(normalizeNote),
    /**
     * The supervisor standing at the terminal, and their PIN.
     *
     * Sent per discount rather than held as a second session, for the same
     * reason as a void: an approval signs ONE event, and a manager who walks
     * away must not leave an "approved" state behind on the tablet.
     */
    approverStaffId: uuidSchema,
    approverPin: pinSchema,
  })
  .refine((value) => value.mode !== 'PERCENT' || value.value <= MAX_DISCOUNT_PERCENT_BP, {
    message: 'ส่วนลดเป็นเปอร์เซ็นต์ต้องไม่เกิน 100%',
    path: ['value'],
  })
  .refine((value) => value.reason !== 'อื่นๆ' || (value.note?.length ?? 0) > 0, {
    message: 'เลือก "อื่นๆ" ต้องเขียนเหตุผลด้วย',
    path: ['note'],
  });
export type DiscountRequest = z.infer<typeof discountRequestSchema>;

/**
 * Taking a discount back off a bill.
 *
 * Carries a PIN too, and the reason is the direction of travel: removing a
 * discount RAISES what the customer pays. A bill that got dearer between the
 * quote and the till is the version of this that ends in an argument, so the
 * same person who could grant it is the one who can withdraw it. No reason is
 * asked for — there is only one, and it is "the first one was a mistake".
 */
export const clearDiscountRequestSchema = z.object({
  approverStaffId: uuidSchema,
  approverPin: pinSchema,
});
export type ClearDiscountRequest = z.infer<typeof clearDiscountRequestSchema>;

/**
 * Turns what was typed into satang off this bill.
 *
 * Kept out of the schema on purpose: resolving a percentage needs the bill
 * total, and the bill total is not in the request. The server reads the bill,
 * calls this, and stores the answer.
 */
export function resolveDiscount(request: DiscountRequest, grossSatang: Satang): Satang {
  return request.mode === 'PERCENT'
    ? discountFromPercentBp(grossSatang, request.value)
    : request.value;
}

/** How the discount reads on screen and in the log: "ลูกค้าประจำ · 10%". */
export function describeDiscount(request: DiscountRequest): string {
  const how =
    request.mode === 'PERCENT' ? formatPercentBp(request.value) : `${request.value / 100} บาท`;
  return request.note
    ? `${request.reason} · ${how} · ${request.note}`
    : `${request.reason} · ${how}`;
}

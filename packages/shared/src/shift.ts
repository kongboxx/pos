/**
 * Opening and closing the till, and counting the drawer.
 *
 * THE QUESTION THIS ANSWERS IS "เงินขาดไปไหม", and it is the one question a
 * shop cannot answer from the sales figures alone. The reports from Step 8 say
 * what the shop SOLD. This says what is actually in the drawer, and the gap
 * between the two is the only place a missing note ever shows up.
 *
 * A shift is a TIME WINDOW at one branch, and everything about it follows from
 * that:
 *
 *  - ONE OPEN SHIFT PER BRANCH. Two overlapping windows would count the same
 *    cash sale twice and no arithmetic afterwards could untangle them. A noodle
 *    shop has one drawer; when it has two, this becomes a per-register thing
 *    and that is a different feature.
 *  - CASH ONLY. PromptPay never touches the drawer, so counting it would
 *    guarantee a variance every single day and train everyone to ignore the
 *    number. The whole point is that a non-zero variance is worth looking at.
 *  - CLOSED IS CLOSED. A shift that can be reopened and re-counted is a shift
 *    whose variance can be typed away the next morning.
 *
 * WHAT IS NOT COUNTED: cash taken before the shift was opened. If the first
 * three bowls of the morning are rung up before anyone presses เปิดกะ, that
 * money is in the drawer and not in the expected figure, and the count will
 * come out over. That reads as "someone forgot to open the till", which is
 * exactly what happened — better than a system that silently back-dates.
 */

import { z } from 'zod';
import { assertSatang, formatSatang, type Satang } from './money.js';
import { nonNegativeSatangSchema, uuidSchema } from './schemas.js';

/**
 * A cap on the opening float and the counted total.
 *
 * ฿200,000 is far above anything a noodle shop's drawer holds and far below a
 * mis-typed digit run (a fat finger on the keypad turns 2,000 into 200,000 —
 * this catches the one after that). It exists so a typo is refused at the door
 * rather than being recorded as a ฿1,998,000 variance nobody can explain.
 */
export const MAX_DRAWER_SATANG = 20_000_000;

export const drawerAmountSchema = nonNegativeSatangSchema.max(
  MAX_DRAWER_SATANG,
  `จำนวนเงินเกิน ${formatSatang(MAX_DRAWER_SATANG)} บาท — พิมพ์ผิดหรือเปล่า`,
);

export const shiftNoteSchema = z.string().max(200).nullish();

/* ------------------------------------------------------------------ */
/* the maths                                                           */
/* ------------------------------------------------------------------ */

export interface CashDrawerInput {
  /** เงินทอนตั้งต้น — what was put in before the first customer. */
  openingCashSatang: Satang;
  /** Bills settled in CASH inside the window. PromptPay is not in here. */
  cashSalesSatang: Satang;
  /** Money taken OUT of the drawer during the window: cash-paid expenses. */
  cashOutSatang: Satang;
}

/**
 * What should be in the drawer if nothing went wrong.
 *
 * `cashOutSatang` is subtracted rather than ignored because the alternative is
 * a shop where every trip to the market makes the till look ฿500 short, and a
 * variance that is always wrong is a variance nobody reads.
 */
export function expectedCashSatang(input: CashDrawerInput): Satang {
  assertSatang(input.openingCashSatang, 'opening cash');
  assertSatang(input.cashSalesSatang, 'cash sales');
  assertSatang(input.cashOutSatang, 'cash out');
  return input.openingCashSatang + input.cashSalesSatang - input.cashOutSatang;
}

/**
 * counted − expected. NEGATIVE MEANS MONEY IS MISSING.
 *
 * Signed on purpose, and in this direction on purpose: "−50" reads as fifty
 * baht short to anyone who has ever counted a till, and an absolute value with
 * a separate flag is one refactor away from losing the sign.
 */
export function cashVarianceSatang(countedSatang: Satang, expectedSatang: Satang): Satang {
  assertSatang(countedSatang, 'counted cash');
  assertSatang(expectedSatang, 'expected cash');
  return countedSatang - expectedSatang;
}

/** "เงินขาด 50.00 บาท" / "เงินเกิน 20.00 บาท" / "ตรงพอดี". */
export function describeVariance(varianceSatang: Satang): string {
  assertSatang(varianceSatang, 'variance');
  if (varianceSatang === 0) return 'ตรงพอดี';
  return varianceSatang < 0
    ? `เงินขาด ${formatSatang(-varianceSatang)} บาท`
    : `เงินเกิน ${formatSatang(varianceSatang)} บาท`;
}

/**
 * Whether a variance is worth stopping over.
 *
 * ฿20 because a satang-perfect till is not a realistic target — a customer
 * waves off small change, someone rounds a ฿1 coin — and a screen that shouts
 * every day is a screen that gets ignored on the day it matters. Applies to
 * BOTH directions: cash appearing from nowhere is as odd as cash going missing.
 */
export const VARIANCE_TOLERANCE_SATANG = 2000;

export function isVarianceWorthAsking(varianceSatang: Satang): boolean {
  assertSatang(varianceSatang, 'variance');
  return Math.abs(varianceSatang) > VARIANCE_TOLERANCE_SATANG;
}

/* ------------------------------------------------------------------ */
/* requests                                                            */
/* ------------------------------------------------------------------ */

export const openShiftRequestSchema = z.object({
  /** เงินทอนตั้งต้นที่ใส่ลิ้นชัก. May legitimately be 0. */
  openingCashSatang: drawerAmountSchema,
  note: shiftNoteSchema,
});
export type OpenShiftRequest = z.infer<typeof openShiftRequestSchema>;

/**
 * Closing.
 *
 * The counted figure is the ONLY thing sent. The expected figure is worked out
 * on the server from the bills and never travels up from the tablet — a client
 * that could name its own expected total could close every shift dead level.
 */
export const closeShiftRequestSchema = z.object({
  countedCashSatang: drawerAmountSchema,
  note: shiftNoteSchema,
});
export type CloseShiftRequest = z.infer<typeof closeShiftRequestSchema>;

/* ------------------------------------------------------------------ */
/* responses                                                           */
/* ------------------------------------------------------------------ */

export const shiftDtoSchema = z.object({
  id: uuidSchema,
  branchId: uuidSchema,
  staffId: uuidSchema,
  /** Who opened it, for the list — resolving names on the screen is a join. */
  staffName: z.string(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),

  openingCashSatang: nonNegativeSatangSchema,
  /** Cash bills settled inside the window, live while the shift is open. */
  cashSalesSatang: nonNegativeSatangSchema,
  /** Cash-paid expenses recorded inside the window. */
  cashOutSatang: nonNegativeSatangSchema,
  /** PromptPay taken in the window. Shown, never counted into the drawer. */
  transferSalesSatang: nonNegativeSatangSchema,
  billCount: z.number().int().nonnegative(),

  /**
   * All three are null until the shift is closed.
   *
   * Null rather than a live running figure because the count has to be a count.
   * A screen that shows what the drawer SHOULD hold, next to the box where the
   * cashier types what it DOES hold, is a screen that gets the expected number
   * typed into it.
   */
  countedCashSatang: nonNegativeSatangSchema.nullable(),
  expectedCashSatang: z.number().int().nullable(),
  varianceSatang: z.number().int().nullable(),

  note: z.string().nullable(),
});
export type ShiftDto = z.infer<typeof shiftDtoSchema>;

export const currentShiftResponseSchema = z.object({
  /** null when nobody has opened the till. */
  shift: shiftDtoSchema.nullable(),
});
export type CurrentShiftResponse = z.infer<typeof currentShiftResponseSchema>;

export const shiftListResponseSchema = z.object({
  shifts: z.array(shiftDtoSchema),
});
export type ShiftListResponse = z.infer<typeof shiftListResponseSchema>;

/**
 * Money in, money out, and whether the shop is actually making any (Step 8).
 *
 * THE ONE THING THAT MUST NOT BE GOT WRONG HERE IS DOUBLE COUNTING.
 *
 * There are two different numbers in this system that both deserve the name
 * "ต้นทุนอาหาร", they are not the same number, and subtracting both from sales
 * is the classic way a small restaurant convinces itself it is losing money:
 *
 *  1. WHAT WAS ACTUALLY PAID OUT — an Expense row in the วัตถุดิบ category.
 *     Real cash, on the day it left the till. Lumpy: rice bought on Monday
 *     feeds Tuesday through Sunday.
 *
 *  2. WHAT THE RECIPES SAY THE FOOD IN THE BOWLS COST — the sum of
 *     OrderLine.unitCostSatang, snapshotted at the moment of sale (rule #7)
 *     from the BOM built in Step 6. Smooth, per-bowl, and never touched cash.
 *
 * So this file keeps them in two separate reports that are never added
 * together:
 *
 *  - THE P&L IS CASH BASIS: sales minus every expense actually recorded. This
 *    is the number that should match the shop's bank account, and it is the
 *    answer to "เดือนนี้ได้กำไรไหม".
 *  - THE RECIPE FIGURES ARE A PRICING TOOL: food-cost percentage and
 *    contribution margin. They answer "ตั้งราคาชามนี้ถูกไปไหม" and they feed
 *    the break-even calculation, where a per-bowl variable cost is exactly
 *    what is needed and a lumpy purchase invoice is useless.
 *
 * Which is also why break-even's fixed costs come from the FIXED expense
 * categories only, never from วัตถุดิบ: the variable side is already being
 * counted by the recipes.
 *
 * The honesty check that has to travel with figure 2 everywhere it goes: a
 * menu item with no recipe has unitCostSatang = 0, which does not read as
 * "unknown", it reads as "free". Every report that shows a recipe cost also
 * reports how many sold lines had no recipe, so a 12% food cost that is really
 * 34% cannot be quoted without the caveat attached.
 */

import { z } from 'zod';
import { assertBusinessDate, type BusinessDate } from './business-date.js';
import { assertSatang, type Satang } from './money.js';
import {
  businessDateSchema,
  nonNegativeSatangSchema,
  paidBySchema,
  paymentMethodSchema,
  yearMonthSchema,
} from './schemas.js';

/* ------------------------------------------------------------------ */
/* what money goes out on                                              */
/* ------------------------------------------------------------------ */

/**
 * Expense categories.
 *
 * A FIXED list, not free text, for the same reason the void reasons are fixed
 * (Step 5): at the end of the month the owner has to be able to ask "ค่าไฟ
 * เดือนนี้เท่าไหร่" and get one answer, not three spellings of it.
 *
 * Stored as the KEY, not the Thai label. Renaming a label later must not orphan
 * six months of rows, and the label is a display concern that belongs next to
 * the screens.
 */
export const ExpenseCategory = {
  INGREDIENT: 'INGREDIENT',
  WAGE: 'WAGE',
  RENT: 'RENT',
  UTILITY: 'UTILITY',
  EQUIPMENT: 'EQUIPMENT',
  OTHER: 'OTHER',
} as const;
export type ExpenseCategory = (typeof ExpenseCategory)[keyof typeof ExpenseCategory];

/**
 * Whether a category scales with how many bowls were sold.
 *
 * Only วัตถุดิบ is variable. ค่าน้ำค่าไฟ genuinely has a variable part, and it
 * is deliberately filed as fixed anyway: the variable part is small, splitting
 * it needs a meter reading nobody is going to take, and treating it as fixed
 * pushes the break-even target UP — the direction that is safe to be wrong in.
 */
export type ExpenseKind = 'FIXED' | 'VARIABLE';

export interface ExpenseCategoryInfo {
  key: ExpenseCategory;
  label: string;
  kind: ExpenseKind;
  /** Shown under the category button so the right one is picked first time. */
  hint: string;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategoryInfo[] = [
  {
    key: ExpenseCategory.INGREDIENT,
    label: 'วัตถุดิบ',
    kind: 'VARIABLE',
    hint: 'ของสด ของแห้ง เครื่องปรุง',
  },
  {
    key: ExpenseCategory.WAGE,
    label: 'ค่าแรง',
    kind: 'FIXED',
    hint: 'เงินเดือน ค่าจ้างรายวัน',
  },
  { key: ExpenseCategory.RENT, label: 'ค่าเช่า', kind: 'FIXED', hint: 'ค่าเช่าที่ ค่าส่วนกลาง' },
  {
    key: ExpenseCategory.UTILITY,
    label: 'น้ำ/ไฟ/แก๊ส',
    kind: 'FIXED',
    hint: 'ค่าน้ำ ค่าไฟ ถังแก๊ส เน็ต',
  },
  {
    key: ExpenseCategory.EQUIPMENT,
    label: 'อุปกรณ์',
    kind: 'FIXED',
    hint: 'หม้อ ชาม ตู้เย็น ของใช้ในร้าน',
  },
  { key: ExpenseCategory.OTHER, label: 'อื่น ๆ', kind: 'FIXED', hint: 'ที่ไม่เข้าพวกข้างบน' },
];

const CATEGORY_BY_KEY = new Map(EXPENSE_CATEGORIES.map((info) => [info.key as string, info]));

export const expenseCategorySchema = z.nativeEnum(ExpenseCategory);

/**
 * Label for a stored category value.
 *
 * Takes a plain string, not the enum, because the column is a String and a row
 * written by an older build (or by hand) must still render as something rather
 * than as blank. An unrecognised value is shown as itself.
 */
export function expenseCategoryLabel(value: string): string {
  return CATEGORY_BY_KEY.get(value)?.label ?? value;
}

/** Unknown categories count as FIXED — that only ever raises the break-even target. */
export function expenseKindOf(value: string): ExpenseKind {
  return CATEGORY_BY_KEY.get(value)?.kind ?? 'FIXED';
}

export function isFixedExpense(value: string): boolean {
  return expenseKindOf(value) === 'FIXED';
}

/* ------------------------------------------------------------------ */
/* percentages, kept as basis points so no float escapes               */
/* ------------------------------------------------------------------ */

/**
 * `part / whole` in basis points (3500 = 35.00%).
 * Returns null on a zero denominator instead of NaN or a misleading 0 —
 * "ยังไม่มียอดขาย" and "ต้นทุน 0%" are different answers.
 */
export function percentBp(part: Satang, whole: Satang): number | null {
  assertSatang(part, 'part');
  assertSatang(whole, 'whole');
  if (whole === 0) return null;
  return Math.round((part * 10_000) / whole);
}

/**
 * Contribution margin: the share of each baht of sales left over after the food
 * in the bowl, i.e. what is available to pay the rent.
 *
 * Can legitimately be negative — a dish priced below its ingredients — and that
 * is returned as a negative number rather than clamped, because clamping it to
 * zero would hide the single most important thing a report can tell a shop.
 */
export function contributionMarginBp(
  salesSatang: Satang,
  variableCostSatang: Satang,
): number | null {
  assertSatang(salesSatang, 'sales');
  assertSatang(variableCostSatang, 'variable cost');
  if (salesSatang === 0) return null;
  return percentBp(salesSatang - variableCostSatang, salesSatang);
}

/**
 * Sales needed to cover the fixed costs: fixed / contribution margin.
 *
 * Rounded UP — this is a target to clear, and a target rounded down is a target
 * that is met while still losing a satang.
 *
 * Returns null when the margin is zero or negative, which is not a failure but
 * the real answer: if every bowl loses money, no amount of selling breaks even,
 * and the screen has to say that instead of printing an enormous number.
 */
export function breakEvenSalesSatang(
  fixedCostSatang: Satang,
  marginBp: number | null,
): Satang | null {
  assertSatang(fixedCostSatang, 'fixed cost');
  if (marginBp === null || marginBp <= 0) return null;
  if (fixedCostSatang <= 0) return 0;
  return Math.ceil((fixedCostSatang * 10_000) / marginBp);
}

/* ------------------------------------------------------------------ */
/* month arithmetic                                                    */
/* ------------------------------------------------------------------ */

export function assertYearMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError(`yearMonth must be YYYY-MM, got "${value}"`);
  }
}

/**
 * The half-open business-date range of a month: `[start, endExclusive)`.
 *
 * Half-open rather than inclusive because "everything before the 1st of next
 * month" is one comparison that cannot be off by a day, whereas "up to the
 * 31st" needs to know how long the month is at every call site.
 */
export function monthRange(yearMonth: string): { start: BusinessDate; endExclusive: BusinessDate } {
  assertYearMonth(yearMonth);
  const [year, month] = yearMonth.split('-').map(Number) as [number, number];
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return { start: `${yearMonth}-01`, endExclusive: `${next}-01` };
}

export function daysInMonth(yearMonth: string): number {
  assertYearMonth(yearMonth);
  const [year, month] = yearMonth.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The `YYYY-MM` a business date falls in. */
export function yearMonthOf(businessDate: BusinessDate): string {
  assertBusinessDate(businessDate);
  return businessDate.slice(0, 7);
}

/* ------------------------------------------------------------------ */
/* recording money out                                                 */
/* ------------------------------------------------------------------ */

/**
 * An expense as typed in.
 *
 * `amountSatang` must be positive. A refund from a supplier is not a negative
 * expense here — negative rows would quietly cancel out real ones in every
 * grouped total and nobody would notice for a month. Refunds are not modelled
 * in this Step; the note field is where they go for now.
 */
export const expenseRequestSchema = z.object({
  date: businessDateSchema,
  category: expenseCategorySchema,
  amountSatang: nonNegativeSatangSchema.min(1, 'จำนวนเงินต้องมากกว่า 0'),
  note: z.string().trim().max(200, 'หมายเหตุยาวเกินไป').nullish(),
  paidBy: paidBySchema.default('CASH'),
});
export type ExpenseRequest = z.infer<typeof expenseRequestSchema>;

export const expenseDtoSchema = z.object({
  id: z.string().uuid(),
  date: businessDateSchema,
  category: z.string(),
  amountSatang: nonNegativeSatangSchema,
  note: z.string().nullable(),
  paidBy: paidBySchema,
  /**
   * Written by a payroll run rather than by a person (Step 9). The screens
   * refuse to edit these and so does the API: the payslip is the record, and a
   * hand-edited copy of it would make the two disagree with nothing to say
   * which is right.
   */
  isAutoGenerated: z.boolean(),
  createdAt: z.string(),
});
export type ExpenseDto = z.infer<typeof expenseDtoSchema>;

export const expenseListResponseSchema = z.object({
  yearMonth: yearMonthSchema,
  expenses: z.array(expenseDtoSchema),
  totalSatang: nonNegativeSatangSchema,
  byCategory: z.array(
    z.object({
      category: z.string(),
      amountSatang: nonNegativeSatangSchema,
    }),
  ),
});
export type ExpenseListResponse = z.infer<typeof expenseListResponseSchema>;

/* ------------------------------------------------------------------ */
/* the recipe-cost caveat, carried with every recipe figure            */
/* ------------------------------------------------------------------ */

/**
 * How much of what was sold has a recipe behind it.
 *
 * Counted in LINES rather than in baht on purpose: turning "these lines had no
 * cost" into a baht figure means re-totalling every line with its modifiers,
 * and the extra precision buys nothing — the point is a flag, not a
 * measurement. One in three bowls unpriced is already enough to say the food
 * cost below is fiction.
 */
export const recipeCoverageSchema = z.object({
  soldLineCount: z.number().int().nonnegative(),
  linesWithoutRecipeCount: z.number().int().nonnegative(),
});
export type RecipeCoverage = z.infer<typeof recipeCoverageSchema>;

/** true when the recipe cost is understated enough that it must not be quoted bare. */
export function coverageIsPoor(coverage: RecipeCoverage): boolean {
  return coverage.linesWithoutRecipeCount > 0;
}

/* ------------------------------------------------------------------ */
/* the daily close                                                     */
/* ------------------------------------------------------------------ */

export const dailyReportResponseSchema = z.object({
  businessDate: businessDateSchema,

  /** PAID bills only. An OPEN bill is food on a table, not takings. */
  paidOrderCount: z.number().int().nonnegative(),
  grossSalesSatang: nonNegativeSatangSchema,
  discountSatang: nonNegativeSatangSchema,
  /** Collected on behalf of the Revenue Department; not the shop's money. */
  vatSatang: nonNegativeSatangSchema,
  netSalesSatang: nonNegativeSatangSchema,
  averageBillSatang: nonNegativeSatangSchema.nullable(),

  payments: z.array(
    z.object({
      method: paymentMethodSchema,
      count: z.number().int().nonnegative(),
      amountSatang: nonNegativeSatangSchema,
    }),
  ),

  recipeCostSatang: nonNegativeSatangSchema,
  recipeCostPercentBp: z.number().int().nullable(),
  grossProfitSatang: z.number().int(),
  coverage: recipeCoverageSchema,

  expenseTotalSatang: nonNegativeSatangSchema,
  byCategory: z.array(z.object({ category: z.string(), amountSatang: nonNegativeSatangSchema })),

  /**
   * Bills still open when the report was asked for.
   *
   * Reported separately and never folded into sales. Read at 6pm this is the
   * difference between "ขายได้ 4,850" and a cashier wondering why the drawer
   * disagrees.
   */
  openOrderCount: z.number().int().nonnegative(),
  openOrderTotalSatang: nonNegativeSatangSchema,
  cancelledOrderCount: z.number().int().nonnegative(),

  /**
   * ใบลดหนี้ issued ON THIS DATE (Step 10), whenever the sale itself happened.
   *
   * Reported next to the takings rather than folded into them, because the two
   * numbers answer different questions. A credit note takes its sale back out
   * of the day the money was TAKEN — so the figures above already exclude it —
   * while this line says what was handed back TODAY. Without it, a day where
   * the shop refunded 900 baht from last week looks like an ordinary day.
   */
  creditNoteCount: z.number().int().nonnegative(),
  creditNoteSatang: nonNegativeSatangSchema,

  voidCount: z.number().int().nonnegative(),
  voidFiredCount: z.number().int().nonnegative(),
  voidSalesValueSatang: nonNegativeSatangSchema,
  voidCostSatang: nonNegativeSatangSchema,
});
export type DailyReportResponse = z.infer<typeof dailyReportResponseSchema>;

/* ------------------------------------------------------------------ */
/* the monthly P&L                                                     */
/* ------------------------------------------------------------------ */

export const breakEvenSchema = z.object({
  fixedCostSatang: nonNegativeSatangSchema,
  fixedByCategory: z.array(
    z.object({ category: z.string(), amountSatang: nonNegativeSatangSchema }),
  ),
  /**
   * true when no ค่าเช่า was recorded this month and Branch.rentPerMonthSatang
   * was used instead. Flagged rather than silent: a break-even that quietly
   * left out the largest fixed cost in the shop is worse than no break-even.
   */
  rentFromSettings: z.boolean(),

  contributionMarginBp: z.number().int().nullable(),
  breakEvenSalesSatang: nonNegativeSatangSchema.nullable(),
  breakEvenPerDaySatang: nonNegativeSatangSchema.nullable(),
  daysInMonth: z.number().int().positive(),
  /** netSales − breakEvenSales. Negative = still short. */
  surplusSatang: z.number().int().nullable(),
});
export type BreakEven = z.infer<typeof breakEvenSchema>;

export const pnlResponseSchema = z.object({
  yearMonth: yearMonthSchema,

  /* --- เงินเข้า --- */
  paidOrderCount: z.number().int().nonnegative(),
  grossSalesSatang: nonNegativeSatangSchema,
  discountSatang: nonNegativeSatangSchema,
  vatSatang: nonNegativeSatangSchema,
  netSalesSatang: nonNegativeSatangSchema,

  /* --- เงินออกจริง (cash basis) --- */
  expenseTotalSatang: nonNegativeSatangSchema,
  byCategory: z.array(
    z.object({
      category: z.string(),
      amountSatang: nonNegativeSatangSchema,
      kind: z.enum(['FIXED', 'VARIABLE']),
    }),
  ),
  /** netSales − expenseTotal. THE number. May be negative. */
  netProfitSatang: z.number().int(),

  /* --- ตามสูตร: a pricing tool, never subtracted from the above --- */
  recipeCostSatang: nonNegativeSatangSchema,
  recipeCostPercentBp: z.number().int().nullable(),
  contributionSatang: z.number().int(),
  coverage: recipeCoverageSchema,

  breakEven: breakEvenSchema,
});
export type PnlResponse = z.infer<typeof pnlResponseSchema>;

/* ------------------------------------------------------------------ */
/* what got thrown away                                                */
/* ------------------------------------------------------------------ */

/**
 * The void report.
 *
 * Two numbers per row and they mean different things. `salesValueSatang` is
 * revenue that did not happen; `costSatang` is food that went in the bin. Only
 * the second is a loss the shop actually paid for, and only when `wasFired` —
 * a customer changing their mind before the cook started costs nothing but the
 * keystroke, which is exactly why Step 5 records that flag.
 */
export const voidReportRowSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  businessDate: businessDateSchema,
  orderNo: z.string().nullable(),
  nameSnapshot: z.string(),
  qty: z.number().int().positive(),
  salesValueSatang: nonNegativeSatangSchema,
  costSatang: nonNegativeSatangSchema,
  reason: z.string(),
  note: z.string().nullable(),
  wasFired: z.boolean(),
  requestedByName: z.string(),
  approvedByName: z.string(),
});
export type VoidReportRow = z.infer<typeof voidReportRowSchema>;

export const voidReportResponseSchema = z.object({
  from: businessDateSchema,
  to: businessDateSchema,
  totalCount: z.number().int().nonnegative(),
  totalQty: z.number().int().nonnegative(),
  salesValueSatang: nonNegativeSatangSchema,
  costSatang: nonNegativeSatangSchema,
  /** The subset that had already reached the kitchen — the real waste. */
  firedCount: z.number().int().nonnegative(),
  firedCostSatang: nonNegativeSatangSchema,
  byReason: z.array(
    z.object({
      reason: z.string(),
      count: z.number().int().nonnegative(),
      qty: z.number().int().nonnegative(),
      salesValueSatang: nonNegativeSatangSchema,
      costSatang: nonNegativeSatangSchema,
      firedCount: z.number().int().nonnegative(),
    }),
  ),
  rows: z.array(voidReportRowSchema),
});
export type VoidReportResponse = z.infer<typeof voidReportResponseSchema>;

/* ------------------------------------------------------------------ */
/* query parameters                                                    */
/* ------------------------------------------------------------------ */

export const dailyReportQuerySchema = z.object({ date: businessDateSchema });
export const pnlQuerySchema = z.object({ month: yearMonthSchema });
export const voidReportQuerySchema = z
  .object({ from: businessDateSchema, to: businessDateSchema })
  .refine((value) => value.from <= value.to, {
    message: 'วันเริ่มต้องไม่เกินวันสิ้นสุด',
    path: ['from'],
  });
export const expenseListQuerySchema = z.object({ month: yearMonthSchema });

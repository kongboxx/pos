/**
 * Order request/response shapes.
 *
 * The important one is `createOrderRequestSchema`: the CLIENT sends the id.
 *
 * That is rule #6 and it looks odd until Step 4. A tablet with no connection
 * must still be able to open a bill and add lines, and those rows need ids
 * before the server has ever seen them. Generating the UUID on the tablet means
 * "open a bill" is the same operation online and offline, and syncing later is
 * an upsert rather than a renumbering exercise.
 *
 * Money never crosses this boundary as anything but integer satang.
 */

import { z } from 'zod';
import { modifierGroupDtoSchema, modifierIdsSchema } from './modifier.js';
import {
  nonNegativeSatangSchema,
  orderChannelSchema,
  orderLineSourceSchema,
  orderStatusSchema,
  paymentMethodSchema,
  satangSchema,
  uuidSchema,
} from './schemas.js';

/** Guards a fat finger on the qty stepper from ringing up 99 bowls. */
export const MAX_LINE_QTY = 99;

export const qtySchema = z
  .number()
  .int('จำนวนต้องเป็นจำนวนเต็ม')
  .min(1, 'จำนวนต้องอย่างน้อย 1')
  .max(MAX_LINE_QTY, `จำนวนต่อรายการต้องไม่เกิน ${MAX_LINE_QTY}`);

/**
 * How long a hand-typed note may be.
 *
 * 200 is what a 32-column kitchen slip can wrap without one bowl swallowing the
 * ticket. It is a cap, not an invitation: "เผ็ดน้อย" is the whole use case.
 */
export const MAX_ORDER_NOTE = 200;

/**
 * One stored shape for "no note".
 *
 * A cashier who opens the note box, thinks better of it and leaves a space
 * behind would otherwise store `" "` — which is not null, so the receipt prints
 * a bare `*` line and the kitchen slip grows a blank row telling nobody
 * anything. Trimmed to null here, once, on both sides of the wire.
 */
export function normalizeNote(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_ORDER_NOTE);
}

/**
 * Whether two lines carry the same instruction.
 *
 * This is half of "is it already on the bill" (see lineSignature for the other
 * half): two bowls that are identical apart from "เผ็ดน้อย" are two different
 * things to cook, and merging them would send the kitchen one instruction for
 * two customers.
 */
export function sameNote(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return normalizeNote(left) === normalizeNote(right);
}

export const orderNoteSchema = z
  .string()
  .max(MAX_ORDER_NOTE, `หมายเหตุยาวเกินไป (ไม่เกิน ${MAX_ORDER_NOTE} ตัวอักษร)`)
  .nullish()
  .transform(normalizeNote);

/* ---------------- requests ---------------- */

export const createOrderRequestSchema = z.object({
  /** Generated on the tablet (rule #6). */
  id: uuidSchema,
  /** Required for DINE_IN, must be absent for TAKEAWAY. Checked in the API. */
  tableId: uuidSchema.nullish(),
  channel: orderChannelSchema.default('DINE_IN'),
  note: orderNoteSchema,
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const addOrderLineRequestSchema = z.object({
  /** Also client-generated, for the same reason as the order id. */
  id: uuidSchema,
  menuItemId: uuidSchema,
  qty: qtySchema.default(1),
  note: orderNoteSchema,
  /**
   * Chosen options (Step 3).
   *
   * OMITTED and an EMPTY ARRAY mean different things on purpose:
   *  - omitted  → "give me the usual", and the server fills in the group
   *               defaults. That is the fast path for a caller that does not
   *               want to think about options at all.
   *  - []       → "I chose nothing", which fails validation if any group is
   *               required. A tablet always sends an explicit list.
   */
  modifierIds: modifierIdsSchema.optional(),
});
export type AddOrderLineRequest = z.infer<typeof addOrderLineRequestSchema>;

export const updateOrderLineRequestSchema = z.object({
  qty: qtySchema,
  note: orderNoteSchema,
  /**
   * Replaces the whole option set when present; leaves it alone when omitted.
   * "ลืมบอกว่าไม่ผัก" is the single most common correction at a noodle
   * counter, and it happens before the line is fired.
   */
  modifierIds: modifierIdsSchema.optional(),
});

/**
 * Paying a bill.
 *
 * `receivedSatang` is the cash actually handed over, so the till can show the
 * change and print it. It is required for CASH and meaningless for PROMPTPAY.
 */
export const payOrderRequestSchema = z
  .object({
    method: paymentMethodSchema,
    receivedSatang: nonNegativeSatangSchema.nullish(),
    /** Last digits / reference off the bank slip, typed by the cashier. */
    referenceNo: z.string().max(60).nullish(),
    /** 48 for 80mm paper, 32 for 58mm. */
    width: z.number().int().min(24).max(96).optional(),
    station: z.string().min(1).max(64).optional(),
  })
  .refine((value) => value.method !== 'CASH' || typeof value.receivedSatang === 'number', {
    message: 'ต้องระบุจำนวนเงินที่รับมาสำหรับการชำระด้วยเงินสด',
    path: ['receivedSatang'],
  });
export type PayOrderRequest = z.infer<typeof payOrderRequestSchema>;

/* ---------------- responses ---------------- */

export const orderLineModifierDtoSchema = z.object({
  id: uuidSchema,
  /** The Modifier this was chosen from — what the edit sheet re-selects and
   *  what the merge signature compares. `id` above is the snapshot row. */
  modifierId: uuidSchema,
  nameSnapshot: z.string(),
  priceDeltaSatang: satangSchema,
});

export const orderLineDtoSchema = z.object({
  id: uuidSchema,
  menuItemId: uuidSchema,
  nameSnapshot: z.string(),
  qty: z.number().int(),
  unitPriceSatang: satangSchema,
  /** Present only for roles with VIEW_COST — the API strips it for STAFF. */
  unitCostSatang: satangSchema.optional(),
  lineTotalSatang: satangSchema,
  note: z.string().nullable(),
  firedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  /** STAFF, or QR when the customer's phone put it there (Step 7). */
  source: orderLineSourceSchema,
  /**
   * When a member of staff let a QR line through. Meaningless on a STAFF line —
   * ringing it up IS the agreement — and left null there rather than stamped.
   *
   * Deriving "waiting" from `source === 'QR' && approvedAt === null` rather than
   * stamping every line is the fail-safe direction: a future code path that
   * forgets to set this can only leave a QR request waiting, never quietly drop
   * a bowl a cashier already rang up out of the bill total.
   */
  approvedAt: z.string().nullable(),
  modifiers: z.array(orderLineModifierDtoSchema),
});
export type OrderLineDto = z.infer<typeof orderLineDtoSchema>;

export const orderDtoSchema = z.object({
  id: uuidSchema,
  orderNo: z.string().nullable(),
  branchId: uuidSchema,
  tableId: uuidSchema.nullable(),
  tableName: z.string().nullable(),
  channel: orderChannelSchema,
  status: orderStatusSchema,
  businessDate: z.string(),
  openedAt: z.string(),
  paidAt: z.string().nullable(),
  note: z.string().nullable(),

  subtotalExVatSatang: satangSchema,
  vatRateBpSnapshot: z.number().int(),
  vatAmountSatang: satangSchema,
  totalSatang: satangSchema,
  /**
   * Money taken off this bill by a supervisor.
   *
   * DEFAULTED rather than required because a tablet that has been offline since
   * before this feature is holding mirrored bills that predate the field. Zero
   * is the honest reading for those: nothing was discounted.
   */
  discountSatang: satangSchema.default(0),
  /** VIEW_COST only. */
  costSatang: satangSchema.optional(),
  isVatInclusive: z.boolean(),
  receiptNo: z.string().nullable(),

  lines: z.array(orderLineDtoSchema),
});
export type OrderDto = z.infer<typeof orderDtoSchema>;

/** One open bill as it appears on a table card. */
export const tableBillDtoSchema = z.object({
  id: uuidSchema,
  orderNo: z.string().nullable(),
  totalSatang: satangSchema,
  lineCount: z.number().int(),
  openedAt: z.string(),
});
export type TableBillDto = z.infer<typeof tableBillDtoSchema>;

/** A table as drawn on the floor plan. */
export const tableDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  zone: z.string().nullable(),
  seats: z.number().int(),
  /**
   * The OLDEST open bill on this table, or null.
   *
   * Kept alongside `openOrders` rather than replaced by it, because a tablet
   * that has been offline since before bill splitting is drawing its floor plan
   * from a cached copy that only has this field. One bill per table was true
   * for that copy and is still the common case.
   */
  openOrder: tableBillDtoSchema.nullable(),
  /**
   * EVERY open bill on this table, oldest first (Step: แยกบิล).
   *
   * A table can carry more than one since splitting arrived — four people
   * paying separately are four bills at one table, which is what TableSession
   * has modelled since Step 0. `openOrder` is `openOrders[0]`.
   *
   * OPTIONAL for the same cached-tablet reason as `pendingApprovalCount`:
   * absent means "this device is too old to know", and the screen falls back to
   * the single bill rather than claiming the table has none.
   */
  openOrders: z.array(tableBillDtoSchema).optional(),
  /**
   * QR requests on this table that nobody has answered yet (Step 7).
   *
   * OPTIONAL because a tablet that has been offline since before this Step is
   * still drawing its floor plan from a cached copy that predates the field.
   * Absent means "this device does not know", which is the truth, and reads as
   * zero on screen — inventing a 0 in the schema would say "nobody is waiting".
   */
  pendingApprovalCount: z.number().int().nonnegative().optional(),
});
export type TableDto = z.infer<typeof tableDtoSchema>;

/**
 * Every open bill on a table, whatever vintage of floor plan this is.
 *
 * One function rather than `table.openOrders ?? []` scattered around, because
 * that particular fallback is wrong: a floor plan cached before bills could be
 * split has no `openOrders` and one perfectly good `openOrder`, and treating it
 * as an empty list would draw an occupied table as free — and the next
 * customer would be seated on top of somebody's dinner.
 */
export function billsOnTable(table: TableDto): TableBillDto[] {
  if (table.openOrders) return table.openOrders;
  return table.openOrder ? [table.openOrder] : [];
}

export const menuItemDtoSchema = z.object({
  id: uuidSchema,
  categoryId: uuidSchema,
  name: z.string(),
  subcategory: z.string().nullable(),
  priceSatang: satangSchema,
  /** VIEW_COST only. */
  costSatang: satangSchema.optional(),
  station: z.string().nullable(),
  isAvailable: z.boolean(),
  /** Option groups this item offers, in the order they should be shown.
   *  Empty for a drink — that is what makes the sheet skip itself. */
  groupIds: z.array(uuidSchema),
});
export type MenuItemDto = z.infer<typeof menuItemDtoSchema>;

export const menuCategoryDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  subcategories: z.array(z.string()),
  items: z.array(menuItemDtoSchema),
});
export type MenuCategoryDto = z.infer<typeof menuCategoryDtoSchema>;

/**
 * The whole menu in one response.
 *
 * Groups are sent ONCE at the top level and referenced by id, not embedded in
 * every item. The five noodle groups are shared by every bowl on the menu;
 * inlining them would repeat the same ~25 options per item and turn a small
 * payload into a large one on exactly the wifi that cannot be trusted.
 */
export const menuResponseSchema = z.object({
  categories: z.array(menuCategoryDtoSchema),
  modifierGroups: z.array(modifierGroupDtoSchema),
});
export type MenuResponse = z.infer<typeof menuResponseSchema>;

export const payOrderResponseSchema = z.object({
  order: orderDtoSchema,
  receiptNo: z.string(),
  changeSatang: satangSchema,
  /** Job id to poll, or null when the branch has no printer station wired up. */
  printJobId: uuidSchema.nullable(),
});
export type PayOrderResponse = z.infer<typeof payOrderResponseSchema>;

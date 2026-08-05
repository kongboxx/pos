/**
 * Zod schemas shared by the API (request validation) and the PWA (form
 * validation + IndexedDB row validation before it enters the sync queue).
 *
 * Step 0 only defines the primitives and the few objects the seed/health
 * endpoints need. Each later Step adds its own schemas here.
 */

import { z } from 'zod';
import {
  BusinessType,
  Nationality,
  OrderChannel,
  OrderLineSource,
  OrderStatus,
  PaidBy,
  PaymentMethod,
  Role,
  StaffStatus,
  TicketStatus,
  WageType,
} from './enums.js';

/* ---------- primitives ---------- */

/** Money. Integer satang only — a decimal input is a validation error, not a rounding opportunity. */
export const satangSchema = z
  .number()
  .int('จำนวนเงินต้องเป็นจำนวนเต็มหน่วยสตางค์')
  .safe()
  .describe('amount in satang, e.g. 6000 = 60.00 THB');

export const nonNegativeSatangSchema = satangSchema.min(0, 'จำนวนเงินต้องไม่ติดลบ');

export const uuidSchema = z.string().uuid('ต้องเป็น UUID v4');

export const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');

export const yearMonthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'รูปแบบเดือนต้องเป็น YYYY-MM');

/** VAT rate in basis points: 700 = 7%. */
export const vatRateBpSchema = z.number().int().min(0).max(10_000);

/** PIN is exactly 4 digits. Kept as a string so leading zeros survive. */
export const pinSchema = z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก');

export const branchCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,8}$/, 'รหัสสาขาต้องเป็นตัวอักษร/ตัวเลข 1-8 ตัว');

/**
 * "Move this one step up / down."
 *
 * Every list a shop arranges by hand — tables, menu categories, dishes — is
 * reordered by nudging one row past its neighbour, and the SERVER does the
 * renumbering. The client never posts a sortOrder: two rows sharing a number
 * fall back to sorting by name, so a form that guessed one would sometimes
 * move a row nowhere visible.
 */
export const moveRequestSchema = z.object({ direction: z.enum(['UP', 'DOWN']) });
export type MoveRequest = z.infer<typeof moveRequestSchema>;
export type MoveDirection = MoveRequest['direction'];

/* ---------- enums ---------- */

export const businessTypeSchema = z.nativeEnum(BusinessType);
export const roleSchema = z.nativeEnum(Role);
export const staffStatusSchema = z.nativeEnum(StaffStatus);
export const nationalitySchema = z.nativeEnum(Nationality);
export const wageTypeSchema = z.nativeEnum(WageType);
export const orderStatusSchema = z.nativeEnum(OrderStatus);
export const orderChannelSchema = z.nativeEnum(OrderChannel);
export const orderLineSourceSchema = z.nativeEnum(OrderLineSource);
export const ticketStatusSchema = z.nativeEnum(TicketStatus);
export const paymentMethodSchema = z.nativeEnum(PaymentMethod);
export const paidBySchema = z.nativeEnum(PaidBy);

/* ---------- objects ---------- */

/** The VAT settings a branch carries. Mirrors the Branch columns. */
export const vatConfigSchema = z.object({
  enabled: z.boolean(),
  rateBp: vatRateBpSchema,
  priceIncludesVat: z.boolean(),
});

export const branchPublicSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  branchCode: branchCodeSchema,
  businessType: businessTypeSchema,
  timezone: z.string().min(1),
  dayCutoffHour: z.number().int().min(0).max(23),
  vatEnabled: z.boolean(),
  vatRateBp: vatRateBpSchema,
  priceIncludesVat: z.boolean(),
});
export type BranchPublic = z.infer<typeof branchPublicSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const dbHealthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().nonnegative(),
  branchCount: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
export type DbHealthResponse = z.infer<typeof dbHealthResponseSchema>;

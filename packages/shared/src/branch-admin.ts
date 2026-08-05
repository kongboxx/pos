/**
 * Branch settings and the VAT switch (Step 10).
 *
 * TWO THINGS IN HERE ARE LOAD-BEARING; the rest is a form.
 *
 * 1. VAT IS DECIDED BY THE BILL'S BUSINESS DATE, NOT BY THE SWITCH'S CURRENT
 *    POSITION. `vatEffectiveDate` is the date the registration takes effect,
 *    and a bill from before it must stay non-VAT forever. Without the date the
 *    switch would be retroactive: flip it on 1 October and every reprint,
 *    every report and every re-total of September's bills suddenly claims the
 *    shop collected VAT it never collected and never remitted. The Revenue
 *    Department reads that as tax owed.
 *
 *    The snapshot on the order (rule #3) is what protects bills already paid.
 *    This protects everything that has to be RECOMPUTED — an open bill, a
 *    reprint, a report that sums per-day.
 *
 * 2. THE BRANCH CODE IS PART OF EVERY DOCUMENT NUMBER (rule #9). Once one
 *    document exists, the code is frozen: `TX-HQ-2026-000001` and
 *    `TX-MAIN-2026-000002` are the same sequence wearing two names, and an
 *    auditor who asks for "the tax invoice series for this branch" gets an
 *    answer that does not add up. Renaming the branch is always allowed —
 *    the NAME is decoration on a slip, the CODE is an identifier.
 */

import { z } from 'zod';
import type { BusinessDate } from './business-date.js';
import {
  branchCodeSchema,
  businessDateSchema,
  businessTypeSchema,
  nonNegativeSatangSchema,
  pinSchema,
  uuidSchema,
  vatRateBpSchema,
} from './schemas.js';
import type { VatConfig } from './vat.js';

/* ------------------------------------------------------------------ */
/* Thai tax id                                                         */
/* ------------------------------------------------------------------ */

export const THAI_TAX_ID_LENGTH = 13;

/** Strips the spaces and dashes people type off a tax id. */
export function normalizeTaxId(value: string): string {
  return value.replace(/[\s-]/g, '');
}

/**
 * The 13-digit เลขประจำตัวผู้เสียภาษี check digit.
 *
 * Worth doing rather than counting to 13: a tax invoice carrying a customer
 * tax id that is one digit off is not a small mistake. The buyer cannot claim
 * the input VAT, and the seller — this shop — is the one who has to reissue
 * the document and explain it. Catching it while the customer is still
 * standing at the counter costs nothing.
 *
 * The rule: sum digit[i] * (13 - i) for the first 12, then the check digit is
 * (11 - (sum mod 11)) mod 10.
 */
export function isValidThaiTaxId(value: string): boolean {
  const digits = normalizeTaxId(value);
  if (!/^\d{13}$/.test(digits)) return false;

  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(digits[index]) * (13 - index);
  }
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

/** `1234567890123` -> `1-2345-67890-12-3`, the grouping printed on Thai invoices. */
export function formatTaxId(value: string): string {
  const digits = normalizeTaxId(value);
  if (!/^\d{13}$/.test(digits)) return value;
  return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}

export const taxIdSchema = z
  .string()
  .transform(normalizeTaxId)
  .refine(
    isValidThaiTaxId,
    'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ต้องเป็นตัวเลข 13 หลักและหลักตรวจสอบถูกต้อง)',
  );

/**
 * What goes in the "สาขา" line of a customer's address on a full tax invoice.
 *
 * A company that is not itself branched writes สำนักงานใหญ่, and this is the
 * default because it is right for almost every customer a noodle shop bills.
 * It is a free string rather than a number because a customer occasionally
 * gives "สาขาที่ 00002" and the shop's job is to copy it down, not to parse it.
 */
export const HEAD_OFFICE_LABEL = 'สำนักงานใหญ่';

/* ------------------------------------------------------------------ */
/* VAT, resolved for a date                                            */
/* ------------------------------------------------------------------ */

/** The VAT columns of a branch, as both Prisma and the PWA carry them. */
export interface BranchVatSettings {
  vatEnabled: boolean;
  vatRateBp: number;
  priceIncludesVat: boolean;
  /** YYYY-MM-DD, or null when the switch has no start date yet. */
  vatEffectiveDate?: BusinessDate | null;
}

/**
 * The VAT config that applies to a bill trading on `businessDate`.
 *
 * A null effective date means "from the beginning" — flipping the switch with
 * no date set is a decision the owner made explicitly on the settings screen,
 * where the consequence is spelled out.
 */
export function vatConfigForDate(branch: BranchVatSettings, businessDate: BusinessDate): VatConfig {
  const started = !branch.vatEffectiveDate || businessDate >= branch.vatEffectiveDate;
  return {
    enabled: branch.vatEnabled && started,
    rateBp: branch.vatEnabled && started ? branch.vatRateBp : 0,
    priceIncludesVat: branch.priceIncludesVat,
  };
}

/** true when the switch is on but has not reached its start date yet. */
export function vatIsPending(branch: BranchVatSettings, today: BusinessDate): boolean {
  return branch.vatEnabled && !!branch.vatEffectiveDate && today < branch.vatEffectiveDate;
}

/* ------------------------------------------------------------------ */
/* branch settings                                                     */
/* ------------------------------------------------------------------ */

const trimmedOptional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/**
 * Everything an owner may change about a branch.
 *
 * branchCode is NOT here: it is set once when the branch is created and frozen
 * the moment a document carries it (see the header). Nor is `id`, for the
 * usual reason — the target of an update comes from the URL, never the body.
 */
export const branchSettingsSchema = z
  .object({
    name: z.string().trim().min(1, 'ต้องมีชื่อสาขา').max(80),
    businessType: businessTypeSchema,
    address: trimmedOptional(300),
    phone: trimmedOptional(30),
    /** The SHOP's own tax id. Optional while the shop is not registered. */
    taxId: z
      .string()
      .trim()
      .nullish()
      .transform((value) => (value ? normalizeTaxId(value) : null))
      .refine(
        (value) => value === null || isValidThaiTaxId(value),
        'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง',
      ),

    timezone: z.string().trim().min(1).max(64),
    dayCutoffHour: z.number().int().min(0).max(23),

    vatEnabled: z.boolean(),
    vatRateBp: vatRateBpSchema,
    priceIncludesVat: z.boolean(),
    vatEffectiveDate: businessDateSchema.nullish().transform((value) => value ?? null),

    rentPerMonthSatang: nonNegativeSatangSchema,
    promptPayId: trimmedOptional(40),
    qrOrderingEnabled: z.boolean(),
    isActive: z.boolean(),
  })
  /**
   * VAT on at 0% is the one combination that looks fine and is not. Every
   * total comes out identical to VAT-off, the receipt title flips to
   * "ใบกำกับภาษีอย่างย่อ", and the shop is now handing customers tax documents
   * claiming 0 baht of VAT on a 7% sale.
   */
  .refine((value) => !value.vatEnabled || value.vatRateBp > 0, {
    path: ['vatRateBp'],
    message: 'เปิด VAT แล้วต้องใส่อัตราภาษี (ปกติ 7%)',
  })
  /** A registered shop must print its own tax id — a slip without one is not a tax document. */
  .refine((value) => !value.vatEnabled || !!value.taxId, {
    path: ['taxId'],
    message: 'เปิด VAT แล้วต้องกรอกเลขประจำตัวผู้เสียภาษีของร้าน',
  });
export type BranchSettingsRequest = z.infer<typeof branchSettingsSchema>;

/**
 * Creating a branch also creates the person who can log into it.
 *
 * A branch with no staff cannot be opened by anybody: the login screen lists
 * that branch's staff, and an empty list is a dead end that only a database
 * edit gets out of. So the first owner is part of the same form and the same
 * transaction.
 */
export const branchCreateSchema = z.object({
  name: z.string().trim().min(1, 'ต้องมีชื่อสาขา').max(80),
  branchCode: branchCodeSchema,
  businessType: businessTypeSchema,
  timezone: z.string().trim().min(1).max(64).default('Asia/Bangkok'),
  dayCutoffHour: z.number().int().min(0).max(23).default(4),
  ownerFullName: z.string().trim().min(1, 'ต้องมีชื่อผู้ดูแลสาขา').max(80),
  ownerNickname: trimmedOptional(40),
  ownerPin: pinSchema,
});
export type BranchCreateRequest = z.infer<typeof branchCreateSchema>;

export const branchDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  branchCode: branchCodeSchema,
  businessType: businessTypeSchema,
  address: z.string().nullable(),
  phone: z.string().nullable(),
  taxId: z.string().nullable(),

  timezone: z.string(),
  dayCutoffHour: z.number().int(),

  vatEnabled: z.boolean(),
  vatRateBp: vatRateBpSchema,
  priceIncludesVat: z.boolean(),
  vatEffectiveDate: businessDateSchema.nullable(),

  rentPerMonthSatang: nonNegativeSatangSchema,
  promptPayId: z.string().nullable(),
  qrOrderingEnabled: z.boolean(),
  isActive: z.boolean(),

  /** Staff who can still log in. A branch that drops to 0 cannot be opened. */
  activeStaffCount: z.number().int().nonnegative(),
  /**
   * true once any document number has been handed out for this branch, which
   * is what freezes `branchCode`. Sent so the screen can grey the field with a
   * reason instead of letting the owner type and then rejecting the save.
   */
  hasDocuments: z.boolean(),
});
export type BranchDto = z.infer<typeof branchDtoSchema>;

export const branchListResponseSchema = z.object({
  /** The branch this session belongs to. The rest are read-only from here. */
  currentBranchId: uuidSchema,
  today: businessDateSchema,
  branches: z.array(branchDtoSchema),
});
export type BranchListResponse = z.infer<typeof branchListResponseSchema>;

/** The login screen's branch picker. Holds no secret — it is a list of shop names. */
export const branchChoiceSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  branchCode: branchCodeSchema,
});
export type BranchChoice = z.infer<typeof branchChoiceSchema>;

export const branchChoiceListSchema = z.object({ branches: z.array(branchChoiceSchema) });
export type BranchChoiceList = z.infer<typeof branchChoiceListSchema>;

/* ------------------------------------------------------------------ */
/* every branch at once                                                */
/* ------------------------------------------------------------------ */

/**
 * One line of the owner's "how did all the shops do today" screen.
 *
 * Deliberately thin. The owner standing in branch 2 wants to know whether
 * branch 1 is having a normal day — takings, bills, average, what is still
 * open. Anything more belongs on that branch's own report, which is a login
 * away and correctly scoped by rule #1.
 */
export const branchSalesRowSchema = z.object({
  branchId: uuidSchema,
  branchName: z.string(),
  branchCode: branchCodeSchema,
  isCurrent: z.boolean(),

  paidOrderCount: z.number().int().nonnegative(),
  netSalesSatang: nonNegativeSatangSchema,
  vatSatang: nonNegativeSatangSchema,
  averageBillSatang: nonNegativeSatangSchema.nullable(),
  openOrderCount: z.number().int().nonnegative(),
  openOrderTotalSatang: nonNegativeSatangSchema,
  /** Credit notes ISSUED on this date — money handed back, whenever it was taken. */
  creditNoteCount: z.number().int().nonnegative(),
  creditNoteSatang: nonNegativeSatangSchema,
});
export type BranchSalesRow = z.infer<typeof branchSalesRowSchema>;

export const allBranchesResponseSchema = z.object({
  businessDate: businessDateSchema,
  rows: z.array(branchSalesRowSchema),
  totalPaidOrderCount: z.number().int().nonnegative(),
  totalNetSalesSatang: nonNegativeSatangSchema,
});
export type AllBranchesResponse = z.infer<typeof allBranchesResponseSchema>;

export const allBranchesQuerySchema = z.object({ date: businessDateSchema });

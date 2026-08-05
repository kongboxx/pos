/**
 * Full tax invoice and credit note (Step 10).
 *
 * WHY THESE TWO DOCUMENTS EXIST TOGETHER AND NOT ONE WITHOUT THE OTHER.
 *
 * Every bill already prints a ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ — the abbreviated
 * tax invoice, which is what a walk-in customer gets and all a noodle shop
 * normally issues. A ใบกำกับภาษีเต็มรูป is different: it names the buyer and
 * their tax id, and it is the document the buyer uses to claim the input VAT
 * back. That is what makes it dangerous. Once it is out of the printer the
 * shop cannot take it back, cannot edit it, and cannot delete the sale
 * (project rule: ห้ามลบบิลที่ออกใบกำกับภาษีแล้ว — ต้องออกใบลดหนี้แทน).
 *
 * So the ONLY way to undo it is a ใบลดหนี้ — a credit note, its own numbered
 * document, referencing the tax invoice it reverses and carrying a reason.
 * Shipping the tax invoice without the credit note would hand the shop a
 * document it can create and then has no legal way to correct, and the way
 * that ends is someone editing the database.
 *
 * ONLINE ONLY, both of them (rule #9). An offline tablet must never allocate
 * either number — two tablets would hand the same number to two customers, and
 * unlike a duplicated receipt number that is a duplicated tax document.
 */

import { z } from 'zod';
import { businessDateSchema, nonNegativeSatangSchema, pinSchema, uuidSchema } from './schemas.js';
import { HEAD_OFFICE_LABEL, taxIdSchema } from './branch-admin.js';

/* ------------------------------------------------------------------ */
/* full tax invoice                                                    */
/* ------------------------------------------------------------------ */

export const taxInvoiceRequestSchema = z.object({
  /** The buyer as they want it printed — a company name, not the person paying. */
  customerName: z.string().trim().min(1, 'ต้องกรอกชื่อผู้ซื้อ').max(200),
  customerTaxId: taxIdSchema,
  customerAddress: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((value) => (value ? value : null)),
  /**
   * "สำนักงานใหญ่" or "สาขาที่ 00002". Required on a full tax invoice since the
   * 2015 rules; defaulted rather than asked, because it is สำนักงานใหญ่ for
   * almost every customer and a required field nobody understands is a field
   * that gets filled with anything.
   */
  customerBranchLabel: z
    .string()
    .trim()
    .max(60)
    .default(HEAD_OFFICE_LABEL)
    .transform((value) => (value ? value : HEAD_OFFICE_LABEL)),
  width: z.number().int().positive().max(96).optional(),
  station: z.string().min(1).max(40).optional(),
});
export type TaxInvoiceRequest = z.infer<typeof taxInvoiceRequestSchema>;

export const taxInvoiceDtoSchema = z.object({
  orderId: uuidSchema,
  taxInvoiceNo: z.string(),
  receiptNo: z.string().nullable(),
  issuedAt: z.string(),
  customerName: z.string(),
  customerTaxId: z.string(),
  customerAddress: z.string().nullable(),
  customerBranchLabel: z.string(),

  businessDate: businessDateSchema,
  subtotalExVatSatang: nonNegativeSatangSchema,
  vatAmountSatang: nonNegativeSatangSchema,
  vatRateBpSnapshot: z.number().int().nonnegative(),
  totalSatang: nonNegativeSatangSchema,
});
export type TaxInvoiceDto = z.infer<typeof taxInvoiceDtoSchema>;

export const taxInvoiceResponseSchema = z.object({
  taxInvoice: taxInvoiceDtoSchema,
  printJobId: z.string().nullable(),
});
export type TaxInvoiceResponse = z.infer<typeof taxInvoiceResponseSchema>;

/* ------------------------------------------------------------------ */
/* credit note                                                         */
/* ------------------------------------------------------------------ */

export const CreditNoteReason = {
  WRONG_BILL: 'WRONG_BILL',
  WRONG_CUSTOMER: 'WRONG_CUSTOMER',
  RETURNED: 'RETURNED',
  OVERCHARGED: 'OVERCHARGED',
  OTHER: 'OTHER',
} as const;
export type CreditNoteReason = (typeof CreditNoteReason)[keyof typeof CreditNoteReason];

export interface CreditNoteReasonInfo {
  key: CreditNoteReason;
  label: string;
  hint: string;
}

export const CREDIT_NOTE_REASONS: readonly CreditNoteReasonInfo[] = [
  { key: CreditNoteReason.WRONG_BILL, label: 'คิดเงินผิดบิล', hint: 'กดรับเงินผิดโต๊ะหรือผิดใบ' },
  {
    key: CreditNoteReason.WRONG_CUSTOMER,
    label: 'ออกใบผิดชื่อลูกค้า',
    hint: 'ชื่อหรือเลขผู้เสียภาษีผิด ต้องออกใบใหม่',
  },
  { key: CreditNoteReason.RETURNED, label: 'ลูกค้าคืนของ/ยกเลิก', hint: 'คืนเงินให้ลูกค้าไปแล้ว' },
  { key: CreditNoteReason.OVERCHARGED, label: 'เก็บเงินเกิน', hint: 'ยอดที่เก็บมากกว่าที่ควรเป็น' },
  { key: CreditNoteReason.OTHER, label: 'อื่น ๆ', hint: 'พิมพ์เหตุผลเอง' },
];

export function creditNoteReasonLabel(value: string): string {
  return CREDIT_NOTE_REASONS.find((reason) => reason.key === value)?.label ?? value;
}

/**
 * Cancelling a completed sale needs a supervisor at the terminal, exactly like
 * a void (rule #8) — same approval, same lockout, same "not yourself" rule.
 * This is strictly bigger than voiding one line: it takes a whole bill, and a
 * tax document, back out of the day.
 */
export const creditNoteRequestSchema = z.object({
  reason: z.nativeEnum(CreditNoteReason),
  /** Free text. Required for OTHER, welcome on the rest. */
  note: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((value) => (value ? value : null)),
  approverStaffId: uuidSchema,
  approverPin: pinSchema,
  width: z.number().int().positive().max(96).optional(),
  station: z.string().min(1).max(40).optional(),
});
export type CreditNoteRequest = z.infer<typeof creditNoteRequestSchema>;

export const creditNoteDtoSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  creditNoteNo: z.string(),
  /** The document being reversed. Null when the bill only ever had a receipt. */
  taxInvoiceNo: z.string().nullable(),
  receiptNo: z.string().nullable(),
  /** The trading day the CREDIT NOTE was issued, not the day of the sale. */
  businessDate: businessDateSchema,
  /** The trading day the money was originally taken. */
  originalBusinessDate: businessDateSchema,

  subtotalExVatSatang: nonNegativeSatangSchema,
  vatAmountSatang: nonNegativeSatangSchema,
  totalSatang: nonNegativeSatangSchema,

  reason: z.string(),
  note: z.string().nullable(),
  issuedByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  issuedAt: z.string(),
});
export type CreditNoteDto = z.infer<typeof creditNoteDtoSchema>;

export const creditNoteResponseSchema = z.object({
  creditNote: creditNoteDtoSchema,
  printJobId: z.string().nullable(),
});
export type CreditNoteResponse = z.infer<typeof creditNoteResponseSchema>;

/* ------------------------------------------------------------------ */
/* the day's closed bills                                              */
/* ------------------------------------------------------------------ */

/**
 * One row of "บิลวันนี้".
 *
 * This screen exists for one sentence a customer says a minute after paying:
 * "ขอใบกำกับภาษีด้วยครับ". Before Step 10 a paid bill was unreachable — the
 * table had been cleared and the order screen only knows open bills — so the
 * only place a tax invoice could be issued from was a bill still on the table.
 */
export const paidBillRowSchema = z.object({
  id: uuidSchema,
  orderNo: z.string().nullable(),
  receiptNo: z.string().nullable(),
  tableName: z.string().nullable(),
  channel: z.string(),
  paidAt: z.string().nullable(),
  status: z.string(),

  totalSatang: nonNegativeSatangSchema,
  vatAmountSatang: nonNegativeSatangSchema,
  vatRateBpSnapshot: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),

  taxInvoiceNo: z.string().nullable(),
  customerName: z.string().nullable(),
  creditNoteNo: z.string().nullable(),
});
export type PaidBillRow = z.infer<typeof paidBillRowSchema>;

export const paidBillListResponseSchema = z.object({
  businessDate: businessDateSchema,
  /** Whether a tax invoice can be issued at all today — VAT off means no. */
  vatActive: z.boolean(),
  rows: z.array(paidBillRowSchema),
});
export type PaidBillListResponse = z.infer<typeof paidBillListResponseSchema>;

export const paidBillQuerySchema = z.object({ date: businessDateSchema });

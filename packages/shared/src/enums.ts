/**
 * Enum values shared by the API, the PWA and the print agent.
 *
 * These are plain const objects, not TypeScript `enum`, so the exact same
 * literal strings can be used in Prisma, in zod schemas and in IndexedDB rows
 * without a conversion layer. The names match the Prisma enums 1:1.
 */

export const BusinessType = {
  RESTAURANT: 'RESTAURANT',
  RETAIL: 'RETAIL',
} as const;
export type BusinessType = (typeof BusinessType)[keyof typeof BusinessType];

export const Role = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const StaffStatus = {
  ACTIVE: 'ACTIVE',
  PROBATION: 'PROBATION',
  LEAVE: 'LEAVE',
  LEFT: 'LEFT',
} as const;
export type StaffStatus = (typeof StaffStatus)[keyof typeof StaffStatus];

export const Nationality = {
  TH: 'TH',
  FOREIGN: 'FOREIGN',
} as const;
export type Nationality = (typeof Nationality)[keyof typeof Nationality];

export const WageType = {
  DAILY: 'DAILY',
  MONTHLY: 'MONTHLY',
} as const;
export type WageType = (typeof WageType)[keyof typeof WageType];

export const OrderStatus = {
  OPEN: 'OPEN',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderChannel = {
  DINE_IN: 'DINE_IN',
  TAKEAWAY: 'TAKEAWAY',
  DELIVERY: 'DELIVERY',
} as const;
export type OrderChannel = (typeof OrderChannel)[keyof typeof OrderChannel];

/**
 * How a bill is described on a slip and on the kitchen screen.
 *
 * Here rather than next to whichever screen needed it first, because the
 * receipt, the kitchen ticket and the till must all call the same thing by the
 * same name — a cook reading "กลับบ้าน" and a customer reading "ซื้อกลับ" on
 * the same order is a small thing that costs a conversation every time.
 */
export const CHANNEL_LABEL: Readonly<Record<OrderChannel, string>> = {
  DINE_IN: 'ทานที่ร้าน',
  TAKEAWAY: 'กลับบ้าน',
  DELIVERY: 'เดลิเวอรี',
};

export const OrderLineSource = {
  STAFF: 'STAFF',
  QR: 'QR',
} as const;
export type OrderLineSource = (typeof OrderLineSource)[keyof typeof OrderLineSource];

export const TicketStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const PaymentMethod = {
  CASH: 'CASH',
  PROMPTPAY: 'PROMPTPAY',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/**
 * Here for the same reason CHANNEL_LABEL is: the receipt in the customer's
 * hand and the closing report the owner reads at 21:00 have to call the same
 * money by the same name. It lived inside receipt.ts until Step 8 needed it
 * too, and a second copy would have drifted the first time one was reworded.
 */
export const PAYMENT_METHOD_LABEL: Readonly<Record<PaymentMethod, string>> = {
  CASH: 'เงินสด',
  PROMPTPAY: 'พร้อมเพย์',
};

export const PaidBy = {
  CASH: 'CASH',
  TRANSFER: 'TRANSFER',
} as const;
export type PaidBy = (typeof PaidBy)[keyof typeof PaidBy];

export const DocType = {
  /** ใบเสร็จรับเงินอย่างย่อ — may be issued offline. */
  RECEIPT: 'RECEIPT',
  /** ใบกำกับภาษีเต็มรูป — ONLINE ONLY (project rule #9). */
  TAX_INVOICE: 'TAX_INVOICE',
  /** ใบลดหนี้ — the only legal way to reverse an issued tax invoice (rule: never delete). */
  CREDIT_NOTE: 'CREDIT_NOTE',
} as const;
export type DocType = (typeof DocType)[keyof typeof DocType];

export const StockMovementType = {
  RECEIVE: 'RECEIVE',
  SALE: 'SALE',
  WASTE: 'WASTE',
  TRANSFER: 'TRANSFER',
  COUNT: 'COUNT',
} as const;
export type StockMovementType = (typeof StockMovementType)[keyof typeof StockMovementType];

/** Document types that must never be produced by an offline device. */
export const ONLINE_ONLY_DOC_TYPES: readonly DocType[] = [DocType.TAX_INVOICE, DocType.CREDIT_NOTE];

export function isOnlineOnlyDocType(docType: DocType): boolean {
  return ONLINE_ONLY_DOC_TYPES.includes(docType);
}

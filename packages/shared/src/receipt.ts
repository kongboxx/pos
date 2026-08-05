/**
 * Receipt documents.
 *
 * A receipt is described as DATA (a list of blocks), never as printer
 * commands. Three things depend on that:
 *
 *  1. the API can queue a receipt as JSON and the agent prints it later,
 *     even after a restart — the job survives because it is just data;
 *  2. the layout can be rendered to plain text and asserted in a unit test,
 *     so the columns are proven correct without a printer in the room;
 *  3. the same document can be re-rendered to a different width (58mm vs
 *     80mm) or to a PDF later, without touching the template.
 *
 * All widths are measured with thaiWidth() (see thai-text.ts) — never .length.
 */

import { formatTaxId } from './branch-admin.js';
import { PAYMENT_METHOD_LABEL, PaymentMethod } from './enums.js';
import { formatSatang, type Satang } from './money.js';
import { formatRateBp } from './vat.js';
import {
  leftRight,
  padThai,
  repeatToWidth,
  thaiWidth,
  truncateThai,
  wrapThai,
} from './thai-text.js';

/** Printable columns. 80mm Font A is 48; 58mm is 32. */
export const WIDTH_80MM = 48;
export const WIDTH_58MM = 32;

export type BlockAlign = 'left' | 'center' | 'right';
export type TextSize = 'normal' | 'wide' | 'tall' | 'large';

export type ReceiptBlock =
  | { type: 'text'; text: string; align?: BlockAlign; bold?: boolean; size?: TextSize }
  /** label on the left, value hard against the right edge */
  | { type: 'row'; left: string; right: string; bold?: boolean }
  /** an order line: qty, name, amount, plus indented modifiers and a note */
  | {
      type: 'item';
      qty: number;
      name: string;
      amountSatang: Satang;
      modifiers?: readonly string[];
      note?: string;
    }
  | { type: 'divider'; char?: string }
  | { type: 'blank'; lines?: number }
  | { type: 'qr'; data: string; caption?: string }
  /** Kick the cash drawer. Ignored by the text renderer. */
  | { type: 'openDrawer' }
  | { type: 'cut' };

export interface ReceiptDoc {
  /** Printable columns this document was laid out for. */
  width: number;
  blocks: readonly ReceiptBlock[];
}

/* ------------------------------------------------------------------ */
/* Text renderer — used by tests and by the on-screen preview          */
/* ------------------------------------------------------------------ */

/**
 * Renders a document to plain text lines, each EXACTLY `doc.width` cells wide
 * (measured in printer cells, so Thai lines look short in a code editor but
 * are correct on paper).
 *
 * This is the reference layout. The ESC/POS renderer in the print agent
 * produces the same lines and hands them to the printer, so what a test
 * asserts here is what comes out of the machine.
 */
export function renderReceiptText(doc: ReceiptDoc): string[] {
  const lines: string[] = [];
  const { width } = doc;

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'text': {
        for (const line of wrapThai(block.text, width)) {
          lines.push(padThai(line, width, block.align ?? 'left'));
        }
        break;
      }
      case 'row':
        lines.push(leftRight(block.left, block.right, width));
        break;
      case 'item':
        lines.push(...renderItem(block, width));
        break;
      case 'divider':
        lines.push(repeatToWidth(block.char ?? '-', width));
        break;
      case 'blank':
        for (let i = 0; i < (block.lines ?? 1); i += 1) lines.push(' '.repeat(width));
        break;
      case 'qr':
        // The text preview cannot draw a QR; show what it encodes instead.
        lines.push(padThai('[QR]', width, 'center'));
        if (block.caption) lines.push(padThai(block.caption, width, 'center'));
        break;
      case 'openDrawer':
      case 'cut':
        // Physical actions with no printed output.
        break;
    }
  }

  return lines;
}

/**
 * One order line.
 *
 *   2  ก๋วยเตี๋ยวหมู                          120.00
 *      เส้นเล็ก · น้ำตก · พิเศษ
 *      * ไม่ผัก เผ็ดน้อย
 *
 * The amount column is fixed, so every row's price ends in the same cell.
 * A long name wraps under itself rather than pushing the price off the paper.
 */
function renderItem(block: Extract<ReceiptBlock, { type: 'item' }>, width: number): string[] {
  const amount = formatSatang(block.amountSatang);
  const qtyText = padThai(String(block.qty), 3, 'left');
  const amountWidth = Math.max(thaiWidth(amount), 8);
  const nameWidth = width - thaiWidth(qtyText) - amountWidth;

  const nameLines = wrapThai(block.name, nameWidth);
  const [firstName, ...restNames] = nameLines;

  const lines: string[] = [
    qtyText + padThai(firstName ?? '', nameWidth) + padThai(amount, amountWidth, 'right'),
  ];

  const indent = ' '.repeat(3);
  for (const line of restNames) {
    lines.push(padThai(indent + line, width));
  }

  if (block.modifiers && block.modifiers.length > 0) {
    for (const line of wrapThai(block.modifiers.join(' · '), width - 3)) {
      lines.push(padThai(indent + line, width));
    }
  }

  if (block.note) {
    for (const line of wrapThai(`* ${block.note}`, width - 3)) {
      lines.push(padThai(indent + line, width));
    }
  }

  return lines;
}

/** Joins rendered lines with trailing spaces stripped — handy for snapshots. */
export function receiptTextPreview(doc: ReceiptDoc): string {
  return renderReceiptText(doc)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface ShopHeader {
  name: string;
  address?: string | null;
  phone?: string | null;
  taxId?: string | null;
  branchCode: string;
}

export interface ReceiptTotals {
  subtotalExVatSatang: Satang;
  vatAmountSatang: Satang;
  vatRateBpSnapshot: number;
  totalSatang: Satang;
  isVatInclusive: boolean;
  /**
   * The bill before the discount, and the discount itself.
   *
   * Both OPTIONAL so every existing caller and the test slip keep working, and
   * both only printed when there IS a discount. A shop that never discounts
   * should not have a "ส่วนลด 0.00" line inviting customers to ask for one.
   */
  grossSatang?: Satang;
  discountSatang?: Satang;
}

export interface TestReceiptInput {
  shop: ShopHeader;
  /** When the test print was requested. Printed so a stack of test slips is orderable. */
  printedAt: Date;
  /** Who pressed the button, when known. */
  requestedBy?: string;
  width?: number;
  /** Set false to test printing without banging the drawer open. */
  openDrawer?: boolean;
}

/**
 * The Step 1 test receipt.
 *
 * It deliberately exercises every hard part of the real template at once:
 * double-height header, Thai item names with tone marks, a modifier line, a
 * long name that must wrap, a right-aligned money column, the VAT block in
 * its not-registered state, a QR code, the drawer kick and the cut.
 *
 * If this slip comes out straight, the receipt work in Step 2 is layout, not
 * discovery.
 *
 * It carries NO document number: numbers come from DocSequence and belong to
 * real bills (rule #9). A test slip is not a receipt.
 */
export function buildTestReceipt(input: TestReceiptInput): ReceiptDoc {
  const width = input.width ?? WIDTH_80MM;
  const { shop } = input;

  const items: ReceiptBlock[] = [
    {
      type: 'item',
      qty: 2,
      name: 'ก๋วยเตี๋ยวหมูน้ำตก',
      amountSatang: 12000,
      modifiers: ['เส้นเล็ก', 'พิเศษ'],
    },
    {
      type: 'item',
      qty: 1,
      name: 'ก๋วยเตี๋ยวเนื้อตุ๋นหม้อไฟรวมมิตรพิเศษ',
      amountSatang: 8500,
      modifiers: ['บะหมี่', 'ต้มยำ'],
      note: 'ไม่ผัก เผ็ดน้อย',
    },
    { type: 'item', qty: 3, name: 'น้ำเปล่า', amountSatang: 3000 },
  ];

  const totals: ReceiptTotals = {
    subtotalExVatSatang: 23500,
    vatAmountSatang: 0,
    vatRateBpSnapshot: 0,
    totalSatang: 23500,
    isVatInclusive: true,
  };

  return {
    width,
    blocks: [
      ...headerBlocks(shop, width),
      { type: 'text', text: '*** ใบทดสอบเครื่องพิมพ์ ***', align: 'center', bold: true },
      { type: 'text', text: 'ไม่ใช่ใบเสร็จรับเงิน', align: 'center' },
      { type: 'blank' },
      { type: 'row', left: 'เวลา', right: formatThaiDateTime(input.printedAt) },
      ...(input.requestedBy
        ? [{ type: 'row' as const, left: 'ผู้ทดสอบ', right: input.requestedBy }]
        : []),
      { type: 'divider' },
      ...items,
      { type: 'divider' },
      ...totalsBlocks(totals),
      { type: 'blank' },
      { type: 'qr', data: 'https://example.invalid/pos/test', caption: 'ทดสอบพิมพ์ QR' },
      { type: 'blank' },
      { type: 'text', text: 'ถ้าอ่านบรรทัดนี้ออกครบ แปลว่าภาษาไทยพิมพ์ได้', align: 'center' },
      { type: 'text', text: 'ตัวเลขและคอลัมน์ราคาต้องตรงกันทุกบรรทัด', align: 'center' },
      { type: 'blank', lines: 2 },
      ...(input.openDrawer === false ? [] : [{ type: 'openDrawer' as const }]),
      { type: 'cut' },
    ],
  };
}

function headerBlocks(shop: ShopHeader, width: number): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [
    { type: 'text', text: shop.name, align: 'center', bold: true, size: 'large' },
  ];
  if (shop.address) blocks.push({ type: 'text', text: shop.address, align: 'center' });
  if (shop.phone) blocks.push({ type: 'text', text: `โทร. ${shop.phone}`, align: 'center' });
  if (shop.taxId) {
    blocks.push({ type: 'text', text: `เลขประจำตัวผู้เสียภาษี ${shop.taxId}`, align: 'center' });
  }
  blocks.push({
    type: 'text',
    text: `สาขา ${truncateThai(shop.branchCode, width)}`,
    align: 'center',
  });
  blocks.push({ type: 'divider' });
  return blocks;
}

/**
 * The totals block.
 *
 * When VAT is off (today) only the total is printed — showing "VAT 0.00" on a
 * slip from a shop that is not VAT-registered invites exactly the question the
 * owner does not want to answer. The fields still travel in the document; the
 * template just does not print them.
 */
function totalsBlocks(totals: ReceiptTotals): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];

  // Printed above the VAT block because that is the order it happened in: the
  // discount came off first and VAT was worked out on what was left. A customer
  // reading down the slip can follow the arithmetic to the total.
  const discountSatang = totals.discountSatang ?? 0;
  if (discountSatang > 0) {
    blocks.push({
      type: 'row',
      left: 'รวม',
      right: formatSatang(totals.grossSatang ?? totals.totalSatang + discountSatang),
    });
    blocks.push({ type: 'row', left: 'ส่วนลด', right: `-${formatSatang(discountSatang)}` });
  }

  if (totals.vatRateBpSnapshot > 0) {
    blocks.push({
      type: 'row',
      left: 'ยอดก่อนภาษี',
      right: formatSatang(totals.subtotalExVatSatang),
    });
    blocks.push({
      type: 'row',
      left: `ภาษีมูลค่าเพิ่ม ${formatRateBp(totals.vatRateBpSnapshot)}${
        totals.isVatInclusive ? ' (รวมในราคา)' : ''
      }`,
      right: formatSatang(totals.vatAmountSatang),
    });
  }

  blocks.push({
    type: 'row',
    left: 'รวมทั้งสิ้น',
    right: formatSatang(totals.totalSatang),
    bold: true,
  });
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Real bills (Step 2)                                                 */
/* ------------------------------------------------------------------ */

/** One printed line of a bill. Already totalled — templates do no money math. */
export interface BillLineInput {
  qty: number;
  name: string;
  /** qty x effective unit price, from calculateOrderTotal. */
  amountSatang: Satang;
  modifiers?: readonly string[];
  note?: string;
}

export interface BillDocInput {
  shop: ShopHeader;
  orderNo: string | null;
  tableName?: string | null;
  /** "ทานที่ร้าน" / "กลับบ้าน". */
  channelLabel?: string | null;
  openedAt: Date;
  printedAt: Date;
  /** Who is at the till. Printed so a disputed slip has a name on it. */
  staffName?: string | null;
  lines: readonly BillLineInput[];
  totals: ReceiptTotals;
  width?: number;
}

/**
 * ใบแจ้งยอด — the "what do I owe" slip handed to the table before paying.
 *
 * It carries NO document number and says so in words, because a numbered slip
 * that is not a receipt is exactly how a shop ends up with two documents for
 * one sale. The number is allocated at payment (rule #9), not here.
 */
export function buildBillCheck(input: BillDocInput): ReceiptDoc {
  const width = input.width ?? WIDTH_80MM;

  return {
    width,
    blocks: [
      ...headerBlocks(input.shop, width),
      { type: 'text', text: 'ใบแจ้งยอด', align: 'center', bold: true, size: 'wide' },
      { type: 'text', text: 'ยังไม่ได้ชำระเงิน — ไม่ใช่ใบเสร็จรับเงิน', align: 'center' },
      { type: 'blank' },
      ...billMetaBlocks(input),
      { type: 'divider' },
      ...billLineBlocks(input.lines),
      { type: 'divider' },
      ...totalsBlocks(input.totals),
      { type: 'blank' },
      { type: 'text', text: 'กรุณาชำระเงินที่เคาน์เตอร์', align: 'center' },
      { type: 'blank', lines: 2 },
      { type: 'cut' },
    ],
  };
}

export interface ReceiptPaymentInput {
  method: PaymentMethod;
  amountSatang: Satang;
  /** Cash handed over. Null for PromptPay. */
  receivedSatang?: Satang | null;
  changeSatang?: Satang | null;
  /** Reference typed off the bank slip. */
  referenceNo?: string | null;
}

export interface SalesReceiptInput extends BillDocInput {
  /** From DocSequence — `RC-HQ-2026-000123`. Never derived from the order id. */
  receiptNo: string;
  paidAt: Date;
  payment: ReceiptPaymentInput;
  /** Cash sales kick the drawer; a transfer must not. */
  openDrawer?: boolean;
}

/**
 * ใบเสร็จรับเงิน — the slip that proves money changed hands.
 *
 * The title changes once the shop is VAT-registered: a registered shop issues
 * "ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ". The switch is driven by the VAT rate
 * snapshot already carried on the bill, so the day registration lands nothing
 * here has to be edited (rule #3).
 */
export function buildSalesReceipt(input: SalesReceiptInput): ReceiptDoc {
  const width = input.width ?? WIDTH_80MM;
  const isVat = input.totals.vatRateBpSnapshot > 0;
  const { payment } = input;

  const paymentRows: ReceiptBlock[] = [
    { type: 'row', left: 'ชำระโดย', right: PAYMENT_METHOD_LABEL[payment.method] },
  ];
  if (payment.method === PaymentMethod.CASH) {
    if (typeof payment.receivedSatang === 'number') {
      paymentRows.push({
        type: 'row',
        left: 'รับเงิน',
        right: formatSatang(payment.receivedSatang),
      });
    }
    if (typeof payment.changeSatang === 'number') {
      paymentRows.push({
        type: 'row',
        left: 'เงินทอน',
        right: formatSatang(payment.changeSatang),
        bold: true,
      });
    }
  } else if (payment.referenceNo) {
    paymentRows.push({ type: 'row', left: 'อ้างอิง', right: payment.referenceNo });
  }

  return {
    width,
    blocks: [
      ...headerBlocks(input.shop, width),
      {
        type: 'text',
        text: isVat ? 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน',
        align: 'center',
        bold: true,
      },
      { type: 'blank' },
      { type: 'row', left: 'เลขที่', right: input.receiptNo },
      ...billMetaBlocks({ ...input, printedAt: input.paidAt }),
      { type: 'divider' },
      ...billLineBlocks(input.lines),
      { type: 'divider' },
      ...totalsBlocks(input.totals),
      { type: 'blank' },
      ...paymentRows,
      { type: 'blank' },
      { type: 'text', text: 'ขอบคุณที่ใช้บริการ', align: 'center' },
      { type: 'blank', lines: 2 },
      ...(input.openDrawer ? [{ type: 'openDrawer' as const }] : []),
      { type: 'cut' },
    ],
  };
}

/** The "which bill is this" rows shared by the check and the receipt. */
function billMetaBlocks(input: BillDocInput): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];
  if (input.orderNo) blocks.push({ type: 'row', left: 'บิลเลขที่', right: input.orderNo });
  if (input.tableName) blocks.push({ type: 'row', left: 'โต๊ะ', right: input.tableName });
  if (input.channelLabel) blocks.push({ type: 'row', left: 'ประเภท', right: input.channelLabel });
  blocks.push({ type: 'row', left: 'เวลา', right: formatThaiDateTime(input.printedAt) });
  if (input.staffName) blocks.push({ type: 'row', left: 'พนักงาน', right: input.staffName });
  return blocks;
}

function billLineBlocks(lines: readonly BillLineInput[]): ReceiptBlock[] {
  return lines.map((line) => ({
    type: 'item' as const,
    qty: line.qty,
    name: line.name,
    amountSatang: line.amountSatang,
    ...(line.modifiers && line.modifiers.length > 0 ? { modifiers: line.modifiers } : {}),
    ...(line.note ? { note: line.note } : {}),
  }));
}

/* ------------------------------------------------------------------ */
/* Tax documents (Step 10)                                             */
/* ------------------------------------------------------------------ */

/** The buyer, as printed on a full tax invoice. */
export interface TaxInvoiceCustomer {
  name: string;
  /** 13 digits. Formatted with dashes on the slip. */
  taxId: string;
  address?: string | null;
  /** "สำนักงานใหญ่" or "สาขาที่ 00002". */
  branchLabel: string;
}

export interface TaxInvoiceDocInput extends BillDocInput {
  taxInvoiceNo: string;
  /** The receipt this bill was already paid against. */
  receiptNo: string | null;
  issuedAt: Date;
  customer: TaxInvoiceCustomer;
}

/**
 * ใบกำกับภาษี (เต็มรูป) — the one the buyer claims their input VAT with.
 *
 * Everything the Revenue Department requires on it is REQUIRED HERE, not
 * optional-with-a-fallback: the word ใบกำกับภาษี, both parties' names, both
 * tax ids, the branch label, the document number, the date, the goods, and the
 * VAT shown separately from the net. A field this template silently omitted
 * would be a document that looks right, prints fine, and is rejected months
 * later when the buyer's accountant files it.
 *
 * Marked ต้นฉบับ because the customer's copy is the original; a shop that needs
 * a second copy reprints it as สำเนา, which is a Step-11 problem and not
 * pretended at here.
 */
export function buildTaxInvoice(input: TaxInvoiceDocInput): ReceiptDoc {
  const width = input.width ?? WIDTH_80MM;
  const { customer } = input;

  const customerBlocks: ReceiptBlock[] = [
    { type: 'text', text: 'ผู้ซื้อ', bold: true },
    { type: 'text', text: customer.name },
    { type: 'row', left: 'เลขประจำตัวผู้เสียภาษี', right: formatTaxId(customer.taxId) },
    { type: 'row', left: 'สาขา', right: customer.branchLabel },
  ];
  if (customer.address) {
    customerBlocks.push({ type: 'text', text: customer.address });
  }

  return {
    width,
    blocks: [
      ...headerBlocks(input.shop, width),
      { type: 'text', text: 'ใบกำกับภาษี', align: 'center', bold: true, size: 'wide' },
      { type: 'text', text: '(ต้นฉบับ)', align: 'center' },
      { type: 'blank' },
      { type: 'row', left: 'เลขที่', right: input.taxInvoiceNo },
      ...(input.receiptNo
        ? [{ type: 'row' as const, left: 'อ้างอิงใบเสร็จ', right: input.receiptNo }]
        : []),
      { type: 'row', left: 'วันที่', right: formatThaiDateTime(input.issuedAt) },
      ...(input.orderNo ? [{ type: 'row' as const, left: 'บิลเลขที่', right: input.orderNo }] : []),
      { type: 'divider' },
      ...customerBlocks,
      { type: 'divider' },
      ...billLineBlocks(input.lines),
      { type: 'divider' },
      ...totalsBlocks(input.totals),
      { type: 'blank', lines: 2 },
      { type: 'row', left: 'ผู้ออกใบกำกับภาษี', right: '________________' },
      { type: 'blank', lines: 2 },
      { type: 'cut' },
    ],
  };
}

export interface CreditNoteDocInput {
  shop: ShopHeader;
  creditNoteNo: string;
  /** The document being reversed. Null when the sale only ever had a receipt. */
  taxInvoiceNo: string | null;
  receiptNo: string | null;
  orderNo: string | null;
  issuedAt: Date;
  /** When the money was originally taken — the reason a credit note exists at all. */
  originalPaidAt: Date;
  customer?: TaxInvoiceCustomer | null;
  reasonLabel: string;
  note?: string | null;
  approvedBy?: string | null;
  totals: ReceiptTotals;
  width?: number;
}

/**
 * ใบลดหนี้ — the only legal way to undo a tax invoice.
 *
 * It prints the ORIGINAL document's number and date and the reason, because
 * that pairing is the whole point: an auditor holding the tax invoice must be
 * able to find the document that cancelled it, and vice versa. The amounts are
 * printed as the amount REDUCED rather than as negatives — a thermal slip full
 * of minus signs is read wrong by everybody, and the title already says which
 * direction the money went.
 */
export function buildCreditNote(input: CreditNoteDocInput): ReceiptDoc {
  const width = input.width ?? WIDTH_80MM;

  const referenceRows: ReceiptBlock[] = [];
  if (input.taxInvoiceNo) {
    referenceRows.push({ type: 'row', left: 'อ้างอิงใบกำกับภาษี', right: input.taxInvoiceNo });
  }
  if (input.receiptNo) {
    referenceRows.push({ type: 'row', left: 'อ้างอิงใบเสร็จ', right: input.receiptNo });
  }
  if (input.orderNo) {
    referenceRows.push({ type: 'row', left: 'บิลเลขที่', right: input.orderNo });
  }
  referenceRows.push({
    type: 'row',
    left: 'วันที่ขายเดิม',
    right: formatThaiDateTime(input.originalPaidAt),
  });

  const customerBlocks: ReceiptBlock[] = input.customer
    ? [
        { type: 'text', text: 'ผู้ซื้อ', bold: true },
        { type: 'text', text: input.customer.name },
        { type: 'row', left: 'เลขประจำตัวผู้เสียภาษี', right: formatTaxId(input.customer.taxId) },
        { type: 'divider' },
      ]
    : [];

  const amountRows: ReceiptBlock[] = [];
  if (input.totals.vatRateBpSnapshot > 0) {
    amountRows.push({
      type: 'row',
      left: 'มูลค่าที่ลดก่อนภาษี',
      right: formatSatang(input.totals.subtotalExVatSatang),
    });
    amountRows.push({
      type: 'row',
      left: `ภาษีมูลค่าเพิ่ม ${formatRateBp(input.totals.vatRateBpSnapshot)}`,
      right: formatSatang(input.totals.vatAmountSatang),
    });
  }
  amountRows.push({
    type: 'row',
    left: 'รวมเงินที่ลด',
    right: formatSatang(input.totals.totalSatang),
    bold: true,
  });

  return {
    width,
    blocks: [
      ...headerBlocks(input.shop, width),
      { type: 'text', text: 'ใบลดหนี้', align: 'center', bold: true, size: 'wide' },
      { type: 'blank' },
      { type: 'row', left: 'เลขที่', right: input.creditNoteNo },
      { type: 'row', left: 'วันที่', right: formatThaiDateTime(input.issuedAt) },
      { type: 'divider' },
      ...referenceRows,
      { type: 'divider' },
      ...customerBlocks,
      { type: 'text', text: 'เหตุผล', bold: true },
      { type: 'text', text: input.reasonLabel },
      ...(input.note ? [{ type: 'text' as const, text: input.note }] : []),
      { type: 'divider' },
      ...amountRows,
      ...(input.approvedBy
        ? [{ type: 'row' as const, left: 'ผู้อนุมัติ', right: input.approvedBy }]
        : []),
      { type: 'blank', lines: 2 },
      { type: 'cut' },
    ],
  };
}

/** `29/07/2569 23:45` — Buddhist era, the format on every Thai till slip. */
export function formatThaiDateTime(date: Date, timeZone = 'Asia/Bangkok'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const buddhistYear = Number(read('year')) + 543;
  return `${read('day')}/${read('month')}/${buddhistYear} ${read('hour')}:${read('minute')}`;
}

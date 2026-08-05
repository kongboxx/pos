/**
 * The two slips a real sale produces.
 *
 * These assert on the RENDERED TEXT, in printer cells, because that is what
 * comes out of the machine. A layout bug found here costs a test run; the same
 * bug found later costs a roll of paper and a customer looking at a bill whose
 * prices do not line up.
 */

import { describe, expect, it } from 'vitest';
import { PaymentMethod } from './enums.js';
import {
  buildBillCheck,
  buildSalesReceipt,
  renderReceiptText,
  WIDTH_58MM,
  WIDTH_80MM,
  type BillDocInput,
} from './receipt.js';
import { thaiWidth } from './thai-text.js';

const SHOP = {
  name: 'ร้านก๋วยเตี๋ยว สาขาหลัก',
  address: '123 ถนนตัวอย่าง กรุงเทพฯ',
  phone: '02-000-0000',
  taxId: null,
  branchCode: 'HQ',
};

const BASE: BillDocInput = {
  shop: SHOP,
  orderNo: '260730-042',
  tableName: 'A1',
  channelLabel: 'ทานที่ร้าน',
  openedAt: new Date('2026-07-30T04:00:00Z'),
  printedAt: new Date('2026-07-30T05:30:00Z'),
  staffName: 'สมหญิง',
  lines: [
    { qty: 2, name: 'ก๋วยเตี๋ยวหมูน้ำตก', amountSatang: 12000 },
    { qty: 1, name: 'ก๋วยเตี๋ยวเนื้อตุ๋นหม้อไฟรวมมิตรพิเศษ', amountSatang: 8500, note: 'ไม่ผัก' },
    { qty: 3, name: 'น้ำเปล่า', amountSatang: 3000 },
  ],
  totals: {
    subtotalExVatSatang: 23500,
    vatAmountSatang: 0,
    vatRateBpSnapshot: 0,
    totalSatang: 23500,
    isVatInclusive: true,
  },
};

describe('ใบแจ้งยอด (bill check)', () => {
  const doc = buildBillCheck(BASE);
  const text = renderReceiptText(doc).join('\n');

  it('says in words that it is not a receipt', () => {
    expect(text).toContain('ใบแจ้งยอด');
    expect(text).toContain('ไม่ใช่ใบเสร็จรับเงิน');
  });

  it('carries no document number — numbers belong to real receipts (rule #9)', () => {
    // Asserted on the blocks, not the text: "บิลเลขที่" (the order number)
    // legitimately contains the word "เลขที่", so a substring check here would
    // pass or fail for the wrong reason.
    const hasDocNumberRow = doc.blocks.some(
      (block) => block.type === 'row' && block.left === 'เลขที่',
    );
    expect(hasDocNumberRow).toBe(false);
    expect(text).not.toMatch(/RC-/);
  });

  it('never opens the cash drawer', () => {
    expect(doc.blocks.some((block) => block.type === 'openDrawer')).toBe(false);
  });

  it('shows the table and the running total', () => {
    expect(text).toContain('A1');
    expect(text).toContain('235.00');
  });
});

describe('a discounted slip', () => {
  const discounted = renderReceiptText(
    buildBillCheck({
      ...BASE,
      totals: {
        ...BASE.totals,
        grossSatang: 23500,
        discountSatang: 2000,
        subtotalExVatSatang: 21500,
        totalSatang: 21500,
      },
    }),
  ).join('\n');

  it('shows the bill, the discount and what is left, in that order', () => {
    const gross = discounted.indexOf('235.00');
    const discount = discounted.indexOf('-20.00');
    const total = discounted.indexOf('215.00');
    expect(gross).toBeGreaterThan(-1);
    expect(discount).toBeGreaterThan(gross);
    expect(total).toBeGreaterThan(discount);
  });

  it('labels the discount so the customer can see what they were given', () => {
    expect(discounted).toContain('ส่วนลด');
  });

  it('stays off a slip with no discount — nobody should be prompted to ask', () => {
    expect(renderReceiptText(buildBillCheck(BASE)).join('\n')).not.toContain('ส่วนลด');
  });
});

describe('ใบเสร็จรับเงิน (sales receipt)', () => {
  const doc = buildSalesReceipt({
    ...BASE,
    receiptNo: 'RC-HQ-2026-000123',
    paidAt: new Date('2026-07-30T05:31:00Z'),
    payment: {
      method: PaymentMethod.CASH,
      amountSatang: 23500,
      receivedSatang: 50000,
      changeSatang: 26500,
    },
    openDrawer: true,
  });
  const text = renderReceiptText(doc).join('\n');

  it('prints the document number from DocSequence', () => {
    expect(text).toContain('RC-HQ-2026-000123');
  });

  it('prints cash received and change', () => {
    expect(text).toContain('เงินสด');
    expect(text).toContain('500.00');
    expect(text).toContain('265.00');
  });

  it('opens the drawer before cutting, never after', () => {
    const drawer = doc.blocks.findIndex((block) => block.type === 'openDrawer');
    const cut = doc.blocks.findIndex((block) => block.type === 'cut');
    expect(drawer).toBeGreaterThan(-1);
    expect(drawer).toBeLessThan(cut);
  });

  it('says ใบเสร็จรับเงิน while the shop is not VAT-registered', () => {
    expect(text).toContain('ใบเสร็จรับเงิน');
    expect(text).not.toContain('ใบกำกับภาษี');
    // Rule #3: the fields travel, the template just does not print zeros.
    expect(text).not.toContain('ภาษีมูลค่าเพิ่ม');
  });

  it('switches to the VAT title and prints the VAT block once registered', () => {
    const vatDoc = buildSalesReceipt({
      ...BASE,
      receiptNo: 'RC-HQ-2026-000124',
      paidAt: new Date('2026-07-30T05:31:00Z'),
      totals: {
        subtotalExVatSatang: 21963,
        vatAmountSatang: 1537,
        vatRateBpSnapshot: 700,
        totalSatang: 23500,
        isVatInclusive: true,
      },
      payment: { method: PaymentMethod.PROMPTPAY, amountSatang: 23500 },
    });
    const vatText = renderReceiptText(vatDoc).join('\n');

    expect(vatText).toContain('ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ');
    expect(vatText).toContain('ภาษีมูลค่าเพิ่ม 7%');
    expect(vatText).toContain('15.37');
    // Net + VAT must equal the printed total, or the slip contradicts itself.
    expect(21963 + 1537).toBe(23500);
  });

  it('does not open the drawer for a transfer', () => {
    const transfer = buildSalesReceipt({
      ...BASE,
      receiptNo: 'RC-HQ-2026-000125',
      paidAt: new Date('2026-07-30T05:31:00Z'),
      payment: {
        method: PaymentMethod.PROMPTPAY,
        amountSatang: 23500,
        referenceNo: '0123456789',
      },
      openDrawer: false,
    });
    expect(transfer.blocks.some((block) => block.type === 'openDrawer')).toBe(false);
    expect(renderReceiptText(transfer).join('\n')).toContain('0123456789');
  });
});

describe('layout holds at both paper widths', () => {
  for (const width of [WIDTH_80MM, WIDTH_58MM]) {
    it(`renders every line to exactly ${width} printer cells`, () => {
      const doc = buildSalesReceipt({
        ...BASE,
        width,
        receiptNo: 'RC-HQ-2026-000126',
        paidAt: new Date('2026-07-30T05:31:00Z'),
        payment: {
          method: PaymentMethod.CASH,
          amountSatang: 23500,
          receivedSatang: 50000,
          changeSatang: 26500,
        },
      });

      for (const line of renderReceiptText(doc)) {
        // thaiWidth, not .length: Thai tone marks are zero-width on paper but
        // count as characters in JS. This is the assertion that catches a
        // price column drifting by the number of วรรณยุกต์ in an item name.
        expect(thaiWidth(line)).toBe(width);
      }
    });
  }

  it('keeps the price hard against the right edge even when the name wraps', () => {
    const doc = buildBillCheck({ ...BASE, width: WIDTH_58MM });
    const lines = renderReceiptText(doc);
    const priceLine = lines.find((line) => line.includes('85.00'));
    expect(priceLine).toBeDefined();
    expect((priceLine as string).trimEnd().endsWith('85.00')).toBe(true);
  });
});

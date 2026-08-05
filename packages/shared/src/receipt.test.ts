import { describe, expect, it } from 'vitest';
import { thaiWidth } from './thai-text.js';
import {
  buildTestReceipt,
  formatThaiDateTime,
  receiptTextPreview,
  renderReceiptText,
  WIDTH_58MM,
  WIDTH_80MM,
  type ReceiptDoc,
  type ShopHeader,
} from './receipt.js';

const SHOP: ShopHeader = {
  name: 'ร้านก๋วยเตี๋ยว สาขาหลัก',
  address: '123 ถนนตัวอย่าง กรุงเทพฯ 10000',
  phone: '02-000-0000',
  taxId: null,
  branchCode: 'HQ',
};

const PRINTED_AT = new Date('2026-07-29T16:45:00Z'); // 23:45 Bangkok

function testDoc(overrides: Partial<Parameters<typeof buildTestReceipt>[0]> = {}): ReceiptDoc {
  return buildTestReceipt({ shop: SHOP, printedAt: PRINTED_AT, ...overrides });
}

describe('every rendered line is exactly the paper width', () => {
  it('holds for 80mm', () => {
    for (const line of renderReceiptText(testDoc())) {
      expect(thaiWidth(line)).toBe(WIDTH_80MM);
    }
  });

  it('holds for 58mm — the same document, re-laid out', () => {
    for (const line of renderReceiptText(testDoc({ width: WIDTH_58MM }))) {
      expect(thaiWidth(line)).toBe(WIDTH_58MM);
    }
  });

  it('holds for a name long enough to need wrapping', () => {
    const doc: ReceiptDoc = {
      width: WIDTH_80MM,
      blocks: [
        {
          type: 'item',
          qty: 1,
          name: 'ก๋วยเตี๋ยวเนื้อตุ๋นหม้อไฟรวมมิตรพิเศษใส่ทุกอย่างไม่อั้น',
          amountSatang: 25000,
          modifiers: ['บะหมี่', 'ต้มยำ', 'พิเศษ', 'เพิ่มลูกชิ้น'],
          note: 'ไม่ผัก ไม่ถั่วงอก เผ็ดน้อย ใส่พริกแยก',
        },
      ],
    };
    const lines = renderReceiptText(doc);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(thaiWidth(line)).toBe(WIDTH_80MM);
    }
  });
});

describe('the money column lines up — the whole reason thai-text.ts exists', () => {
  it('ends every item amount in the same cell regardless of tone marks', () => {
    const doc: ReceiptDoc = {
      width: WIDTH_80MM,
      blocks: [
        { type: 'item', qty: 2, name: 'ก๋วยเตี๋ยวหมูน้ำตก', amountSatang: 12000 },
        { type: 'item', qty: 1, name: 'Coke', amountSatang: 2000 },
        { type: 'item', qty: 3, name: 'น้ำเปล่า', amountSatang: 3000 },
      ],
    };

    // Take only the first line of each item (no modifiers here, so 1:1).
    const lines = renderReceiptText(doc);
    expect(lines).toHaveLength(3);

    const amountColumns = lines.map((line) => {
      const trimmed = line.replace(/\s+$/, '');
      return thaiWidth(trimmed);
    });
    // All three lines end at the same cell — they are right-aligned amounts.
    expect(new Set(amountColumns).size).toBe(1);
    expect(amountColumns[0]).toBe(WIDTH_80MM);

    for (const line of lines) {
      expect(line.replace(/\s+$/, '')).toMatch(/\d+\.\d{2}$/);
    }
  });

  it('right-aligns the grand total to the paper edge', () => {
    const preview = receiptTextPreview(testDoc());
    const totalLine = preview.split('\n').find((line) => line.startsWith('รวมทั้งสิ้น'));
    expect(totalLine).toBeDefined();
    expect(totalLine).toMatch(/235\.00$/);
  });
});

describe('VAT block', () => {
  it('prints no VAT lines while the shop is not registered', () => {
    const preview = receiptTextPreview(testDoc());
    expect(preview).not.toMatch(/ภาษีมูลค่าเพิ่ม/);
    expect(preview).not.toMatch(/ยอดก่อนภาษี/);
    // Printing "VAT 0.00" on a non-registered shop's slip invites questions.
    expect(preview).toMatch(/รวมทั้งสิ้น/);
  });
});

describe('the test slip is not a receipt', () => {
  it('says so on the paper', () => {
    const preview = receiptTextPreview(testDoc());
    expect(preview).toMatch(/ใบทดสอบเครื่องพิมพ์/);
    expect(preview).toMatch(/ไม่ใช่ใบเสร็จรับเงิน/);
  });

  it('carries no document number — those belong to real bills only', () => {
    const preview = receiptTextPreview(testDoc());
    expect(preview).not.toMatch(/RC-|TX-|CN-/);
  });

  it('includes a drawer kick and a cut by default', () => {
    const types = testDoc().blocks.map((block) => block.type);
    expect(types).toContain('openDrawer');
    expect(types).toContain('cut');
  });

  it('can be printed without opening the drawer', () => {
    const types = testDoc({ openDrawer: false }).blocks.map((block) => block.type);
    expect(types).not.toContain('openDrawer');
    expect(types).toContain('cut');
  });
});

describe('renderer block behaviour', () => {
  it('renders a divider across the full width', () => {
    const lines = renderReceiptText({ width: 10, blocks: [{ type: 'divider' }] });
    expect(lines).toEqual(['----------']);
  });

  it('honours a custom divider character', () => {
    const lines = renderReceiptText({ width: 5, blocks: [{ type: 'divider', char: '=' }] });
    expect(lines).toEqual(['=====']);
  });

  it('centres text', () => {
    const lines = renderReceiptText({
      width: 11,
      blocks: [{ type: 'text', text: 'abc', align: 'center' }],
    });
    expect(lines).toEqual(['    abc    ']);
  });

  it('emits nothing printable for drawer and cut', () => {
    const lines = renderReceiptText({
      width: 10,
      blocks: [{ type: 'openDrawer' }, { type: 'cut' }],
    });
    expect(lines).toEqual([]);
  });

  it('shows the QR payload in the text preview', () => {
    const preview = receiptTextPreview({
      width: 20,
      blocks: [{ type: 'qr', data: 'x', caption: 'สแกนสั่ง' }],
    });
    expect(preview).toContain('[QR]');
    expect(preview).toContain('สแกนสั่ง');
  });
});

describe('formatThaiDateTime', () => {
  it('uses the Buddhist era and Bangkok time', () => {
    // 2026-07-29T16:45Z is 23:45 on 29/07 in Bangkok. 2026 + 543 = 2569.
    expect(formatThaiDateTime(PRINTED_AT)).toBe('29/07/2569 23:45');
  });

  it('rolls the date over correctly past midnight Bangkok time', () => {
    // 2026-07-29T17:20Z is 00:20 on 30/07 in Bangkok.
    expect(formatThaiDateTime(new Date('2026-07-29T17:20:00Z'))).toBe('30/07/2569 00:20');
  });
});

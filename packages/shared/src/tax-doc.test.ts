import { describe, expect, it } from 'vitest';
import { HEAD_OFFICE_LABEL } from './branch-admin.js';
import {
  buildCreditNote,
  buildTaxInvoice,
  receiptTextPreview,
  renderReceiptText,
} from './receipt.js';
import { thaiWidth } from './thai-text.js';
import {
  CREDIT_NOTE_REASONS,
  CreditNoteReason,
  creditNoteReasonLabel,
  creditNoteRequestSchema,
  taxInvoiceRequestSchema,
} from './tax-doc.js';

const SHOP = {
  name: 'ร้านก๋วยเตี๋ยวเรือ',
  address: '99/1 ถนนสุขุมวิท กรุงเทพฯ',
  phone: '021234567',
  taxId: '0105558123451',
  branchCode: 'HQ',
};

const TOTALS = {
  subtotalExVatSatang: 21963,
  vatAmountSatang: 1537,
  vatRateBpSnapshot: 700,
  totalSatang: 23500,
  isVatInclusive: true,
};

const LINES = [
  { qty: 2, name: 'ก๋วยเตี๋ยวหมูน้ำตก', amountSatang: 12000, modifiers: ['เส้นเล็ก'] },
  { qty: 1, name: 'ข้าวมันไก่', amountSatang: 11500 },
];

describe('ฟอร์มขอใบกำกับภาษีเต็มรูป', () => {
  const valid = {
    customerName: 'บริษัท ทดสอบ จำกัด',
    customerTaxId: '0105558123400',
  };

  it('เติมสาขาลูกค้าเป็นสำนักงานใหญ่ให้เอง', () => {
    // Required by the Revenue Department and meaningless to almost everyone
    // who has to type it, which is exactly the field that gets filled with
    // rubbish if it is asked for.
    expect(taxInvoiceRequestSchema.parse(valid).customerBranchLabel).toBe(HEAD_OFFICE_LABEL);
  });

  it('เลขผู้เสียภาษีลูกค้าที่ผิดไม่ผ่าน', () => {
    expect(
      taxInvoiceRequestSchema.safeParse({ ...valid, customerTaxId: '0105558123401' }).success,
    ).toBe(false);
  });

  it('เก็บเลขลูกค้าแบบไม่มีขีด', () => {
    const parsed = taxInvoiceRequestSchema.parse({
      ...valid,
      customerTaxId: '0-1055-58123-40-0',
    });
    expect(parsed.customerTaxId).toBe('0105558123400');
  });

  it('ไม่มีชื่อผู้ซื้อไม่ผ่าน', () => {
    expect(taxInvoiceRequestSchema.safeParse({ ...valid, customerName: '  ' }).success).toBe(false);
  });
});

describe('ฟอร์มออกใบลดหนี้', () => {
  const valid = {
    reason: CreditNoteReason.WRONG_BILL,
    approverStaffId: '11111111-1111-4111-8111-111111111111',
    approverPin: '1234',
  };

  it('ต้องมีผู้อนุมัติเสมอ', () => {
    // Cancelling a completed sale is strictly bigger than voiding one line, so
    // it carries the same supervisor PIN that a void does (rule #8).
    const { approverPin: _pin, ...withoutPin } = valid;
    expect(creditNoteRequestSchema.safeParse(withoutPin).success).toBe(false);
  });

  it('เหตุผลต้องเป็นค่าที่รู้จัก', () => {
    expect(creditNoteRequestSchema.safeParse({ ...valid, reason: 'อยากยกเลิก' }).success).toBe(
      false,
    );
  });

  it('หมายเหตุว่างกลายเป็น null', () => {
    expect(creditNoteRequestSchema.parse({ ...valid, note: '   ' }).note).toBeNull();
  });

  it('เหตุผลทุกข้อมีชื่อไทยไม่ซ้ำกัน', () => {
    const labels = CREDIT_NOTE_REASONS.map((reason) => reason.label);
    expect(new Set(labels).size).toBe(CREDIT_NOTE_REASONS.length);
    expect(creditNoteReasonLabel(CreditNoteReason.RETURNED)).toBe('ลูกค้าคืนของ/ยกเลิก');
  });

  it('ค่าที่ไม่รู้จักแสดงเป็นตัวมันเอง ไม่ใช่ช่องว่าง', () => {
    expect(creditNoteReasonLabel('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });
});

describe('ใบกำกับภาษีเต็มรูป', () => {
  const doc = buildTaxInvoice({
    shop: SHOP,
    taxInvoiceNo: 'TX-HQ-2026-000001',
    receiptNo: 'RC-HQ-2026-000123',
    orderNo: '260730-004',
    issuedAt: new Date('2026-07-30T05:30:00Z'),
    openedAt: new Date('2026-07-30T04:00:00Z'),
    printedAt: new Date('2026-07-30T05:30:00Z'),
    customer: {
      name: 'บริษัท ทดสอบ จำกัด',
      taxId: '0105558123400',
      address: '1 ถนนพระราม 4 กรุงเทพฯ',
      branchLabel: HEAD_OFFICE_LABEL,
    },
    lines: LINES,
    totals: TOTALS,
  });
  const text = receiptTextPreview(doc);

  it('มีคำว่าใบกำกับภาษีและระบุว่าเป็นต้นฉบับ', () => {
    expect(text).toContain('ใบกำกับภาษี');
    expect(text).toContain('(ต้นฉบับ)');
  });

  it('มีเลขผู้เสียภาษีของทั้งผู้ขายและผู้ซื้อ', () => {
    // A full tax invoice missing either one is a document the buyer's
    // accountant hands back months later.
    expect(text).toContain('0105558123451');
    expect(text).toContain('0-1055-58123-40-0');
  });

  it('มีเลขที่เอกสาร อ้างอิงใบเสร็จ และสาขาของผู้ซื้อ', () => {
    expect(text).toContain('TX-HQ-2026-000001');
    expect(text).toContain('RC-HQ-2026-000123');
    expect(text).toContain('สำนักงานใหญ่');
  });

  it('แยกยอดก่อนภาษีกับภาษีให้เห็นคนละบรรทัด', () => {
    expect(text).toContain('ยอดก่อนภาษี');
    expect(text).toContain('219.63');
    expect(text).toContain('ภาษีมูลค่าเพิ่ม 7%');
    expect(text).toContain('15.37');
    expect(text).toContain('235.00');
  });

  it('ทุกบรรทัดกว้างเท่ากันพอดีเมื่อวัดเป็นช่องของเครื่องพิมพ์', () => {
    // Measured with thaiWidth, never .length: Thai tone marks are separate
    // code units that occupy no cell on the printer, so .length here would
    // report a 48-cell line as 60-odd characters and fail a correct layout.
    const lines = renderReceiptText(doc);
    expect(lines.every((line) => thaiWidth(line) === doc.width)).toBe(true);
  });
});

describe('ใบลดหนี้', () => {
  const doc = buildCreditNote({
    shop: SHOP,
    creditNoteNo: 'CN-HQ-2026-000001',
    taxInvoiceNo: 'TX-HQ-2026-000001',
    receiptNo: 'RC-HQ-2026-000123',
    orderNo: '260730-004',
    issuedAt: new Date('2026-08-01T03:00:00Z'),
    originalPaidAt: new Date('2026-07-30T05:30:00Z'),
    customer: {
      name: 'บริษัท ทดสอบ จำกัด',
      taxId: '0105558123400',
      branchLabel: HEAD_OFFICE_LABEL,
    },
    reasonLabel: 'ออกใบผิดชื่อลูกค้า',
    note: 'ลูกค้าให้เลขผู้เสียภาษีผิด',
    approvedBy: 'พี่ชาย เจ้าของร้าน',
    totals: TOTALS,
  });
  const text = receiptTextPreview(doc);

  it('บอกว่าเป็นใบลดหนี้และอ้างอิงใบกำกับภาษีเดิม', () => {
    // The pairing IS the document: an auditor holding one must be able to find
    // the other.
    expect(text).toContain('ใบลดหนี้');
    expect(text).toContain('CN-HQ-2026-000001');
    expect(text).toContain('TX-HQ-2026-000001');
  });

  it('มีวันที่ขายเดิม ไม่ใช่แค่วันที่ออกใบลดหนี้', () => {
    expect(text).toContain('30/07/2569');
    expect(text).toContain('01/08/2569');
  });

  it('มีเหตุผลและผู้อนุมัติ', () => {
    expect(text).toContain('ออกใบผิดชื่อลูกค้า');
    expect(text).toContain('ลูกค้าให้เลขผู้เสียภาษีผิด');
    expect(text).toContain('พี่ชาย เจ้าของร้าน');
  });

  it('พิมพ์ยอดเป็นจำนวนที่ลด ไม่ใช่ตัวเลขติดลบ', () => {
    expect(text).toContain('รวมเงินที่ลด');
    expect(text).toContain('235.00');
    expect(text).not.toContain('-235.00');
  });

  it('บิลที่ไม่เคยออกใบกำกับภาษีก็ออกใบลดหนี้ได้ ไม่มีบรรทัดอ้างอิงค้างว่าง', () => {
    const plain = buildCreditNote({
      shop: SHOP,
      creditNoteNo: 'CN-HQ-2026-000002',
      taxInvoiceNo: null,
      receiptNo: 'RC-HQ-2026-000124',
      orderNo: null,
      issuedAt: new Date('2026-08-01T03:00:00Z'),
      originalPaidAt: new Date('2026-07-30T05:30:00Z'),
      customer: null,
      reasonLabel: 'คิดเงินผิดบิล',
      totals: { ...TOTALS, vatRateBpSnapshot: 0, vatAmountSatang: 0 },
    });
    const plainText = receiptTextPreview(plain);
    expect(plainText).toContain('CN-HQ-2026-000002');
    expect(plainText).not.toContain('อ้างอิงใบกำกับภาษี');
    // No VAT on the original sale means no VAT line to reverse.
    expect(plainText).not.toContain('ภาษีมูลค่าเพิ่ม');
    expect(plainText).toContain('รวมเงินที่ลด');
  });
});

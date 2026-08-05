import { describe, expect, it } from 'vitest';
import {
  branchCreateSchema,
  branchSettingsSchema,
  formatTaxId,
  HEAD_OFFICE_LABEL,
  isValidThaiTaxId,
  normalizeTaxId,
  vatConfigForDate,
  vatIsPending,
} from './branch-admin.js';

/** Real-shaped ids whose check digit is correct. See isValidThaiTaxId. */
const SHOP_TAX_ID = '0105558123451';
const OTHER_TAX_ID = '0105558123400';

const SETTINGS = {
  name: 'ร้านก๋วยเตี๋ยวสาขาหลัก',
  businessType: 'RESTAURANT',
  address: null,
  phone: null,
  taxId: null,
  timezone: 'Asia/Bangkok',
  dayCutoffHour: 4,
  vatEnabled: false,
  vatRateBp: 0,
  priceIncludesVat: true,
  vatEffectiveDate: null,
  rentPerMonthSatang: 0,
  promptPayId: null,
  qrOrderingEnabled: true,
  isActive: true,
};

describe('เลขประจำตัวผู้เสียภาษี', () => {
  it('ยอมรับเลขที่หลักตรวจสอบถูกต้อง', () => {
    expect(isValidThaiTaxId(SHOP_TAX_ID)).toBe(true);
    expect(isValidThaiTaxId(OTHER_TAX_ID)).toBe(true);
  });

  it('ปฏิเสธเลขที่พิมพ์ผิดหลักเดียว', () => {
    // The whole reason the checksum is here: a one-digit typo on a full tax
    // invoice is not a small mistake, it is a document the buyer cannot use.
    expect(isValidThaiTaxId('0105558123452')).toBe(false);
    expect(isValidThaiTaxId('0105558123441')).toBe(false);
  });

  it('ปฏิเสธความยาวผิดและตัวอักษร', () => {
    expect(isValidThaiTaxId('010555812345')).toBe(false);
    expect(isValidThaiTaxId('01055581234512')).toBe(false);
    expect(isValidThaiTaxId('')).toBe(false);
    expect(isValidThaiTaxId('01055581234x1')).toBe(false);
  });

  it('รับเลขที่มีขีดหรือเว้นวรรคติดมา', () => {
    expect(isValidThaiTaxId('0-1055-58123-45-1')).toBe(true);
    expect(isValidThaiTaxId(' 0105558123451 ')).toBe(true);
    expect(normalizeTaxId('0-1055-58123-45-1')).toBe(SHOP_TAX_ID);
  });

  it('จัดรูปแบบเป็น 1-2345-67890-12-3', () => {
    expect(formatTaxId(SHOP_TAX_ID)).toBe('0-1055-58123-45-1');
    // Anything that is not 13 digits comes back untouched rather than mangled:
    // the slip should show what is stored, not a half-formatted guess.
    expect(formatTaxId('123')).toBe('123');
  });
});

describe('VAT ตามวันที่ของบิล', () => {
  const registered = {
    vatEnabled: true,
    vatRateBp: 700,
    priceIncludesVat: true,
    vatEffectiveDate: '2026-10-01',
  };

  it('บิลก่อนวันที่จดทะเบียนยังไม่มี VAT', () => {
    // The point of the whole file: flipping the switch must not reach back and
    // claim the shop collected VAT in September that it never remitted.
    expect(vatConfigForDate(registered, '2026-09-30')).toEqual({
      enabled: false,
      rateBp: 0,
      priceIncludesVat: true,
    });
  });

  it('วันแรกที่มีผลคิด VAT แล้ว', () => {
    expect(vatConfigForDate(registered, '2026-10-01')).toEqual({
      enabled: true,
      rateBp: 700,
      priceIncludesVat: true,
    });
    expect(vatConfigForDate(registered, '2027-03-15').enabled).toBe(true);
  });

  it('ไม่ตั้งวันที่ = มีผลตั้งแต่ต้น', () => {
    const noDate = { vatEnabled: true, vatRateBp: 700, priceIncludesVat: false };
    expect(vatConfigForDate(noDate, '2020-01-01')).toEqual({
      enabled: true,
      rateBp: 700,
      priceIncludesVat: false,
    });
  });

  it('ปิดสวิตช์แล้ววันที่ไม่มีความหมาย', () => {
    const off = { ...registered, vatEnabled: false };
    expect(vatConfigForDate(off, '2027-01-01').enabled).toBe(false);
    expect(vatConfigForDate(off, '2027-01-01').rateBp).toBe(0);
  });

  it('บอกได้ว่ารอวันเริ่มอยู่', () => {
    expect(vatIsPending(registered, '2026-09-15')).toBe(true);
    expect(vatIsPending(registered, '2026-10-01')).toBe(false);
    expect(vatIsPending({ ...registered, vatEffectiveDate: null }, '2026-09-15')).toBe(false);
  });
});

describe('ฟอร์มตั้งค่าสาขา', () => {
  it('ยอมรับค่าเริ่มต้นของร้านที่ยังไม่จด VAT', () => {
    expect(branchSettingsSchema.parse(SETTINGS).vatEnabled).toBe(false);
  });

  it('เปิด VAT แต่อัตรา 0 ไม่ผ่าน', () => {
    // Looks fine on every screen and is not: identical totals, but the receipt
    // now calls itself a tax document.
    const result = branchSettingsSchema.safeParse({
      ...SETTINGS,
      vatEnabled: true,
      vatRateBp: 0,
      taxId: SHOP_TAX_ID,
    });
    expect(result.success).toBe(false);
  });

  it('เปิด VAT แต่ไม่มีเลขผู้เสียภาษีของร้านไม่ผ่าน', () => {
    const result = branchSettingsSchema.safeParse({
      ...SETTINGS,
      vatEnabled: true,
      vatRateBp: 700,
      taxId: null,
    });
    expect(result.success).toBe(false);
  });

  it('เปิด VAT ครบเงื่อนไขผ่านและเก็บเลขแบบไม่มีขีด', () => {
    const parsed = branchSettingsSchema.parse({
      ...SETTINGS,
      vatEnabled: true,
      vatRateBp: 700,
      taxId: '0-1055-58123-45-1',
      vatEffectiveDate: '2026-10-01',
    });
    expect(parsed.taxId).toBe(SHOP_TAX_ID);
    expect(parsed.vatEffectiveDate).toBe('2026-10-01');
  });

  it('เลขผู้เสียภาษีของร้านที่ผิดไม่ผ่านแม้ยังไม่เปิด VAT', () => {
    expect(branchSettingsSchema.safeParse({ ...SETTINGS, taxId: '1111111111111' }).success).toBe(
      false,
    );
  });

  it('ช่องว่างเปล่ากลายเป็น null ไม่ใช่สตริงว่าง', () => {
    const parsed = branchSettingsSchema.parse({ ...SETTINGS, address: '  ', phone: '' });
    expect(parsed.address).toBeNull();
    expect(parsed.phone).toBeNull();
  });
});

describe('ฟอร์มเพิ่มสาขา', () => {
  it('ตั้งค่า timezone และเวลาตัดวันให้เอง', () => {
    const parsed = branchCreateSchema.parse({
      name: 'สาขาสอง',
      branchCode: 'BR02',
      businessType: 'RESTAURANT',
      ownerFullName: 'สมชาย ใจดี',
      ownerPin: '2468',
    });
    expect(parsed.timezone).toBe('Asia/Bangkok');
    expect(parsed.dayCutoffHour).toBe(4);
    expect(parsed.ownerNickname).toBeNull();
  });

  it('รหัสสาขาที่มีอักขระอื่นไม่ผ่าน', () => {
    // The code goes into every document number; a slash or a space there is a
    // document number nobody can search for.
    const bad = { name: 'x', businessType: 'RESTAURANT', ownerFullName: 'y', ownerPin: '1234' };
    expect(branchCreateSchema.safeParse({ ...bad, branchCode: 'BR 2' }).success).toBe(false);
    expect(branchCreateSchema.safeParse({ ...bad, branchCode: 'สาขา2' }).success).toBe(false);
    expect(branchCreateSchema.safeParse({ ...bad, branchCode: 'TOOLONGCODE' }).success).toBe(false);
  });

  it('PIN ต้องเป็นเลข 4 หลัก', () => {
    const base = {
      name: 'x',
      branchCode: 'BR02',
      businessType: 'RESTAURANT',
      ownerFullName: 'y',
    };
    expect(branchCreateSchema.safeParse({ ...base, ownerPin: '123' }).success).toBe(false);
    expect(branchCreateSchema.safeParse({ ...base, ownerPin: '12a4' }).success).toBe(false);
  });
});

describe('ค่าคงที่', () => {
  it('สาขาลูกค้าเริ่มต้นเป็นสำนักงานใหญ่', () => {
    expect(HEAD_OFFICE_LABEL).toBe('สำนักงานใหญ่');
  });
});

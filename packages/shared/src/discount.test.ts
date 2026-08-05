import { describe, expect, it } from 'vitest';
import {
  describeDiscount,
  discountFromPercentBp,
  discountRequestSchema,
  resolveDiscount,
  type DiscountRequest,
} from './discount.js';

const APPROVER = '11111111-1111-4111-8111-111111111111';

const request = (over: Partial<Record<string, unknown>> = {}) => ({
  mode: 'AMOUNT',
  value: 2000,
  reason: 'ลูกค้าประจำ',
  approverStaffId: APPROVER,
  approverPin: '1234',
  ...over,
});

describe('discountFromPercentBp', () => {
  it('takes a percentage off a bill', () => {
    expect(discountFromPercentBp(23500, 1000)).toBe(2350); // 10% of 235.00
  });

  it('rounds half away from zero rather than truncating in the shop’s favour', () => {
    // 5% of 45.50 is 2.275 -> 2.28, not 2.27.
    expect(discountFromPercentBp(4550, 500)).toBe(228);
  });

  it('gives the whole bill away at 100%', () => {
    expect(discountFromPercentBp(23500, 10_000)).toBe(23500);
  });

  it('refuses a rate above 100% instead of producing a negative bill', () => {
    expect(() => discountFromPercentBp(23500, 10_001)).toThrow(RangeError);
  });

  it('refuses a fractional basis point, which is a float sneaking in', () => {
    expect(() => discountFromPercentBp(23500, 10.5)).toThrow(RangeError);
  });
});

describe('resolveDiscount', () => {
  it('passes an amount straight through — the bill total is irrelevant', () => {
    const parsed = discountRequestSchema.parse(request({ mode: 'AMOUNT', value: 2000 }));
    expect(resolveDiscount(parsed, 23500)).toBe(2000);
    expect(resolveDiscount(parsed, 100_000)).toBe(2000);
  });

  it('works a percentage out against the bill in front of it', () => {
    const parsed = discountRequestSchema.parse(request({ mode: 'PERCENT', value: 1000 }));
    expect(resolveDiscount(parsed, 23500)).toBe(2350);
  });
});

describe('the wire', () => {
  it('accepts an ordinary ฿20 off for a regular', () => {
    expect(discountRequestSchema.parse(request())).toMatchObject({
      mode: 'AMOUNT',
      value: 2000,
      reason: 'ลูกค้าประจำ',
      note: null,
    });
  });

  it('refuses a discount of zero — that is not a discount, it is a cancelled dialog', () => {
    expect(discountRequestSchema.safeParse(request({ value: 0 })).success).toBe(false);
  });

  it('refuses a negative discount, which would add money to the bill', () => {
    expect(discountRequestSchema.safeParse(request({ value: -500 })).success).toBe(false);
  });

  it('refuses more than 100% off', () => {
    expect(
      discountRequestSchema.safeParse(request({ mode: 'PERCENT', value: 10_001 })).success,
    ).toBe(false);
  });

  it('allows an amount larger than any percentage cap — the server clamps it', () => {
    // 150.00 off is a legal request; whether the bill can afford it is decided
    // against the bill, not here.
    expect(discountRequestSchema.safeParse(request({ value: 15_000 })).success).toBe(true);
  });

  it('makes "อื่นๆ" carry a written reason', () => {
    expect(discountRequestSchema.safeParse(request({ reason: 'อื่นๆ' })).success).toBe(false);
    expect(
      discountRequestSchema.safeParse(request({ reason: 'อื่นๆ', note: 'เจ้าของสั่ง' })).success,
    ).toBe(true);
  });

  it('does not accept spaces as a written reason', () => {
    expect(discountRequestSchema.safeParse(request({ reason: 'อื่นๆ', note: '   ' })).success).toBe(
      false,
    );
  });

  it('needs a supervisor PIN, not just a staff id', () => {
    expect(discountRequestSchema.safeParse(request({ approverPin: undefined })).success).toBe(
      false,
    );
    expect(discountRequestSchema.safeParse(request({ approverStaffId: undefined })).success).toBe(
      false,
    );
  });

  it('refuses a reason that is not on the list', () => {
    expect(discountRequestSchema.safeParse(request({ reason: 'ลดให้เพื่อน' })).success).toBe(false);
  });
});

describe('describeDiscount', () => {
  it('reads back what was agreed, in baht', () => {
    expect(describeDiscount(discountRequestSchema.parse(request()) as DiscountRequest)).toBe(
      'ลูกค้าประจำ · 20 บาท',
    );
  });

  it('keeps the percentage the cashier typed, not the satang it became', () => {
    expect(
      describeDiscount(discountRequestSchema.parse(request({ mode: 'PERCENT', value: 1000 }))),
    ).toBe('ลูกค้าประจำ · 10%');
  });

  it('includes the written reason when there is one', () => {
    expect(
      describeDiscount(
        discountRequestSchema.parse(request({ reason: 'อื่นๆ', note: 'เจ้าของสั่ง' })),
      ),
    ).toBe('อื่นๆ · 20 บาท · เจ้าของสั่ง');
  });
});

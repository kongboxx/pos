import { describe, expect, it } from 'vitest';
import {
  canMergeBills,
  describeMerge,
  describeSplit,
  describeTableMove,
  moveTableRequestSchema,
  planSplit,
  splitBillRequestSchema,
  type MergeCandidate,
} from './bill-move.js';
import type { OrderLineDto } from './order.js';

const UUID = (n: number): string =>
  `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${String(n).padStart(2, '0')}`;

function line(overrides: Partial<OrderLineDto> & { id: string }): OrderLineDto {
  return {
    menuItemId: UUID(99),
    nameSnapshot: 'ก๋วยเตี๋ยวหมู',
    qty: 1,
    unitPriceSatang: 5000,
    lineTotalSatang: 5000,
    note: null,
    firedAt: null,
    voidedAt: null,
    source: 'STAFF',
    approvedAt: null,
    modifiers: [],
    ...overrides,
  };
}

const NOODLES = line({ id: UUID(1) });
const PORK = line({ id: UUID(2), nameSnapshot: 'ก๋วยเตี๋ยวหมูสับ' });
const WATER = line({ id: UUID(3), nameSnapshot: 'น้ำเปล่า', unitPriceSatang: 1000 });

describe('choosing what to split off', () => {
  it('splits the chosen lines and leaves the rest', () => {
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK, WATER] }, [
      UUID(2),
      UUID(3),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.moving.map((l) => l.id)).toEqual([UUID(2), UUID(3)]);
    expect(result.plan.staying.map((l) => l.id)).toEqual([UUID(1)]);
  });

  it('keeps the order the bill shows, not the order the taps came in', () => {
    // The cashier ticks น้ำเปล่า then ก๋วยเตี๋ยว; the new bill should read the
    // way the old one did, not the way the checkboxes were pressed.
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK, WATER] }, [
      UUID(3),
      UUID(1),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.moving.map((l) => l.id)).toEqual([UUID(1), UUID(3)]);
  });

  it('refuses an empty selection', () => {
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK] }, []);
    expect(result).toMatchObject({ ok: false, refusal: 'NOTHING_SELECTED' });
  });

  it('refuses a line that is not on this bill', () => {
    const result = planSplit({ discountSatang: 0, lines: [NOODLES] }, [UUID(2)]);
    expect(result).toMatchObject({ ok: false, refusal: 'LINE_NOT_ON_BILL' });
  });

  it('refuses the same line twice', () => {
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK] }, [UUID(1), UUID(1)]);
    expect(result).toMatchObject({ ok: false, refusal: 'DUPLICATE_LINE' });
  });

  it('refuses to move a voided line away from the bill it was voided on', () => {
    // The void is evidence of something that happened HERE (rule #8).
    const voided = line({ id: UUID(4), voidedAt: '2026-07-30T05:00:00.000Z' });
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK, voided] }, [UUID(4)]);
    expect(result).toMatchObject({ ok: false, refusal: 'LINE_VOIDED' });
    if (result.ok) return;
    // Names the dish, because "a line is voided" sends the cashier hunting.
    expect(result.message).toContain('ก๋วยเตี๋ยวหมู');
  });

  it('refuses a QR request nobody has answered yet', () => {
    const waiting = line({ id: UUID(5), source: 'QR', approvedAt: null });
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, waiting] }, [UUID(5)]);
    expect(result).toMatchObject({ ok: false, refusal: 'LINE_AWAITING_APPROVAL' });
  });

  it('lets an APPROVED QR line be split like any other', () => {
    const approved = line({ id: UUID(6), source: 'QR', approvedAt: '2026-07-30T05:00:00.000Z' });
    expect(planSplit({ discountSatang: 0, lines: [NOODLES, approved] }, [UUID(6)]).ok).toBe(true);
  });

  it('refuses to move every line off, which would leave an empty bill', () => {
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK] }, [UUID(1), UUID(2)]);
    expect(result).toMatchObject({ ok: false, refusal: 'WOULD_EMPTY_BILL' });
    if (result.ok) return;
    // Points at the operation they actually meant.
    expect(result.message).toContain('ย้ายโต๊ะ');
  });

  it('does not count a voided line as something staying behind', () => {
    // Splitting off both live bowls would leave a bill holding nothing but a
    // void, which is an empty bill with extra steps.
    const voided = line({ id: UUID(7), voidedAt: '2026-07-30T05:00:00.000Z' });
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, PORK, voided] }, [
      UUID(1),
      UUID(2),
    ]);
    expect(result).toMatchObject({ ok: false, refusal: 'WOULD_EMPTY_BILL' });
  });

  it('does not count a waiting QR request as something staying behind either', () => {
    const waiting = line({ id: UUID(8), source: 'QR', approvedAt: null });
    const result = planSplit({ discountSatang: 0, lines: [NOODLES, waiting] }, [UUID(1)]);
    expect(result).toMatchObject({ ok: false, refusal: 'WOULD_EMPTY_BILL' });
  });

  it('refuses to cut up a bill that carries a discount', () => {
    // ฿20 off was agreed against ONE bill. Halving it invents a figure nobody
    // approved; leaving it on one side charges the other customer for it.
    const result = planSplit({ discountSatang: 2000, lines: [NOODLES, PORK] }, [UUID(1)]);
    expect(result).toMatchObject({ ok: false, refusal: 'DISCOUNTED' });
  });

  it('checks the discount before anything else, so the message is the useful one', () => {
    // A discounted bill with a duff selection should still say "clear the
    // discount" — that is the thing standing in the way.
    const result = planSplit({ discountSatang: 2000, lines: [NOODLES] }, []);
    expect(result).toMatchObject({ ok: false, refusal: 'DISCOUNTED' });
  });
});

describe('choosing what may be merged', () => {
  const bill = (overrides: Partial<MergeCandidate> & { id: string }): MergeCandidate => ({
    status: 'OPEN',
    businessDate: '2026-07-30',
    discountSatang: 0,
    lines: [NOODLES],
    ...overrides,
  });

  const A = bill({ id: UUID(10) });
  const B = bill({ id: UUID(11) });

  it('allows two open bills from the same day', () => {
    expect(canMergeBills(A, B)).toEqual({ ok: true });
  });

  it('refuses a bill merged into itself', () => {
    expect(canMergeBills(A, A)).toMatchObject({ refusal: 'SAME_BILL' });
  });

  it('refuses a bill that has already been paid', () => {
    expect(canMergeBills(A, bill({ id: UUID(12), status: 'PAID' }))).toMatchObject({
      refusal: 'NOT_OPEN',
    });
    expect(canMergeBills(bill({ id: UUID(13), status: 'PAID' }), B)).toMatchObject({
      refusal: 'NOT_OPEN',
    });
  });

  it('refuses bills from different trading days', () => {
    // Rule #4: a bill belongs to the day it was rung up on, and merging across
    // the 04:00 cutoff would move takings between two days' reports.
    expect(canMergeBills(A, bill({ id: UUID(14), businessDate: '2026-07-29' }))).toMatchObject({
      refusal: 'DIFFERENT_DAY',
    });
  });

  it('refuses when either bill carries a discount', () => {
    // The amount was agreed against a bill that will not exist afterwards.
    expect(canMergeBills(A, bill({ id: UUID(15), discountSatang: 2000 }))).toMatchObject({
      refusal: 'DISCOUNTED',
    });
    expect(canMergeBills(bill({ id: UUID(16), discountSatang: 2000 }), B)).toMatchObject({
      refusal: 'DISCOUNTED',
    });
  });

  it('says to cancel rather than merge an empty bill', () => {
    expect(canMergeBills(A, bill({ id: UUID(17), lines: [] }))).toMatchObject({
      refusal: 'NOTHING_TO_MOVE',
    });
  });

  it('treats a bill of nothing but voided lines as empty', () => {
    const dead = line({ id: UUID(18), voidedAt: '2026-07-30T05:00:00.000Z' });
    expect(canMergeBills(A, bill({ id: UUID(19), lines: [dead] }))).toMatchObject({
      refusal: 'NOTHING_TO_MOVE',
    });
  });
});

describe('what the audit log will read like', () => {
  it('names both tables', () => {
    expect(describeTableMove('A1', 'B2')).toBe('ย้ายจากโต๊ะ A1 ไปโต๊ะ B2');
  });

  it('copes with a bill that had no table', () => {
    expect(describeTableMove(null, 'B2')).toBe('ย้ายไปโต๊ะ B2');
  });

  it('names both bills and how much moved', () => {
    expect(describeMerge('260730-002', '260730-001', 3)).toBe(
      'รวมบิล 260730-002 (3 รายการ) เข้ากับ 260730-001',
    );
  });

  it('says how much was split off', () => {
    expect(describeSplit('260730-001', 2)).toBe('แยก 2 รายการออกจากบิล 260730-001 ไปบิลใหม่');
  });
});

describe('the requests themselves', () => {
  it('needs a real table id to move to', () => {
    expect(moveTableRequestSchema.safeParse({ tableId: 'โต๊ะ A1' }).success).toBe(false);
  });

  it('needs the tablet to name the new bill (rule #6)', () => {
    // Without a client id, a retried request splits the bill twice.
    expect(splitBillRequestSchema.safeParse({ lineIds: [UUID(1)] }).success).toBe(false);
  });

  it('refuses a split with nothing selected', () => {
    expect(splitBillRequestSchema.safeParse({ newOrderId: UUID(20), lineIds: [] }).success).toBe(
      false,
    );
  });
});

/**
 * The local bill reducer.
 *
 * What is actually being tested here is a promise: that the total a cashier
 * reads to a customer with the wifi down is the total the server will store
 * when the bill syncs. Every case below is one way that promise could quietly
 * break — double-counted option prices, a compounding price on a re-edit, VAT
 * computed differently offline, a made-up bill number.
 */

import { describe, expect, it } from 'vitest';
import { calculateOrderTotal, type MenuItemDto, type ModifierGroupDto } from '@pos/shared';
import { applyMutation, LocalMutationError, toRequest, type LocalContext } from './mutations.js';

const BOWL_ID = '11111111-1111-4111-8111-111111111111';
const WATER_ID = '11111111-1111-4111-8111-111111111112';
const ORDER_ID = '22222222-2222-4222-8222-222222222221';
const LINE_ID = '33333333-3333-4333-8333-333333333331';

const NOODLE: ModifierGroupDto = {
  id: 'g-noodle',
  name: 'เส้น',
  isRequired: true,
  minSelect: 1,
  maxSelect: 1,
  isNegative: false,
  modifiers: [
    { id: 'm-small', name: 'เส้นเล็ก', priceDeltaSatang: 0, isDefault: true, isAvailable: true },
    { id: 'm-egg', name: 'บะหมี่', priceDeltaSatang: 500, isDefault: false, isAvailable: true },
  ],
};

const SIZE: ModifierGroupDto = {
  id: 'g-size',
  name: 'ขนาด',
  isRequired: true,
  minSelect: 1,
  maxSelect: 1,
  isNegative: false,
  modifiers: [
    { id: 'm-normal', name: 'ธรรมดา', priceDeltaSatang: 0, isDefault: true, isAvailable: true },
    { id: 'm-large', name: 'พิเศษ', priceDeltaSatang: 1000, isDefault: false, isAvailable: true },
  ],
};

const WITHOUT: ModifierGroupDto = {
  id: 'g-without',
  name: 'ไม่ใส่',
  isRequired: false,
  minSelect: 0,
  maxSelect: 3,
  isNegative: true,
  modifiers: [
    { id: 'm-noveg', name: 'ไม่ผัก', priceDeltaSatang: 0, isDefault: false, isAvailable: true },
    // เกาเหลา — no noodles, and the customer gets money back.
    {
      id: 'm-nonoodle',
      name: 'เกาเหลา',
      priceDeltaSatang: -500,
      isDefault: false,
      isAvailable: true,
    },
  ],
};

const BOWL: MenuItemDto = {
  id: BOWL_ID,
  categoryId: 'c-1',
  name: 'ก๋วยเตี๋ยวหมู',
  subcategory: null,
  priceSatang: 5000,
  station: 'kitchen',
  isAvailable: true,
  groupIds: [NOODLE.id, SIZE.id, WITHOUT.id],
};

const WATER: MenuItemDto = {
  id: WATER_ID,
  categoryId: 'c-2',
  name: 'น้ำเปล่า',
  subcategory: null,
  priceSatang: 1000,
  station: null,
  isAvailable: true,
  groupIds: [],
};

function contextWith(vat: LocalContext['vat']): LocalContext {
  let counter = 0;
  return {
    branchId: 'branch-1',
    vat,
    businessDate: '2026-07-30',
    itemsById: new Map([
      [BOWL.id, BOWL],
      [WATER.id, WATER],
    ]),
    groupsById: new Map([
      [NOODLE.id, NOODLE],
      [SIZE.id, SIZE],
      [WITHOUT.id, WITHOUT],
    ]),
    now: () => new Date('2026-07-30T05:00:00.000Z'),
    newId: () => `snap-${(counter += 1)}`,
  };
}

const NO_VAT = contextWith({ enabled: false, rateBp: 0, priceIncludesVat: true });

function openBill(context = NO_VAT) {
  return applyMutation(
    null,
    {
      kind: 'createOrder',
      orderId: ORDER_ID,
      tableId: 't-1',
      channel: 'DINE_IN',
      tableName: 'A1',
    },
    context,
  );
}

function addBowl(
  order: ReturnType<typeof openBill>,
  modifierIds: string[],
  qty = 1,
  context = NO_VAT,
) {
  return applyMutation(
    order,
    {
      kind: 'addLine',
      orderId: ORDER_ID,
      lineId: LINE_ID,
      menuItemId: BOWL_ID,
      qty,
      modifierIds,
      note: null,
    },
    context,
  );
}

describe('opening a bill offline', () => {
  it('leaves the bill number empty instead of inventing one', () => {
    // Two tablets offline at the same time cannot agree on who gets 004, and a
    // duplicate document number is far worse than a missing one (rule #9).
    expect(openBill().orderNo).toBeNull();
  });

  it('starts at zero and remembers the table it was opened on', () => {
    const order = openBill();
    expect(order.totalSatang).toBe(0);
    expect(order.status).toBe('OPEN');
    expect(order.tableName).toBe('A1');
    expect(order.businessDate).toBe('2026-07-30');
  });
});

describe('adding a line offline', () => {
  it('prices the bowl with its options folded in', () => {
    const order = addBowl(openBill(), ['m-egg', 'm-large']);
    const line = order.lines[0]!;
    expect(line.unitPriceSatang).toBe(6500); // 50.00 + 5.00 + 10.00
    expect(line.lineTotalSatang).toBe(6500);
    expect(order.totalSatang).toBe(6500);
  });

  it('multiplies by quantity', () => {
    const order = addBowl(openBill(), ['m-egg', 'm-large'], 3);
    expect(order.lines[0]!.lineTotalSatang).toBe(19500);
    expect(order.totalSatang).toBe(19500);
  });

  it('lets a removal give money back', () => {
    const order = addBowl(openBill(), ['m-small', 'm-normal', 'm-nonoodle']);
    expect(order.lines[0]!.unitPriceSatang).toBe(4500);
  });

  it('lists the options in GROUP order, not the order they were tapped', () => {
    // A ticket that reads "พิเศษ · บะหมี่" on one line and "บะหมี่ · พิเศษ"
    // on the next is slower to read at 1.5m, and the cook pays for it.
    const order = addBowl(openBill(), ['m-large', 'm-noveg', 'm-egg']);
    expect(order.lines[0]!.modifiers.map((m) => m.nameSnapshot)).toEqual([
      'บะหมี่',
      'พิเศษ',
      'ไม่ผัก',
    ]);
  });

  it('adds a second line without disturbing the first', () => {
    const first = addBowl(openBill(), ['m-egg', 'm-large']);
    const both = applyMutation(
      first,
      {
        kind: 'addLine',
        orderId: ORDER_ID,
        lineId: 'line-2',
        menuItemId: WATER_ID,
        qty: 2,
        modifierIds: [],
        note: null,
      },
      NO_VAT,
    );
    expect(both.lines).toHaveLength(2);
    expect(both.totalSatang).toBe(6500 + 2000);
  });

  it('refuses an item this device has never cached, in Thai', () => {
    expect(() =>
      applyMutation(
        openBill(),
        {
          kind: 'addLine',
          orderId: ORDER_ID,
          lineId: 'line-x',
          menuItemId: 'not-on-the-menu',
          qty: 1,
          modifierIds: [],
          note: null,
        },
        NO_VAT,
      ),
    ).toThrow(LocalMutationError);
  });

  it('carries no cost figure, because the tablet was never told one', () => {
    // Inventing a zero would put a 100% margin in front of a manager.
    expect(addBowl(openBill(), ['m-small', 'm-normal']).lines[0]!.unitCostSatang).toBeUndefined();
  });
});

describe('editing a line offline', () => {
  it('changes the quantity without recounting the option prices', () => {
    // THE TRAP: the line's unitPriceSatang already contains the +5 and +10.
    // Adding the deltas again on every edit would inflate the bowl each time.
    const added = addBowl(openBill(), ['m-egg', 'm-large']);
    const edited = applyMutation(
      added,
      { kind: 'updateLine', orderId: ORDER_ID, lineId: LINE_ID, qty: 2, note: null },
      NO_VAT,
    );
    expect(edited.lines[0]!.unitPriceSatang).toBe(6500);
    expect(edited.lines[0]!.lineTotalSatang).toBe(13000);
  });

  it('stays stable when the same options are re-confirmed over and over', () => {
    let order = addBowl(openBill(), ['m-egg', 'm-large']);
    for (let round = 0; round < 4; round += 1) {
      order = applyMutation(
        order,
        {
          kind: 'updateLine',
          orderId: ORDER_ID,
          lineId: LINE_ID,
          qty: 1,
          modifierIds: ['m-egg', 'm-large'],
          note: null,
        },
        NO_VAT,
      );
    }
    expect(order.lines[0]!.unitPriceSatang).toBe(6500);
  });

  it('reprices when the options change', () => {
    const added = addBowl(openBill(), ['m-egg', 'm-large']);
    const edited = applyMutation(
      added,
      {
        kind: 'updateLine',
        orderId: ORDER_ID,
        lineId: LINE_ID,
        qty: 1,
        modifierIds: ['m-small', 'm-normal'],
        note: null,
      },
      NO_VAT,
    );
    expect(edited.lines[0]!.unitPriceSatang).toBe(5000);
    expect(edited.lines[0]!.modifiers.map((m) => m.nameSnapshot)).toEqual(['เส้นเล็ก', 'ธรรมดา']);
  });

  it('removes a line and retotals', () => {
    const added = addBowl(openBill(), ['m-egg', 'm-large']);
    const removed = applyMutation(
      added,
      { kind: 'removeLine', orderId: ORDER_ID, lineId: LINE_ID },
      NO_VAT,
    );
    expect(removed.lines).toHaveLength(0);
    expect(removed.totalSatang).toBe(0);
  });

  it('cancels an empty bill so the table is freed', () => {
    const cancelled = applyMutation(openBill(), { kind: 'cancelOrder', orderId: ORDER_ID }, NO_VAT);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('refuses to touch a bill this device does not have', () => {
    expect(() =>
      applyMutation(null, { kind: 'removeLine', orderId: ORDER_ID, lineId: LINE_ID }, NO_VAT),
    ).toThrow(LocalMutationError);
  });
});

describe('lines the kitchen already owns (Step 5)', () => {
  /** The bill as it comes back from the server once "ส่งครัว" was pressed. */
  function firedBill() {
    const order = addBowl(openBill(), ['m-egg']);
    return {
      ...order,
      lines: order.lines.map((line) => ({ ...line, firedAt: '2026-07-30T05:01:00.000Z' })),
    };
  }

  it('refuses to change a fired line', () => {
    // Without this the tablet would show the cashier a changed bill and only
    // discover the server's refusal when the queue drained — leaving a bill in
    // the rejected list for something that should never have been offered.
    expect(() =>
      applyMutation(
        firedBill(),
        { kind: 'updateLine', orderId: ORDER_ID, lineId: LINE_ID, qty: 5, note: null },
        NO_VAT,
      ),
    ).toThrow(LocalMutationError);
  });

  it('refuses to remove a fired line, and says to ask a manager', () => {
    expect(() =>
      applyMutation(
        firedBill(),
        { kind: 'removeLine', orderId: ORDER_ID, lineId: LINE_ID },
        NO_VAT,
      ),
    ).toThrow(/ผู้จัดการ/);
  });

  it('refuses to change a line that was already voided', () => {
    const order = addBowl(openBill(), []);
    const voided = {
      ...order,
      lines: order.lines.map((line) => ({ ...line, voidedAt: '2026-07-30T05:02:00.000Z' })),
    };
    expect(() =>
      applyMutation(
        voided,
        { kind: 'updateLine', orderId: ORDER_ID, lineId: LINE_ID, qty: 2, note: null },
        NO_VAT,
      ),
    ).toThrow(LocalMutationError);
  });

  it('still lets an unfired line on the same bill be edited', () => {
    // Half the bill going to the kitchen must not freeze the other half — that
    // is the normal case when a table orders drinks first.
    const order = addBowl(openBill(), ['m-egg']);
    const mixed = {
      ...order,
      lines: [
        { ...order.lines[0]!, id: 'fired-line', firedAt: '2026-07-30T05:01:00.000Z' },
        { ...order.lines[0]! },
      ],
    };
    const edited = applyMutation(
      mixed,
      { kind: 'updateLine', orderId: ORDER_ID, lineId: LINE_ID, qty: 3, note: null },
      NO_VAT,
    );
    expect(edited.lines.find((line) => line.id === LINE_ID)?.qty).toBe(3);
  });

  it('treats removing a line that is already gone as done', () => {
    const order = addBowl(openBill(), []);
    expect(() =>
      applyMutation(
        order,
        { kind: 'removeLine', orderId: ORDER_ID, lineId: 'never-existed' },
        NO_VAT,
      ),
    ).not.toThrow();
  });
});

describe('the offline total matches the server', () => {
  it('splits VAT exactly the way calculateOrderTotal does', () => {
    // The day the shop registers for VAT, the offline till must not start
    // disagreeing with the server about what a bowl costs.
    const vat = { enabled: true, rateBp: 700, priceIncludesVat: true };
    const context = contextWith(vat);
    const order = addBowl(openBill(context), ['m-egg', 'm-large'], 3, context);

    const fromServerMath = calculateOrderTotal(
      [{ nameSnapshot: 'ก๋วยเตี๋ยวหมู', qty: 3, unitPriceSatang: 6500, unitCostSatang: 0 }],
      vat,
    );

    expect(order.totalSatang).toBe(fromServerMath.totalSatang);
    expect(order.subtotalExVatSatang).toBe(fromServerMath.subtotalExVatSatang);
    expect(order.vatAmountSatang).toBe(fromServerMath.vatAmountSatang);
    expect(order.vatRateBpSnapshot).toBe(700);
  });
});

describe('the wire format', () => {
  it('sends the ids this device generated, so a replay is not a second bowl', () => {
    const request = toRequest({
      kind: 'addLine',
      orderId: ORDER_ID,
      lineId: LINE_ID,
      menuItemId: BOWL_ID,
      qty: 2,
      modifierIds: ['m-egg'],
      note: 'เผ็ดน้อย',
    });
    expect(request).toEqual({
      method: 'POST',
      path: `/orders/${ORDER_ID}/lines`,
      body: {
        id: LINE_ID,
        menuItemId: BOWL_ID,
        qty: 2,
        modifierIds: ['m-egg'],
        note: 'เผ็ดน้อย',
      },
    });
  });

  it('omits modifierIds on a quantity-only edit, so the options are left alone', () => {
    const request = toRequest({
      kind: 'updateLine',
      orderId: ORDER_ID,
      lineId: LINE_ID,
      qty: 4,
      note: null,
    });
    expect(request.body).toEqual({ qty: 4, note: null });
  });

  it('does not leak the local table name into the request', () => {
    // The server knows the table's name; sending ours would be a second source
    // of truth for a field the client has no business setting.
    const request = toRequest({
      kind: 'createOrder',
      orderId: ORDER_ID,
      tableId: 't-1',
      channel: 'DINE_IN',
      tableName: 'A1',
    });
    expect(request.body).toEqual({ id: ORDER_ID, tableId: 't-1', channel: 'DINE_IN' });
  });
});

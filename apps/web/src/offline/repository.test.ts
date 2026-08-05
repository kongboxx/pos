/**
 * What the screens see.
 *
 * The two questions worth a test: does an edit survive with the network off,
 * and does the device ever show something staler than what the server knows?
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuResponse, OrderDto, TableDto } from '@pos/shared';
import { api } from '../api-client.js';
import { saveIdentity, saveMenu } from './catalog.js';
import { clearLocalData, getOrder, putOrder, type StoredOrder } from './db.js';
import { enqueue, totalUnsent } from './outbox.js';
import { addOrBumpLine, mergeFloorPlan, openBill, readOrder, runMutation } from './repository.js';

vi.mock('../api-client.js', () => ({
  api: {
    call: vi.fn(),
    health: vi.fn(),
    getOrder: vi.fn(),
    menu: vi.fn(),
    tables: vi.fn(),
    openOrders: vi.fn(),
  },
}));

const BILL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TABLE_ID = 'tttttttt-tttt-4ttt-8ttt-tttttttttttt';
const ITEM_ID = 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii';

const MENU: MenuResponse = {
  categories: [
    {
      id: 'c-1',
      name: 'ก๋วยเตี๋ยว',
      subcategories: [],
      items: [
        {
          id: ITEM_ID,
          categoryId: 'c-1',
          name: 'ก๋วยเตี๋ยวหมู',
          subcategory: null,
          priceSatang: 5000,
          station: 'kitchen',
          isAvailable: true,
          groupIds: [],
        },
      ],
    },
  ],
  modifierGroups: [],
};

async function signIn(): Promise<void> {
  await saveIdentity({
    user: {
      staffId: 's-1',
      branchId: 'b-1',
      role: 'STAFF',
      fullName: 'อ่อง มิน',
      nickname: 'อ่อง',
    },
    permissions: [],
    branch: {
      id: 'b-1',
      name: 'ร้านทดสอบ',
      branchCode: 'HQ',
      businessType: 'RESTAURANT',
      vatEnabled: false,
      vatRateBp: 0,
      vatEffectiveDate: null,
      priceIncludesVat: true,
      timezone: 'Asia/Bangkok',
      dayCutoffHour: 4,
      promptPayConfigured: false,
    },
  });
}

/** A bill as the server would send it back. */
function serverOrder(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: BILL_ID,
    orderNo: '260730-004',
    branchId: 'b-1',
    tableId: TABLE_ID,
    tableName: 'A1',
    channel: 'DINE_IN',
    status: 'OPEN',
    businessDate: '2026-07-30',
    openedAt: '2026-07-30T05:00:00.000Z',
    paidAt: null,
    note: null,
    subtotalExVatSatang: 5000,
    vatRateBpSnapshot: 0,
    vatAmountSatang: 0,
    totalSatang: 5000,
    discountSatang: 0,
    isVatInclusive: true,
    receiptNo: null,
    lines: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();
  // Every test here runs with the network down unless it says otherwise.
  vi.mocked(api.call).mockResolvedValue({ ok: false, error: 'offline', offline: true });
  vi.mocked(api.health).mockResolvedValue({ ok: false, error: 'offline', offline: true });
  vi.mocked(api.getOrder).mockResolvedValue({ ok: false, error: 'offline', offline: true });
});

describe('taking an order with the network down', () => {
  it('opens a bill and stores it on the device', async () => {
    await signIn();
    await saveMenu(MENU);

    const opened = await openBill({ tableId: TABLE_ID, tableName: 'A1', channel: 'DINE_IN' });
    expect(opened.ok).toBe(true);

    const orderId = opened.ok ? opened.value : '';
    const stored = await getOrder(orderId);
    expect(stored?.unsynced).toBe(true);
    expect(stored?.orderNo).toBeNull();
    expect(await totalUnsent()).toBe(1);
  });

  it('adds a line and updates the total without a single request', async () => {
    await signIn();
    await saveMenu(MENU);
    const opened = await openBill({ tableId: TABLE_ID, tableName: 'A1', channel: 'DINE_IN' });
    const orderId = opened.ok ? opened.value : '';

    const result = await runMutation({
      kind: 'addLine',
      orderId,
      lineId: 'line-1',
      menuItemId: ITEM_ID,
      qty: 2,
      modifierIds: [],
      note: null,
    });

    expect(result.ok && result.value.totalSatang).toBe(10000);
    expect((await getOrder(orderId))?.totalSatang).toBe(10000);
  });

  it('says plainly what is missing on a device that has never been online', async () => {
    await signIn();
    // No menu cached: there is no honest price to put on a bowl.
    const opened = await openBill({ tableId: TABLE_ID, tableName: 'A1', channel: 'DINE_IN' });
    expect(opened).toEqual({ ok: false, error: expect.stringContaining('ต่อเน็ต') });
    expect(await totalUnsent()).toBe(0);
  });

  it('queues nothing when the local rule already says no', async () => {
    await signIn();
    await saveMenu(MENU);
    const opened = await openBill({ tableId: null, tableName: null, channel: 'TAKEAWAY' });
    const orderId = opened.ok ? opened.value : '';

    const result = await runMutation({
      kind: 'addLine',
      orderId,
      lineId: 'line-1',
      menuItemId: 'an-item-that-is-not-cached',
      qty: 1,
      modifierIds: [],
      note: null,
    });

    expect(result.ok).toBe(false);
    // One entry, from opening the bill — the bad line was never queued.
    expect(await totalUnsent()).toBe(1);
  });
});

describe('tapping the same menu button again', () => {
  async function billWithOneBowl(note: string | null): Promise<string> {
    await signIn();
    await saveMenu(MENU);
    const opened = await openBill({ tableId: TABLE_ID, tableName: 'A1', channel: 'DINE_IN' });
    const orderId = opened.ok ? opened.value : '';
    await addOrBumpLine({ orderId, menuItemId: ITEM_ID, modifierIds: [], qty: 1, note });
    return orderId;
  }

  it('bumps the bowl that is already there instead of stacking a second row', async () => {
    const orderId = await billWithOneBowl(null);
    await addOrBumpLine({ orderId, menuItemId: ITEM_ID, modifierIds: [], qty: 1, note: null });

    const stored = await getOrder(orderId);
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.lines[0]?.qty).toBe(2);
  });

  it('keeps a bowl with a note apart from the same bowl without one', async () => {
    // Merging them would send the kitchen one "เผ็ดน้อย" covering two
    // customers, and only one of them would get what they asked for.
    const orderId = await billWithOneBowl('เผ็ดน้อย');
    await addOrBumpLine({ orderId, menuItemId: ITEM_ID, modifierIds: [], qty: 1, note: null });

    const stored = await getOrder(orderId);
    expect(stored?.lines).toHaveLength(2);
    expect(stored?.lines.map((line) => line.note)).toEqual(['เผ็ดน้อย', null]);
  });

  it('stacks two bowls that ask for exactly the same thing', async () => {
    // A table of four ordering the same bowl should be ONE row to read back,
    // and a stray space must not be what decides otherwise.
    const orderId = await billWithOneBowl('เผ็ดน้อย');
    await addOrBumpLine({
      orderId,
      menuItemId: ITEM_ID,
      modifierIds: [],
      qty: 1,
      note: ' เผ็ดน้อย ',
    });

    const stored = await getOrder(orderId);
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.lines[0]?.qty).toBe(2);
  });

  it('stores a note of nothing but spaces as no note at all', async () => {
    const orderId = await billWithOneBowl('   ');
    expect((await getOrder(orderId))?.lines[0]?.note).toBeNull();
  });
});

describe('which copy of a bill wins', () => {
  it('keeps the device version while anything is still queued', async () => {
    await putOrder(serverOrder({ totalSatang: 9900, orderNo: null }), true);
    await enqueue({ kind: 'removeLine', orderId: BILL_ID, lineId: 'line-1' });

    const order = await readOrder(BILL_ID);

    expect(order?.totalSatang).toBe(9900);
    // Asking the server here would let it overwrite lines the cashier just
    // added, and they would blink out of the bill in front of the customer.
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it("takes the server's version once the queue is empty", async () => {
    await putOrder(serverOrder({ totalSatang: 9900, orderNo: null }), true);
    vi.mocked(api.getOrder).mockResolvedValue({ ok: true, data: { order: serverOrder() } });

    const order = await readOrder(BILL_ID);

    expect(order?.totalSatang).toBe(5000);
    expect(order?.orderNo).toBe('260730-004');
    expect(order?.unsynced).toBe(false);
  });

  it('forgets a bill the server says does not exist', async () => {
    await putOrder(serverOrder(), false);
    vi.mocked(api.getOrder).mockResolvedValue({
      ok: false,
      error: 'ไม่พบบิลนี้',
      offline: false,
      status: 404,
    });

    expect(await readOrder(BILL_ID)).toBeNull();
    expect(await getOrder(BILL_ID)).toBeUndefined();
  });
});

describe('the floor plan', () => {
  const table: TableDto = { id: TABLE_ID, name: 'A1', zone: 'ในร้าน', seats: 4, openOrder: null };

  const stored = (overrides: Partial<StoredOrder>): StoredOrder => ({
    ...serverOrder({ orderNo: null }),
    updatedAt: Date.now(),
    unsynced: true,
    ...overrides,
  });

  it('draws a bill opened offline onto its table', async () => {
    // Otherwise the cashier taps the table they just seated and is told it is
    // free, and opens a second bill on it.
    const [merged] = mergeFloorPlan([table], [stored({ totalSatang: 12000 })]);
    expect(merged?.openOrder).toMatchObject({ id: BILL_ID, totalSatang: 12000, orderNo: null });
  });

  it('leaves a synced bill to the server', async () => {
    // Our copy adds nothing and may be stale — another tablet may have taken
    // the money since, and the table would sit amber long after they left.
    const [merged] = mergeFloorPlan([table], [stored({ unsynced: false })]);
    expect(merged?.openOrder).toBeNull();
  });

  it('ignores a local bill that is already closed', async () => {
    const [merged] = mergeFloorPlan([table], [stored({ status: 'CANCELLED' })]);
    expect(merged?.openOrder).toBeNull();
  });

  it('adds an offline bill ALONGSIDE the ones the server already knows about', async () => {
    // Since แยกบิล a table carries more than one. Substituting would hide a
    // real, already-synced bill behind an unsynced one and lose its total off
    // the floor plan.
    const busy: TableDto = {
      ...table,
      openOrder: null,
      openOrders: [
        {
          id: 'ssssssss-ssss-4sss-8sss-ssssssssssss',
          orderNo: '260730-001',
          totalSatang: 5000,
          lineCount: 1,
          openedAt: '2026-07-30T05:00:00.000Z',
        },
      ],
    };

    const [merged] = mergeFloorPlan([busy], [stored({ totalSatang: 12000 })]);
    expect(merged?.openOrders).toHaveLength(2);
    expect(merged?.openOrders?.map((bill) => bill.totalSatang)).toEqual([5000, 12000]);
    // The single-bill field keeps pointing at the one the table started with.
    expect(merged?.openOrder?.orderNo).toBe('260730-001');
  });

  it('does not list the same bill twice once it has synced', async () => {
    const synced: TableDto = {
      ...table,
      openOrders: [
        {
          id: BILL_ID,
          orderNo: '260730-001',
          totalSatang: 12000,
          lineCount: 1,
          openedAt: '2026-07-30T05:00:00.000Z',
        },
      ],
    };

    const [merged] = mergeFloorPlan([synced], [stored({ totalSatang: 12000 })]);
    expect(merged?.openOrders).toHaveLength(1);
  });
});

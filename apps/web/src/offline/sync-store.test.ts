/**
 * The sync loop's decisions.
 *
 * Not "does it call fetch" — whether the till ends up believing the right
 * thing: is it online, is anything still owed to the server, and did the bill
 * number ever arrive.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto } from '@pos/shared';
import { api } from '../api-client.js';
import { clearLocalData, getOrder, putOrder } from './db.js';
import { enqueue } from './outbox.js';
import { useSync } from './sync-store.js';

vi.mock('../api-client.js', () => ({
  api: { call: vi.fn(), health: vi.fn(), getOrder: vi.fn() },
}));

const BILL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const order = (overrides: Partial<OrderDto> = {}): OrderDto => ({
  id: BILL_ID,
  orderNo: '260730-004',
  branchId: 'b-1',
  tableId: null,
  tableName: null,
  channel: 'TAKEAWAY',
  status: 'OPEN',
  businessDate: '2026-07-30',
  openedAt: '2026-07-30T05:00:00.000Z',
  paidAt: null,
  note: null,
  subtotalExVatSatang: 0,
  vatRateBpSnapshot: 0,
  vatAmountSatang: 0,
  totalSatang: 0,
  discountSatang: 0,
  isVatInclusive: true,
  receiptNo: null,
  lines: [],
  ...overrides,
});

const openBill = () =>
  enqueue({
    kind: 'createOrder',
    orderId: BILL_ID,
    tableId: null,
    channel: 'TAKEAWAY',
    tableName: null,
  });

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();
  useSync.setState({ online: true, pending: 0, rejected: [], syncing: false, lastSyncedAt: null });
});

describe('flushing', () => {
  it('brings the bill number back from the server', async () => {
    // The one thing a bill taken offline is missing. Until this lands, the
    // screen honestly says it has no number.
    await putOrder(order({ orderNo: null }), true);
    await openBill();
    vi.mocked(api.call).mockResolvedValue({ ok: true, data: { order: order() } });

    await useSync.getState().flush();

    const stored = await getOrder(BILL_ID);
    expect(stored?.orderNo).toBe('260730-004');
    expect(stored?.unsynced).toBe(false);
    expect(useSync.getState().pending).toBe(0);
    expect(useSync.getState().online).toBe(true);
  });

  it('reports offline and keeps the work', async () => {
    await putOrder(order({ orderNo: null }), true);
    await openBill();
    vi.mocked(api.call).mockResolvedValue({ ok: false, error: 'failed to fetch', offline: true });

    await useSync.getState().flush();

    expect(useSync.getState().online).toBe(false);
    expect(useSync.getState().pending).toBe(1);
    expect((await getOrder(BILL_ID))?.unsynced).toBe(true);
  });

  it('surfaces a refusal as one entry per bill, with the server’s words', async () => {
    await openBill();
    vi.mocked(api.call).mockResolvedValue({
      ok: false,
      error: 'โต๊ะ A1 มีบิลค้างอยู่แล้ว (260730-002)',
      offline: false,
      status: 409,
    });

    await useSync.getState().flush();

    expect(useSync.getState().rejected).toEqual([
      { orderId: BILL_ID, message: 'โต๊ะ A1 มีบิลค้างอยู่แล้ว (260730-002)', count: 1 },
    ]);
    // Still online — the server answered, it just said no.
    expect(useSync.getState().online).toBe(true);
  });

  it('notices the server is back even with an empty queue', async () => {
    // This is what re-enables the pay button after an outage; without it the
    // till would stay locked until somebody happened to place an order.
    useSync.setState({ online: false });
    vi.mocked(api.health).mockResolvedValue({ ok: true, data: { status: 'ok' } as never });

    await useSync.getState().flush();

    expect(useSync.getState().online).toBe(true);
    expect(api.call).not.toHaveBeenCalled();
  });

  it('notices the server has GONE before anyone tries to take money', async () => {
    // Nothing is queued and everything looks fine — the heartbeat is the only
    // thing that can tell a cashier the till cannot issue a receipt right now.
    vi.mocked(api.health).mockResolvedValue({ ok: false, error: 'failed', offline: true });

    await useSync.getState().flush();

    expect(useSync.getState().online).toBe(false);
  });
});

describe('recovering', () => {
  it('takes the server’s version when staff discard their queued changes', async () => {
    await putOrder(order({ orderNo: null, totalSatang: 9900 }), true);
    await openBill();
    vi.mocked(api.call).mockResolvedValue({
      ok: false,
      error: 'โต๊ะ A1 มีบิลค้างอยู่แล้ว',
      offline: false,
      status: 409,
    });
    await useSync.getState().flush();

    vi.mocked(api.getOrder).mockResolvedValue({ ok: true, data: { order: order() } });
    await useSync.getState().discard(BILL_ID);

    expect(useSync.getState().rejected).toEqual([]);
    expect((await getOrder(BILL_ID))?.totalSatang).toBe(0);
  });
});

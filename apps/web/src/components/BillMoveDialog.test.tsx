/**
 * ย้ายโต๊ะ · รวมบิล · แยกบิล on the screen.
 *
 * The assertions that matter are the ones about what the cashier is told
 * BEFORE committing: that a destination table already has bills on it, that
 * splitting every line off is not allowed, and what each half will come to.
 * The arithmetic itself belongs to the server and is proved there.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, OrderLineDto, TableDto } from '@pos/shared';
import { api } from '../api-client.js';
import { clearLocalData, getOrder } from '../offline/db.js';
import { MergeBillDialog, MoveTableDialog, SplitBillDialog } from './BillMoveDialog.js';

vi.mock('../api-client.js', () => ({
  api: { moveBillToTable: vi.fn(), mergeBills: vi.fn(), splitBill: vi.fn() },
}));

const id = (n: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${String(n).padStart(2, '0')}`;

function line(overrides: Partial<OrderLineDto> & { id: string }): OrderLineDto {
  return {
    menuItemId: id(90),
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

const NOODLES = line({ id: id(1) });
const WATER = line({
  id: id(2),
  nameSnapshot: 'น้ำเปล่า',
  unitPriceSatang: 1000,
  lineTotalSatang: 1000,
});

const BILL: OrderDto = {
  id: id(10),
  orderNo: '260730-001',
  branchId: id(80),
  tableId: id(20),
  tableName: 'A1',
  channel: 'DINE_IN',
  status: 'OPEN',
  businessDate: '2026-07-30',
  openedAt: '2026-07-30T05:00:00.000Z',
  paidAt: null,
  note: null,
  subtotalExVatSatang: 6000,
  vatRateBpSnapshot: 0,
  vatAmountSatang: 0,
  totalSatang: 6000,
  discountSatang: 0,
  isVatInclusive: true,
  receiptNo: null,
  lines: [NOODLES, WATER],
};

const table = (n: number, name: string, bills: number): TableDto => ({
  id: id(n),
  name,
  zone: 'ในร้าน',
  seats: 4,
  openOrder: null,
  openOrders: Array.from({ length: bills }, (_, index) => ({
    id: id(50 + index),
    orderNo: `260730-0${index + 2}`,
    totalSatang: 12000,
    lineCount: 2,
    openedAt: '2026-07-30T05:00:00.000Z',
  })),
});

const TABLES: TableDto[] = [table(20, 'A1', 1), table(21, 'A2', 0), table(22, 'A3', 2)];

async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */

describe('ย้ายโต๊ะ', () => {
  const show = (onDone = vi.fn()): { onDone: ReturnType<typeof vi.fn> } => {
    render(<MoveTableDialog order={BILL} tables={TABLES} onClose={vi.fn()} onDone={onDone} />);
    return { onDone };
  };

  it('does not offer the table the bill is already on', () => {
    show();
    expect(screen.queryByRole('button', { name: /A1/ })).toBeNull();
    expect(screen.getByRole('button', { name: /A2/ })).toBeInTheDocument();
  });

  it('says which destinations already have bills on them', () => {
    // A legal destination, but the cashier should know before tapping.
    show();
    expect(screen.getByRole('button', { name: /A3/ })).toHaveTextContent('มี 2 บิล');
    expect(screen.getByRole('button', { name: /A2/ })).toHaveTextContent('ว่าง');
  });

  it('will not move anywhere until a table is chosen', () => {
    show();
    expect(screen.getByRole('button', { name: 'ย้าย' })).toBeDisabled();
  });

  it('sends the move and updates the copy on this device', async () => {
    const moved = { ...BILL, tableId: id(21), tableName: 'A2' };
    vi.mocked(api.moveBillToTable).mockResolvedValue({ ok: true, data: { order: moved } });

    const { onDone } = show();
    await tap(screen.getByRole('button', { name: /A2/ }));
    await tap(screen.getByRole('button', { name: 'ย้าย' }));

    expect(api.moveBillToTable).toHaveBeenCalledWith(BILL.id, { tableId: id(21) });
    // Without this the order screen keeps drawing the bill at the old table.
    expect((await getOrder(BILL.id))?.tableName).toBe('A2');
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('A2'));
  });

  it('keeps the server’s complaint on screen instead of closing', async () => {
    vi.mocked(api.moveBillToTable).mockResolvedValue({
      ok: false,
      error: 'ไม่พบโต๊ะนี้ หรือโต๊ะถูกปิดใช้งาน',
      offline: false,
    });

    const { onDone } = show();
    await tap(screen.getByRole('button', { name: /A2/ }));
    await tap(screen.getByRole('button', { name: 'ย้าย' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ไม่พบโต๊ะนี้');
    expect(onDone).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */

describe('รวมบิล', () => {
  const OTHER: OrderDto = {
    ...BILL,
    id: id(11),
    orderNo: '260730-002',
    tableId: id(21),
    tableName: 'A2',
    totalSatang: 9000,
  };

  it('lists the other open bills with what each is worth', () => {
    render(
      <MergeBillDialog
        order={BILL}
        candidates={[BILL, OTHER]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    // Never itself.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByRole('button', { name: /260730-001/ })).toBeNull();
    expect(dialog.getByRole('button', { name: /260730-002/ })).toHaveTextContent('90.00');
  });

  it('says plainly that the chosen bill will be cancelled', () => {
    render(
      <MergeBillDialog order={BILL} candidates={[OTHER]} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    expect(screen.getByText(/บิลที่เลือกจะถูกยกเลิก/)).toBeInTheDocument();
  });

  it('forgets the absorbed bill on this device', async () => {
    vi.mocked(api.mergeBills).mockResolvedValue({ ok: true, data: { order: BILL } });

    render(
      <MergeBillDialog order={BILL} candidates={[OTHER]} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    await tap(screen.getByRole('button', { name: /260730-002/ }));
    await tap(screen.getByRole('button', { name: 'รวมเข้าบิลนี้' }));

    expect(api.mergeBills).toHaveBeenCalledWith(BILL.id, { fromOrderId: OTHER.id });
    // A cancelled bill left in the mirror would keep drawing a table as busy.
    expect(await getOrder(OTHER.id)).toBeUndefined();
  });

  it('says so when there is nothing to merge with', () => {
    render(<MergeBillDialog order={BILL} candidates={[BILL]} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText('ตอนนี้ไม่มีบิลอื่นที่เปิดอยู่')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe('แยกบิล', () => {
  const show = (order: OrderDto = BILL, onDone = vi.fn()) => {
    render(<SplitBillDialog order={order} onClose={vi.fn()} onDone={onDone} />);
    return { onDone };
  };

  it('will not split with nothing ticked', () => {
    show();
    expect(screen.getByRole('button', { name: /แยก/ })).toBeDisabled();
  });

  it('shows what each half will come to before anything is sent', async () => {
    show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));

    // ฿60 bill, ฿10 of water off it.
    expect(screen.getByText(/บิลใหม่ 10.00/)).toBeInTheDocument();
    expect(screen.getByText(/บิลเดิมเหลือ 50.00/)).toBeInTheDocument();
  });

  it('refuses to move every line off, and says why on the spot', async () => {
    // The same sentence the server would have sent back, before the round trip.
    show();
    await tap(screen.getByRole('button', { name: /ก๋วยเตี๋ยวหมู/ }));
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));

    expect(screen.getByText(/แยกทุกรายการออกไม่ได้/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /แยก/ })).toBeDisabled();
  });

  it('refuses to cut up a discounted bill and points at the fix', () => {
    show({ ...BILL, discountSatang: 2000 });
    expect(screen.getByText(/ยกเลิกส่วนลดก่อน/)).toBeInTheDocument();
  });

  it('does not offer a voided line at all', () => {
    const voided = line({ id: id(3), nameSnapshot: 'เกี๊ยวทอด', voidedAt: '2026-07-30T06:00:00Z' });
    show({ ...BILL, lines: [...BILL.lines, voided] });
    expect(screen.queryByRole('button', { name: /เกี๊ยวทอด/ })).toBeNull();
  });

  it('sends a client-generated id so a retry cannot split twice (rule #6)', async () => {
    const newOrder = { ...BILL, id: id(12), orderNo: '260730-002', lines: [WATER] };
    vi.mocked(api.splitBill).mockResolvedValue({ ok: true, data: { order: BILL, newOrder } });

    const { onDone } = show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));
    await tap(screen.getByRole('button', { name: /แยกออก/ }));

    const sent = vi.mocked(api.splitBill).mock.calls[0]?.[1] as {
      newOrderId: string;
      lineIds: string[];
    };
    expect(sent.newOrderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.lineIds).toEqual([WATER.id]);

    // Both halves land on the device, so the screen it navigates to has one.
    expect(await getOrder(newOrder.id)).toBeTruthy();
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('260730-002'), newOrder.id);
  });

  it('keeps a rejection on screen', async () => {
    vi.mocked(api.splitBill).mockResolvedValue({
      ok: false,
      error: 'บิลนี้ชำระเงินแล้ว',
      offline: false,
    });

    show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));
    await tap(screen.getByRole('button', { name: /แยกออก/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('บิลนี้ชำระเงินแล้ว');
  });
});

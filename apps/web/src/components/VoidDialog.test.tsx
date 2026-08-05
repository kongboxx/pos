/**
 * The void approval dialog.
 *
 * This is the one screen standing between a cashier and money leaving the day's
 * takings, so what is tested is what it refuses: an unexplained "อื่นๆ", a
 * cashier as their own approver, and a wrong PIN left visible for the next
 * person to read.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, OrderLineDto, StaffPublic } from '@pos/shared';
import { api } from '../api-client.js';
import { getOrder } from '../offline/db.js';
import { clearLocalData } from '../offline/db.js';
import { VoidDialog } from './VoidDialog.js';

vi.mock('../api-client.js', () => ({
  api: { staffList: vi.fn(), voidLine: vi.fn() },
}));

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const STAFF: StaffPublic[] = [
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    fullName: 'อ่อง มิน',
    nickname: 'อ่อง',
    role: 'STAFF',
  },
  { id: MANAGER_ID, fullName: 'สมหญิง ใจดี', nickname: 'หญิง', role: 'MANAGER' },
];

const LINE: OrderLineDto = {
  id: LINE_ID,
  menuItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nameSnapshot: 'ก๋วยเตี๋ยวหมู',
  qty: 2,
  unitPriceSatang: 5000,
  lineTotalSatang: 10000,
  note: null,
  firedAt: '2026-07-30T05:01:00.000Z',
  source: 'STAFF',
  approvedAt: null,
  voidedAt: null,
  modifiers: [],
};

const ORDER: OrderDto = {
  id: ORDER_ID,
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
  subtotalExVatSatang: 10000,
  vatRateBpSnapshot: 0,
  vatAmountSatang: 0,
  totalSatang: 10000,
  discountSatang: 0,
  isVatInclusive: true,
  receiptNo: null,
  lines: [LINE],
};

const onVoided = vi.fn();

async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

async function typePin(pin: string): Promise<void> {
  for (const digit of pin) {
    await tap(screen.getByRole('button', { name: digit }));
  }
}

async function renderDialog(line: OrderLineDto = LINE): Promise<void> {
  render(<VoidDialog order={ORDER} line={line} onClose={vi.fn()} onVoided={onVoided} />);
  // The approver list arrives before anything can be approved.
  await waitFor(() => expect(api.staffList).toHaveBeenCalled());
}

/** Gets as far as the approver step with a plain reason chosen. */
async function chooseReason(reason = 'ทำผิดเมนู'): Promise<void> {
  await tap(
    within(screen.getByRole('region', { name: 'เหตุผล' })).getByRole('button', { name: reason }),
  );
  await tap(screen.getByRole('button', { name: 'ถัดไป' }));
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();
  vi.mocked(api.staffList).mockResolvedValue({
    ok: true,
    data: { branch: { id: 'b-1', name: 'ร้าน', branchCode: 'HQ' }, staff: STAFF },
  });
});

describe('choosing a reason', () => {
  it('will not move on until one is picked', async () => {
    await renderDialog();
    expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeDisabled();
  });

  it('makes "อื่นๆ" carry a written explanation', async () => {
    // Free text on every void would make the month-end question unanswerable;
    // an "อื่นๆ" with nothing written is the same problem wearing a label.
    await renderDialog();
    const reasons = within(screen.getByRole('region', { name: 'เหตุผล' }));
    await tap(reasons.getByRole('button', { name: 'อื่นๆ' }));

    expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeDisabled();

    const user = userEvent.setup();
    await act(async () => {
      await user.type(screen.getByRole('textbox'), 'ลูกค้าแพ้ถั่ว');
    });

    expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled();
  });

  it('warns that the kitchen already has this one', async () => {
    await renderDialog();
    expect(screen.getByText(/ส่งครัวไปแล้ว/)).toBeInTheDocument();
  });

  it('says nothing about the kitchen for a line that was never sent', async () => {
    await renderDialog({ ...LINE, firedAt: null });
    expect(screen.queryByText(/ส่งครัวไปแล้ว/)).not.toBeInTheDocument();
  });
});

describe('approving', () => {
  it('offers only people whose role can approve', async () => {
    // A second cashier walking past is not a supervisor.
    await renderDialog();
    await chooseReason();

    const approvers = within(screen.getByRole('region', { name: 'ผู้อนุมัติ' }));
    expect(approvers.getByRole('button', { name: 'หญิง' })).toBeInTheDocument();
    expect(approvers.queryByRole('button', { name: 'อ่อง' })).not.toBeInTheDocument();
  });

  it('sends the void once the fourth digit lands, and stores the new bill', async () => {
    const voided: OrderDto = { ...ORDER, totalSatang: 0, lines: [{ ...LINE, voidedAt: 'now' }] };
    vi.mocked(api.voidLine).mockResolvedValue({ ok: true, data: { order: voided } });

    await renderDialog();
    await chooseReason('ของหมด');
    await tap(screen.getByRole('button', { name: 'หญิง' }));
    await typePin('2222');

    expect(api.voidLine).toHaveBeenCalledWith(ORDER_ID, LINE_ID, {
      reason: 'ของหมด',
      note: null,
      approverStaffId: MANAGER_ID,
      approverPin: '2222',
    });
    // The server's bill is now the truth AND it is already synced, so it goes
    // to the device directly rather than round-tripping through the outbox.
    await waitFor(async () => expect((await getOrder(ORDER_ID))?.totalSatang).toBe(0));
    expect(await getOrder(ORDER_ID)).toMatchObject({ unsynced: false });
    expect(onVoided).toHaveBeenCalled();
  });

  it('sends exactly one request for one four-digit entry', async () => {
    // It sent two. The submit was running inside a setState updater, which
    // React is free to call more than once, so a wrong PIN burned two of the
    // five attempts and locked the manager out after three tries. Found by
    // watching the server log during a real void, not by any test.
    vi.mocked(api.voidLine).mockResolvedValue({ ok: true, data: { order: ORDER } });

    await renderDialog();
    await chooseReason();
    await tap(screen.getByRole('button', { name: 'หญิง' }));
    await typePin('2222');

    expect(api.voidLine).toHaveBeenCalledTimes(1);
  });

  it('leaves the error in place while the next PIN is typed', async () => {
    // Clearing it on the first digit removes a line of text and slides the
    // keypad up under a finger that is already moving to the second digit.
    vi.mocked(api.voidLine).mockResolvedValue({
      ok: false,
      error: 'PIN ผู้อนุมัติไม่ถูกต้อง',
      offline: false,
      status: 401,
    });

    await renderDialog();
    await chooseReason();
    await tap(screen.getByRole('button', { name: 'หญิง' }));
    await typePin('9999');
    await screen.findByRole('alert');

    await tap(screen.getByRole('button', { name: '2' }));

    expect(screen.getByRole('alert')).toHaveTextContent('PIN ผู้อนุมัติไม่ถูกต้อง');
  });

  it('clears a rejected PIN off the screen', async () => {
    vi.mocked(api.voidLine).mockResolvedValue({
      ok: false,
      error: 'PIN ผู้อนุมัติไม่ถูกต้อง',
      offline: false,
      status: 401,
    });

    await renderDialog();
    await chooseReason();
    await tap(screen.getByRole('button', { name: 'หญิง' }));
    await typePin('9999');

    expect(await screen.findByRole('alert')).toHaveTextContent('PIN ผู้อนุมัติไม่ถูกต้อง');
    // A wrong PIN left on screen is the next person's hint.
    const filled = screen
      .getAllByTestId('approver-pin-dot')
      .filter((dot) => dot.dataset['filled'] === 'true');
    expect(filled).toHaveLength(0);
    expect(onVoided).not.toHaveBeenCalled();
  });

  it('goes back to the reason without losing the dialog', async () => {
    await renderDialog();
    await chooseReason();
    await tap(screen.getByRole('button', { name: '← เปลี่ยนเหตุผล' }));
    expect(screen.getByRole('region', { name: 'เหตุผล' })).toBeInTheDocument();
  });
});

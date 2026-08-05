/**
 * The discount approval dialog.
 *
 * This is the other screen standing between a cashier and the day's takings, so
 * what is tested is what it refuses: a discount bigger than the bill, an
 * unexplained "อื่นๆ", an amount carried across when the unit changes, and a
 * PIN left on screen for the next person to read.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, StaffPublic } from '@pos/shared';
import { api } from '../api-client.js';
import { clearLocalData, getOrder } from '../offline/db.js';
import { DiscountDialog } from './DiscountDialog.js';

vi.mock('../api-client.js', () => ({
  api: { staffList: vi.fn(), setDiscount: vi.fn() },
}));

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

/** A bill worth ฿235.00 with nothing taken off it yet. */
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
  subtotalExVatSatang: 23500,
  vatRateBpSnapshot: 0,
  vatAmountSatang: 0,
  totalSatang: 23500,
  discountSatang: 0,
  isVatInclusive: true,
  receiptNo: null,
  lines: [],
};

const onDone = vi.fn();

async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

async function type(element: HTMLElement, text: string): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.clear(element);
    await user.type(element, text);
  });
}

async function typePin(pin: string): Promise<void> {
  for (const digit of pin) {
    await tap(screen.getByRole('button', { name: digit }));
  }
}

async function renderDialog(order: OrderDto = ORDER): Promise<void> {
  render(<DiscountDialog order={order} onClose={vi.fn()} onDone={onDone} />);
  await waitFor(() => expect(api.staffList).toHaveBeenCalled());
}

const amountBox = () => screen.getByRole('textbox');
const nextButton = () => screen.getByRole('button', { name: 'ถัดไป' });
const reasons = () => within(screen.getByRole('region', { name: 'จำนวนที่ลด' }));

/** Fills in an ordinary ฿20-for-a-regular and gets to the keypad. */
async function reachKeypad(): Promise<void> {
  await type(amountBox(), '20');
  await tap(reasons().getByRole('button', { name: 'ลูกค้าประจำ' }));
  await tap(nextButton());
  await tap(screen.getByRole('button', { name: 'หญิง' }));
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();
  vi.mocked(api.staffList).mockResolvedValue({
    ok: true,
    data: { branch: { id: 'b-1', name: 'ร้าน', branchCode: 'HQ' }, staff: STAFF },
  });
  vi.mocked(api.setDiscount).mockResolvedValue({
    ok: true,
    data: { order: { ...ORDER, discountSatang: 2000, totalSatang: 21500 } },
  });
});

describe('deciding how much', () => {
  it('will not move on with nothing typed', async () => {
    await renderDialog();
    await tap(reasons().getByRole('button', { name: 'ลูกค้าประจำ' }));
    expect(nextButton()).toBeDisabled();
  });

  it('will not move on without a reason', async () => {
    await renderDialog();
    await type(amountBox(), '20');
    expect(nextButton()).toBeDisabled();
  });

  it('shows what the customer will actually pay before anyone signs', async () => {
    await renderDialog();
    await type(amountBox(), '20');
    expect(screen.getByText(/ลูกค้าจ่าย/)).toHaveTextContent('215.00');
  });

  it('refuses a discount bigger than the bill, on screen, before the round trip', async () => {
    await renderDialog();
    await type(amountBox(), '300');
    await tap(reasons().getByRole('button', { name: 'ลูกค้าประจำ' }));

    expect(screen.getByText(/มากกว่ายอดบิล/)).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();
  });

  it('makes "อื่นๆ" carry a written explanation', async () => {
    await renderDialog();
    await type(amountBox(), '20');
    await tap(reasons().getByRole('button', { name: 'อื่นๆ' }));
    expect(nextButton()).toBeDisabled();

    // Two boxes on screen once "อื่นๆ" is picked: the amount, then the note.
    await type(screen.getAllByRole('textbox')[1] as HTMLElement, 'เจ้าของสั่ง');
    expect(nextButton()).toBeEnabled();
  });
});

describe('percent instead of baht', () => {
  it('works the percentage out against the bill', async () => {
    await renderDialog();
    await tap(screen.getByRole('button', { name: 'ลดเป็น %' }));
    await type(amountBox(), '10');
    expect(screen.getByText(/ลูกค้าจ่าย/)).toHaveTextContent('211.50');
  });

  it('fills the box from a quick button', async () => {
    await renderDialog();
    await tap(screen.getByRole('button', { name: 'ลดเป็น %' }));
    await tap(screen.getByRole('button', { name: '20%' }));
    expect(amountBox()).toHaveValue('20');
  });

  it('clears the box when the unit changes — 20 baht is not 20 percent', async () => {
    // Carrying it across is how "ลดยี่สิบ" quietly becomes ฿47 off.
    await renderDialog();
    await type(amountBox(), '20');
    await tap(screen.getByRole('button', { name: 'ลดเป็น %' }));
    expect(amountBox()).toHaveValue('');
  });

  it('sends basis points, and lets the server resolve them', async () => {
    await renderDialog();
    await tap(screen.getByRole('button', { name: 'ลดเป็น %' }));
    await type(amountBox(), '10');
    await tap(reasons().getByRole('button', { name: 'ลูกค้าประจำ' }));
    await tap(nextButton());
    await tap(screen.getByRole('button', { name: 'หญิง' }));
    await typePin('1234');

    expect(api.setDiscount).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ mode: 'PERCENT', value: 1000 }),
    );
  });

  it('refuses more than 100%', async () => {
    await renderDialog();
    await tap(screen.getByRole('button', { name: 'ลดเป็น %' }));
    await type(amountBox(), '150');
    await tap(reasons().getByRole('button', { name: 'ลูกค้าประจำ' }));
    expect(nextButton()).toBeDisabled();
  });
});

describe('the approval', () => {
  it('only offers people who may approve one', async () => {
    await renderDialog();
    await type(amountBox(), '20');
    await tap(reasons().getByRole('button', { name: 'ลูกค้าประจำ' }));
    await tap(nextButton());

    const approvers = within(screen.getByRole('region', { name: 'ผู้อนุมัติ' }));
    expect(approvers.getByRole('button', { name: 'หญิง' })).toBeInTheDocument();
    expect(approvers.queryByRole('button', { name: 'อ่อง' })).toBeNull();
  });

  it('sends on the fourth digit and stores the bill the server sent back', async () => {
    await renderDialog();
    await reachKeypad();
    await typePin('1234');

    expect(api.setDiscount).toHaveBeenCalledTimes(1);
    expect(api.setDiscount).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({
        mode: 'AMOUNT',
        value: 2000,
        reason: 'ลูกค้าประจำ',
        approverStaffId: MANAGER_ID,
        approverPin: '1234',
      }),
    );

    // The server's bill is now the truth AND it is already synced, so it goes
    // to the device directly rather than round-tripping through the outbox.
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await getOrder(ORDER_ID)).toMatchObject({ discountSatang: 2000, unsynced: false });
  });

  it('clears the PIN and keeps the bill untouched when it is wrong', async () => {
    vi.mocked(api.setDiscount).mockResolvedValue({
      ok: false,
      error: 'PIN ผู้อนุมัติไม่ถูกต้อง',
      offline: false,
    });
    await renderDialog();
    await reachKeypad();
    await typePin('9999');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // A PIN left on screen is the next person's hint.
    for (const dot of screen.getAllByTestId('approver-pin-dot')) {
      expect(dot).toHaveAttribute('data-filled', 'false');
    }
    expect(onDone).not.toHaveBeenCalled();
    expect(await getOrder(ORDER_ID)).toBeUndefined();
  });
});

describe('a bill that already has a discount', () => {
  const discounted: OrderDto = { ...ORDER, totalSatang: 21500, discountSatang: 2000 };

  it('measures a new one against the bill, not against the discounted total', async () => {
    // 10% of 235.00, not 10% of 215.00 — otherwise the same words mean less
    // the second time they are said.
    await renderDialog(discounted);
    await tap(screen.getByRole('button', { name: 'ลดเป็น %' }));
    await type(amountBox(), '10');
    expect(screen.getByText(/ลูกค้าจ่าย/)).toHaveTextContent('211.50');
  });

  it('says the new one will replace the old, not stack on it', async () => {
    await renderDialog(discounted);
    expect(screen.getByText(/แทนที่ของเดิม/)).toBeInTheDocument();
  });
});

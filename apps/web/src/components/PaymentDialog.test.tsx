/**
 * The payment dialog.
 *
 * The change figure is the number a cashier trusts without recounting, so it
 * gets tested here as well as on the server. The confirm button staying
 * disabled on short cash is the other half: the API rejects it anyway, but a
 * button that can be pressed and then fails costs a queue thirty seconds.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto } from '@pos/shared';
import { api } from '../api-client.js';
import { PaymentDialog } from './PaymentDialog.js';

vi.mock('../api-client.js', () => ({
  api: { pay: vi.fn(), promptPayQr: vi.fn() },
}));

// 235.00 baht.
const ORDER = {
  id: '22222222-2222-4222-8222-222222222222',
  totalSatang: 23500,
  lines: [],
} as unknown as OrderDto;

beforeEach(() => {
  vi.mocked(api.promptPayQr).mockResolvedValue({
    ok: true,
    data: { payload: '00020101021254062350006304ABCD', amountSatang: 23500 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderDialog() {
  return render(<PaymentDialog order={ORDER} onClose={vi.fn()} onPaid={vi.fn()} />);
}

async function typeAmount(digits: string): Promise<void> {
  const user = userEvent.setup();
  for (const digit of digits) {
    await user.click(screen.getByRole('button', { name: digit }));
  }
}

describe('cash', () => {
  it('shows the amount due', () => {
    renderDialog();
    expect(screen.getByText('235.00')).toBeInTheDocument();
  });

  it('computes the change from whole baht typed on the keypad', async () => {
    renderDialog();
    await typeAmount('500');
    // 500.00 - 235.00 = 265.00
    await waitFor(() => expect(screen.getByText('265.00')).toBeInTheDocument());
  });

  it('keeps confirm disabled while the cash does not cover the bill', async () => {
    renderDialog();
    await typeAmount('200');

    const confirm = screen.getByRole('button', { name: 'ยืนยันรับเงิน' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText('เงินที่รับมายังไม่พอ')).toBeInTheDocument();
  });

  it('fills the exact amount in one tap', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'พอดี' }));

    expect(screen.getByRole('button', { name: 'ยืนยันรับเงิน' })).toBeEnabled();
    // Change is zero, not blank — the cashier should see a number either way.
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('sends the received amount in satang and shows the change afterwards', async () => {
    const user = userEvent.setup();
    vi.mocked(api.pay).mockResolvedValue({
      ok: true,
      data: {
        order: ORDER,
        receiptNo: 'RC-HQ-2026-000123',
        changeSatang: 26500,
        printJobId: '33333333-3333-4333-8333-333333333333',
      },
    });

    renderDialog();
    await typeAmount('500');
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับเงิน' }));

    await waitFor(() => {
      expect(api.pay).toHaveBeenCalledWith(
        ORDER.id,
        expect.objectContaining({ method: 'CASH', receivedSatang: 50000 }),
      );
    });
    expect(await screen.findByText('RC-HQ-2026-000123', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('265.00')).toBeInTheDocument();
  });

  it('says the sale was recorded even when the receipt could not be queued', async () => {
    const user = userEvent.setup();
    vi.mocked(api.pay).mockResolvedValue({
      ok: true,
      data: {
        order: ORDER,
        receiptNo: 'RC-HQ-2026-000124',
        changeSatang: 0,
        printJobId: null,
      },
    });

    renderDialog();
    await user.click(screen.getByRole('button', { name: 'พอดี' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับเงิน' }));

    // The money changed hands. A print failure must never read as a failed sale.
    expect(await screen.findByText(/บันทึกการชำระเงินแล้ว/)).toBeInTheDocument();
  });
});

describe('promptpay', () => {
  it('fetches the QR from the server rather than building it on the device', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'พร้อมเพย์' }));

    await waitFor(() => expect(api.promptPayQr).toHaveBeenCalledWith(ORDER.id));
    expect(await screen.findByText(/ยอดถูกล็อกไว้ที่ 235.00 บาท/)).toBeInTheDocument();
  });

  it('warns that slips are not verified automatically', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'พร้อมเพย์' }));

    expect(await screen.findByText(/ยังไม่ตรวจสลิปอัตโนมัติ/)).toBeInTheDocument();
  });

  it('can be confirmed without typing an amount', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'พร้อมเพย์' }));

    expect(screen.getByRole('button', { name: 'ยืนยันรับเงิน' })).toBeEnabled();
  });
});

/**
 * บิลที่ปิดแล้ว.
 *
 * What is worth testing here is what the screen refuses to offer:
 *
 *  - a bill closed before the shop charged VAT must not show an "ออกใบกำกับภาษี"
 *    button, because the server will refuse it and the cashier will have made
 *    the promise to the customer already;
 *  - a bill that already has a tax invoice must not offer a second one;
 *  - a reversed bill stays on the list rather than vanishing, since a bill that
 *    disappears looks exactly like a bill somebody deleted.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PaidBillListResponse, PaidBillRow } from '@pos/shared';
import { api } from '../../api-client.js';
import { PaidBillsPage } from './PaidBillsPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    paidBills: vi.fn(),
    issueTaxInvoice: vi.fn(),
    issueCreditNote: vi.fn(),
    staffList: vi.fn(),
  },
}));

let allowed = true;
vi.mock('../../session-store.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({ branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 }, can: () => allowed }),
}));

function bill(over: Partial<PaidBillRow> = {}): PaidBillRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orderNo: '260730-004',
    receiptNo: 'RC-HQ-2026-000123',
    tableName: 'A1',
    channel: 'ทานที่ร้าน',
    paidAt: '2026-07-30T05:30:00.000Z',
    status: 'PAID',
    totalSatang: 23_500,
    vatAmountSatang: 1_537,
    vatRateBpSnapshot: 700,
    itemCount: 3,
    taxInvoiceNo: null,
    customerName: null,
    creditNoteNo: null,
    ...over,
  };
}

function list(rows: PaidBillRow[], vatActive = true): PaidBillListResponse {
  return { businessDate: '2026-07-30', vatActive, rows };
}

async function show(data: PaidBillListResponse): Promise<void> {
  vi.mocked(api.paidBills).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <PaidBillsPage />
    </MemoryRouter>,
  );
  await screen.findByText('RC-HQ-2026-000123');
}

beforeEach(() => {
  allowed = true;
  vi.clearAllMocks();
  vi.mocked(api.staffList).mockResolvedValue({
    ok: true,
    data: {
      branch: { id: 'b', name: 'ร้าน', branchCode: 'HQ' },
      staff: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          fullName: 'พี่ชาย เจ้าของร้าน',
          nickname: 'พี่ชาย',
          role: 'OWNER',
        },
      ],
    },
  });
});

describe('the day’s closed bills', () => {
  it('shows the receipt number, the total and the item count', async () => {
    await show(list([bill()]));

    expect(screen.getByText(/260730-004/)).toBeInTheDocument();
    expect(screen.getByText('235.00')).toBeInTheDocument();
    expect(screen.getByText(/3 รายการ/)).toBeInTheDocument();
  });

  it('offers no tax invoice on a bill closed before the shop charged VAT', async () => {
    // The server refuses this, and finding that out AFTER promising the
    // customer a document is the failure worth designing out.
    await show(list([bill({ vatRateBpSnapshot: 0, vatAmountSatang: 0 })], false));

    expect(screen.queryByRole('button', { name: 'ออกใบกำกับภาษี' })).not.toBeInTheDocument();
    expect(screen.getByText(/ออกใบกำกับภาษีเต็มรูปไม่ได้/)).toBeInTheDocument();
  });

  it('offers no second tax invoice once one exists, and names the buyer', async () => {
    await show(
      list([bill({ taxInvoiceNo: 'TX-HQ-2026-000001', customerName: 'บริษัท ทดสอบ จำกัด' })]),
    );

    expect(screen.getByText(/TX-HQ-2026-000001/)).toBeInTheDocument();
    expect(screen.getByText(/บริษัท ทดสอบ จำกัด/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ออกใบกำกับภาษี' })).not.toBeInTheDocument();
  });

  it('keeps a reversed bill on the list with its credit note number', async () => {
    await show(list([bill({ status: 'CANCELLED', creditNoteNo: 'CN-HQ-2026-000001' })]));

    expect(screen.getByText(/CN-HQ-2026-000001/)).toBeInTheDocument();
    // Nothing more can be done to it, so nothing is offered.
    expect(screen.queryByRole('button', { name: 'ออกใบลดหนี้' })).not.toBeInTheDocument();
  });

  it('hides both buttons from a cashier who may not issue documents', async () => {
    allowed = false;
    await show(list([bill()]));

    expect(screen.queryByRole('button', { name: 'ออกใบกำกับภาษี' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ออกใบลดหนี้' })).not.toBeInTheDocument();
  });
});

describe('asking for a full tax invoice', () => {
  it('refuses to send a tax id whose check digit is wrong', async () => {
    const user = userEvent.setup();
    await show(list([bill()]));
    await user.click(screen.getByRole('button', { name: 'ออกใบกำกับภาษี' }));

    const dialog = screen.getByRole('dialog', { name: 'ออกใบกำกับภาษี' });
    await user.type(within(dialog).getByLabelText(/ชื่อผู้ซื้อ/), 'บริษัท ทดสอบ จำกัด');
    await user.type(within(dialog).getByLabelText(/เลขประจำตัวผู้เสียภาษี/), '0105558123401');

    expect(within(dialog).getByText(/เลขไม่ถูกต้อง/)).toBeInTheDocument();
    // Catching it here costs a retype; catching it tomorrow costs a credit
    // note plus a reissue.
    expect(within(dialog).getByRole('button', { name: 'ออกใบกำกับภาษี' })).toBeDisabled();
  });

  it('sends สำนักงานใหญ่ by default and reports the number it got back', async () => {
    const user = userEvent.setup();
    vi.mocked(api.issueTaxInvoice).mockResolvedValue({
      ok: true,
      data: {
        taxInvoice: {
          orderId: bill().id,
          taxInvoiceNo: 'TX-HQ-2026-000009',
          receiptNo: 'RC-HQ-2026-000123',
          issuedAt: '2026-07-30T06:00:00.000Z',
          customerName: 'บริษัท ทดสอบ จำกัด',
          customerTaxId: '0105558123400',
          customerAddress: null,
          customerBranchLabel: 'สำนักงานใหญ่',
          businessDate: '2026-07-30',
          subtotalExVatSatang: 21_963,
          vatAmountSatang: 1_537,
          vatRateBpSnapshot: 700,
          totalSatang: 23_500,
        },
        printJobId: 'job-1',
      },
    });
    await show(list([bill()]));
    await user.click(screen.getByRole('button', { name: 'ออกใบกำกับภาษี' }));

    const dialog = screen.getByRole('dialog', { name: 'ออกใบกำกับภาษี' });
    await user.type(within(dialog).getByLabelText(/ชื่อผู้ซื้อ/), 'บริษัท ทดสอบ จำกัด');
    await user.type(within(dialog).getByLabelText(/เลขประจำตัวผู้เสียภาษี/), '0105558123400');
    await user.click(within(dialog).getByRole('button', { name: 'ออกใบกำกับภาษี' }));

    await waitFor(() =>
      expect(api.issueTaxInvoice).toHaveBeenCalledWith(bill().id, {
        customerName: 'บริษัท ทดสอบ จำกัด',
        customerTaxId: '0105558123400',
        customerAddress: null,
        customerBranchLabel: 'สำนักงานใหญ่',
      }),
    );
    expect(await screen.findByText(/TX-HQ-2026-000009/)).toBeInTheDocument();
  });
});

describe('reversing a paid bill', () => {
  it('says out loud that a bill with a tax invoice can only be credited', async () => {
    const user = userEvent.setup();
    await show(list([bill({ taxInvoiceNo: 'TX-HQ-2026-000001' })]));
    await user.click(screen.getByRole('button', { name: 'ออกใบลดหนี้' }));

    const dialog = screen.getByRole('dialog', { name: 'ออกใบลดหนี้' });
    expect(within(dialog).getByText(/ลบไม่ได้ ต้องออกใบลดหนี้เท่านั้น/)).toBeInTheDocument();
  });

  it('will not move past the reason without one, and always asks for a PIN', async () => {
    const user = userEvent.setup();
    await show(list([bill()]));
    await user.click(screen.getByRole('button', { name: 'ออกใบลดหนี้' }));

    const dialog = screen.getByRole('dialog', { name: 'ออกใบลดหนี้' });
    expect(within(dialog).getByRole('button', { name: 'ถัดไป' })).toBeDisabled();

    await user.click(within(dialog).getByText('คิดเงินผิดบิล'));
    await user.click(within(dialog).getByRole('button', { name: 'ถัดไป' }));

    // Cancelling a completed sale is never self-served (rule #8).
    expect(within(dialog).getByText('ผู้จัดการหรือเจ้าของกด PIN')).toBeInTheDocument();
  });
});

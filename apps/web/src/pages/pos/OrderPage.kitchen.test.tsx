/**
 * The till's half of Step 5.
 *
 * The line that matters on this screen is the one between "still mine" and
 * "the kitchen's". Before it, a bowl is editable and one tap changes it; after
 * it, the quantity buttons are GONE — not greyed — and the only thing on offer
 * is a void that needs a manager. Getting that boundary wrong is how a bill
 * quietly stops matching what was cooked.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MenuResponse, OrderDto, OrderLineDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { saveIdentity, saveMenu } from '../../offline/catalog.js';
import { clearLocalData, getOrder, putOrder } from '../../offline/db.js';
import { useSync } from '../../offline/sync-store.js';
import { OrderPage } from './OrderPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    call: vi.fn(),
    health: vi.fn(),
    getOrder: vi.fn(),
    menu: vi.fn(),
    fireOrder: vi.fn(),
    voidLine: vi.fn(),
    staffList: vi.fn(),
    printCheck: vi.fn(),
    promptPayQr: vi.fn(),
    pay: vi.fn(),
  },
}));

const BILL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WATER_ID = 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii';

const MENU: MenuResponse = {
  categories: [
    {
      id: 'c-1',
      name: 'เครื่องดื่ม',
      subcategories: [],
      items: [
        {
          id: WATER_ID,
          categoryId: 'c-1',
          name: 'น้ำเปล่า',
          subcategory: null,
          priceSatang: 1000,
          station: 'เครื่องดื่ม',
          isAvailable: true,
          groupIds: [],
        },
      ],
    },
  ],
  modifierGroups: [],
};

function line(overrides: Partial<OrderLineDto> = {}): OrderLineDto {
  return {
    id: 'line-1',
    menuItemId: WATER_ID,
    nameSnapshot: 'น้ำเปล่า',
    qty: 1,
    unitPriceSatang: 1000,
    lineTotalSatang: 1000,
    source: 'STAFF',
    approvedAt: null,
    note: null,
    firedAt: null,
    voidedAt: null,
    modifiers: [],
    ...overrides,
  };
}

function bill(lines: OrderLineDto[]): OrderDto {
  const total = lines
    .filter((row) => !row.voidedAt)
    .reduce((sum, row) => sum + row.lineTotalSatang, 0);
  return {
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
    subtotalExVatSatang: total,
    vatRateBpSnapshot: 0,
    vatAmountSatang: 0,
    totalSatang: total,
    discountSatang: 0,
    isVatInclusive: true,
    receiptNo: null,
    lines,
  };
}

async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

async function renderOrderPage(lines: OrderLineDto[]): Promise<void> {
  await putOrder(bill(lines), false);
  render(
    <MemoryRouter initialEntries={[`/pos/order/${BILL_ID}`]}>
      <Routes>
        <Route path="/pos/order/:orderId" element={<OrderPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'เครื่องดื่ม' });
}

/** The bill panel, so "น้ำเปล่า" cannot mean the menu tile. */
function billPanel(): HTMLElement {
  return screen.getByRole('complementary');
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();

  const dead = { ok: false as const, error: 'failed to fetch', offline: true };
  vi.mocked(api.call).mockResolvedValue(dead);
  vi.mocked(api.health).mockResolvedValue(dead);
  vi.mocked(api.getOrder).mockResolvedValue(dead);
  vi.mocked(api.menu).mockResolvedValue(dead);
  vi.mocked(api.staffList).mockResolvedValue(dead);

  useSync.setState({ online: true, pending: 0, rejected: [], syncing: false });

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
  await saveMenu(MENU);
});

describe('sending an order to the kitchen', () => {
  it('offers the button with a count of what is new', async () => {
    await renderOrderPage([line(), line({ id: 'line-2' })]);
    expect(screen.getByRole('button', { name: 'ส่งครัว (2)' })).toBeInTheDocument();
  });

  it('hides the button when everything has already gone', async () => {
    // Nothing to send means nothing to tap twice out of doubt.
    await renderOrderPage([line({ firedAt: '2026-07-30T05:01:00.000Z' })]);
    // Anchored: the fired line's own row reads "ส่งครัวแล้ว" and would match
    // a loose pattern.
    expect(screen.queryByRole('button', { name: /^ส่งครัว \(/ })).not.toBeInTheDocument();
  });

  it('writes the server’s answer to the device so the lines lock at once', async () => {
    const fired = bill([line({ firedAt: '2026-07-30T05:01:00.000Z' })]);
    vi.mocked(api.fireOrder).mockResolvedValue({
      ok: true,
      data: { order: fired, stations: ['เครื่องดื่ม'] },
    });

    await renderOrderPage([line()]);
    await tap(screen.getByRole('button', { name: 'ส่งครัว (1)' }));

    expect(api.fireOrder).toHaveBeenCalledWith(BILL_ID);
    await waitFor(async () => expect((await getOrder(BILL_ID))?.lines[0]?.firedAt).not.toBeNull());
    expect(await screen.findByText('ส่งครัวแล้ว — เครื่องดื่ม')).toBeInTheDocument();
  });

  it('shows the server’s refusal rather than pretending it worked', async () => {
    vi.mocked(api.fireOrder).mockResolvedValue({
      ok: false,
      error: 'ไม่มีรายการใหม่ที่จะส่งครัว — ส่งไปหมดแล้ว',
      offline: false,
      status: 409,
    });

    await renderOrderPage([line()]);
    await tap(screen.getByRole('button', { name: 'ส่งครัว (1)' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ส่งไปหมดแล้ว');
  });

  it('locks with an explanation while the wifi is down', async () => {
    // The kitchen screen is a different device: a ticket that only exists in
    // this tablet's memory is a ticket nobody can cook.
    useSync.setState({ online: false });
    await renderOrderPage([line()]);

    expect(screen.getByRole('button', { name: 'ส่งครัว (1)' })).toBeDisabled();
    expect(screen.getByText(/จอครัวเป็นคนละเครื่อง/)).toBeInTheDocument();
  });
});

describe('a line the kitchen already has', () => {
  const firedLine = line({ firedAt: '2026-07-30T05:01:00.000Z' });

  it('takes the quantity buttons away entirely', async () => {
    // Gone, not disabled: nobody should stab at a dead button during a rush.
    await renderOrderPage([firedLine]);
    const panel = within(billPanel());

    expect(panel.queryByLabelText('เพิ่ม น้ำเปล่า')).not.toBeInTheDocument();
    expect(panel.queryByLabelText('ลด น้ำเปล่า')).not.toBeInTheDocument();
    expect(panel.getByText('ส่งครัวแล้ว')).toBeInTheDocument();
  });

  it('offers a void instead, and opens the approval dialog', async () => {
    await renderOrderPage([firedLine]);

    await tap(within(billPanel()).getByRole('button', { name: 'ยกเลิก' }));

    expect(await screen.findByRole('dialog', { name: 'ยกเลิกรายการ' })).toBeInTheDocument();
  });

  it('will not offer a void with no way to check the PIN', async () => {
    useSync.setState({ online: false });
    await renderOrderPage([firedLine]);
    expect(within(billPanel()).getByRole('button', { name: 'ยกเลิก' })).toBeDisabled();
  });

  it('leaves a voided line on the bill, struck through', async () => {
    // It is the evidence (rule #8). A bill that simply lost the row answers
    // nothing at the end of the month.
    await renderOrderPage([line({ firedAt: '2026-07-30T05:01', voidedAt: '2026-07-30T05:05' })]);
    const panel = within(billPanel());

    expect(panel.getByText('ยกเลิกแล้ว')).toBeInTheDocument();
    expect(panel.getByText('น้ำเปล่า')).toHaveClass('line-through');
    // ...and it is not something to charge for.
    expect(screen.getByRole('button', { name: 'รับเงิน' })).toBeDisabled();
  });
});

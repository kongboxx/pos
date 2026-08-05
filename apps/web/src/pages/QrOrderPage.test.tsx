/**
 * The customer's phone.
 *
 * What is tested is what the shop loses when it breaks: an order that says it
 * was sent when it was not, a total that includes food nobody has agreed to
 * sell, a price the phone chose for itself, and a cost figure leaking onto a
 * page anyone can open.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { QrTableResponse } from '@pos/shared';
import { api } from '../api-client.js';
import { QrOrderPage } from './QrOrderPage.js';

vi.mock('../api-client.js', () => ({
  api: { qrTable: vi.fn(), qrBill: vi.fn(), qrSubmit: vi.fn() },
}));

const TOKEN = 'AbCd1234_efGH-ij';
const WATER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOODLES_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOODLE_GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const THIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function view(overrides: Partial<QrTableResponse> = {}): QrTableResponse {
  return {
    shopName: 'ร้านก๋วยเตี๋ยว',
    tableName: 'A1',
    orderingEnabled: true,
    menu: {
      categories: [
        {
          id: 'cat-1',
          name: 'ก๋วยเตี๋ยว',
          subcategories: [],
          items: [
            {
              id: NOODLES_ID,
              categoryId: 'cat-1',
              name: 'ก๋วยเตี๋ยวหมู',
              subcategory: null,
              priceSatang: 5000,
              station: 'ครัวเส้น',
              isAvailable: true,
              groupIds: [NOODLE_GROUP_ID],
            },
            {
              id: WATER_ID,
              categoryId: 'cat-1',
              name: 'น้ำเปล่า',
              subcategory: null,
              priceSatang: 1000,
              station: null,
              isAvailable: true,
              groupIds: [],
            },
          ],
        },
      ],
      modifierGroups: [
        {
          id: NOODLE_GROUP_ID,
          name: 'เส้น',
          isRequired: true,
          minSelect: 1,
          maxSelect: 1,
          isNegative: false,
          modifiers: [
            {
              id: THIN_ID,
              name: 'เส้นเล็ก',
              priceDeltaSatang: 0,
              isDefault: true,
              isAvailable: true,
            },
          ],
        },
      ],
    },
    bill: { orderId: null, orderNo: null, lines: [], confirmedTotalSatang: 0, pendingCount: 0 },
    ...overrides,
  };
}

async function show(response: QrTableResponse = view()): Promise<void> {
  vi.mocked(api.qrTable).mockResolvedValue({ ok: true, data: response });
  render(
    <MemoryRouter initialEntries={[`/t/${TOKEN}`]}>
      <Routes>
        <Route path="/t/:token" element={<QrOrderPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('ร้านก๋วยเตี๋ยว')).toBeInTheDocument());
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.qrBill).mockResolvedValue({
    ok: true,
    data: {
      bill: { orderId: null, orderNo: null, lines: [], confirmedTotalSatang: 0, pendingCount: 0 },
    },
  });
});

describe('finding the food', () => {
  it('says which table this is, so nobody orders onto the wrong one', async () => {
    await show();
    expect(screen.getByText('โต๊ะ A1')).toBeInTheDocument();
  });

  it('adds a drink in one tap, without asking about options it does not have', async () => {
    await show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));

    // No sheet, straight into the cart. Thirty seconds is the whole budget.
    expect(screen.queryByRole('button', { name: 'เพิ่มลงบิล 10.00' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ส่งออร์เดอร์ 10.00/ })).toBeInTheDocument();
  });

  it('asks for the noodle before letting a bowl through', async () => {
    await show();
    await tap(screen.getByRole('button', { name: /ก๋วยเตี๋ยวหมู/ }));

    // The same sheet the till uses, running the same validateSelection.
    expect(screen.getByRole('button', { name: 'เส้นเล็ก' })).toBeInTheDocument();
    await tap(screen.getByRole('button', { name: /เพิ่มลงบิล/ }));
    expect(screen.getByRole('button', { name: /ส่งออร์เดอร์ 50.00/ })).toBeInTheDocument();
  });

  it('will not let a sold-out dish be tapped at all', async () => {
    const sold = view();
    sold.menu.categories[0]!.items[1]!.isAvailable = false;
    await show(sold);

    expect(screen.getByRole('button', { name: /น้ำเปล่า/ })).toBeDisabled();
    expect(screen.getByText('หมดแล้ว')).toBeInTheDocument();
  });
});

describe('sending it', () => {
  it('sends ids and quantities — never a price', async () => {
    vi.mocked(api.qrSubmit).mockResolvedValue({
      ok: true,
      data: {
        bill: {
          orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          orderNo: null,
          lines: [],
          confirmedTotalSatang: 0,
          pendingCount: 1,
        },
        accepted: 1,
      },
    });

    await show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));
    await tap(screen.getByRole('button', { name: /ส่งออร์เดอร์/ }));

    const [, payload] = vi.mocked(api.qrSubmit).mock.calls[0] as [string, { lines: unknown[] }];
    const line = payload.lines[0] as Record<string, unknown>;
    expect(line['menuItemId']).toBe(WATER_ID);
    expect(line['qty']).toBe(1);
    // The server prices it. A phone that has had the page open since lunchtime
    // must not be able to order at lunchtime's price.
    expect(line).not.toHaveProperty('unitPriceSatang');
    expect(typeof line['id']).toBe('string');
  });

  it('says the staff still have to confirm it, in those words', async () => {
    vi.mocked(api.qrSubmit).mockResolvedValue({
      ok: true,
      data: {
        bill: {
          orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          orderNo: '260801-001',
          lines: [
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              name: 'น้ำเปล่า',
              qty: 1,
              optionsSummary: null,
              note: null,
              lineTotalSatang: 1000,
              status: 'PENDING',
            },
          ],
          confirmedTotalSatang: 0,
          pendingCount: 1,
        },
        accepted: 1,
      },
    });

    await show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));
    await tap(screen.getByRole('button', { name: /ส่งออร์เดอร์/ }));

    // "ส่งแล้ว" on its own would read as "the food is coming", and that
    // customer waits twenty minutes and then blames the kitchen.
    expect(await screen.findByRole('status')).toHaveTextContent('รอพนักงานยืนยัน');

    const bill = within(screen.getByRole('region', { name: 'รายการของโต๊ะนี้' }));
    expect(bill.getByText('รอพนักงานยืนยัน')).toBeInTheDocument();
    // ...and it is NOT in the money. The shop has not agreed to sell it.
    expect(bill.getByText('ยอดที่ยืนยันแล้ว').parentElement).toHaveTextContent('0.00');
    expect(bill.getByText(/อีก 1 รายการรอพนักงานยืนยัน/)).toBeInTheDocument();
  });

  it('keeps the cart when the send fails, so nothing is silently lost', async () => {
    vi.mocked(api.qrSubmit).mockResolvedValue({
      ok: false,
      error: 'ตอนนี้ร้านปิดรับออร์เดอร์ผ่าน QR กรุณาเรียกพนักงาน',
      offline: false,
      status: 409,
    });

    await show();
    await tap(screen.getByRole('button', { name: /น้ำเปล่า/ }));
    await tap(screen.getByRole('button', { name: /ส่งออร์เดอร์/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('เรียกพนักงาน');
    // Still there to try again, or to show a member of staff.
    expect(screen.getByRole('button', { name: /ส่งออร์เดอร์ 10.00/ })).toBeInTheDocument();
  });
});

describe('when the shop has switched QR ordering off', () => {
  it('shows the menu but refuses to take an order', async () => {
    await show(view({ orderingEnabled: false }));

    expect(screen.getByRole('alert')).toHaveTextContent('กรุณาสั่งกับพนักงาน');
    expect(screen.getByRole('button', { name: /น้ำเปล่า/ })).toBeDisabled();
  });
});

describe('a dead sticker', () => {
  it('says to call a member of staff instead of showing a blank page', async () => {
    vi.mocked(api.qrTable).mockResolvedValue({
      ok: false,
      error: 'คิวอาร์นี้ใช้ไม่ได้แล้ว กรุณาเรียกพนักงาน',
      offline: false,
      status: 404,
    });

    render(
      <MemoryRouter initialEntries={[`/t/${TOKEN}`]}>
        <Routes>
          <Route path="/t/:token" element={<QrOrderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('เรียกพนักงาน');
  });
});

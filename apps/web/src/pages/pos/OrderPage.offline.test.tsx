/**
 * Taking an order with the network completely down.
 *
 * This is the test that says Step 4 works. Every request fails, and the screen
 * still has to behave exactly as it does online — except for the two controls
 * that genuinely cannot work, which have to be locked and explained rather than
 * left to fail at the worst possible moment.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MenuResponse, OrderDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { saveIdentity, saveMenu } from '../../offline/catalog.js';
import { clearLocalData, getOrder, putOrder } from '../../offline/db.js';
import { totalUnsent } from '../../offline/outbox.js';
import { useSync } from '../../offline/sync-store.js';
import { OrderPage } from './OrderPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    call: vi.fn(),
    health: vi.fn(),
    getOrder: vi.fn(),
    menu: vi.fn(),
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
          station: null,
          isAvailable: true,
          // No option groups, so one tap is the whole interaction.
          groupIds: [],
        },
      ],
    },
  ],
  modifierGroups: [],
};

const LOCAL_BILL: OrderDto = {
  id: BILL_ID,
  // Opened while offline: no number yet, and the screen must say so.
  orderNo: null,
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
};

/**
 * A tap, plus the local IndexedDB write it kicks off.
 *
 * Wrapped in act so the state change that lands when the write resolves is
 * flushed before the assertion reads the screen.
 */
async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

/** Renders, and waits for the bill and the menu to come back off the device. */
async function renderOrderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/pos/order/${BILL_ID}`]}>
      <Routes>
        <Route path="/pos/order/:orderId" element={<OrderPage />} />
      </Routes>
    </MemoryRouter>,
  );
  // The category tab only exists once the cached menu has been read back.
  await screen.findByRole('button', { name: 'เครื่องดื่ม' });
}

/** The dish name appears on the menu AND on the bill; this is the menu one. */
function menuTile(name: string | RegExp): HTMLElement {
  return within(screen.getByRole('region', { name: 'เมนู' })).getByRole('button', { name });
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();

  const dead = { ok: false as const, error: 'failed to fetch', offline: true };
  vi.mocked(api.call).mockResolvedValue(dead);
  vi.mocked(api.health).mockResolvedValue(dead);
  vi.mocked(api.getOrder).mockResolvedValue(dead);
  vi.mocked(api.menu).mockResolvedValue(dead);

  useSync.setState({ online: false, pending: 1, rejected: [], syncing: false });

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
  await putOrder(LOCAL_BILL, true);
});

describe('the order screen with no connection', () => {
  it('draws the bill and the menu from the device', async () => {
    await renderOrderPage();
    expect(menuTile(/น้ำเปล่า/)).toBeInTheDocument();
    expect(screen.getByText(/ยังไม่มีเลขบิล/)).toBeInTheDocument();
  });

  it('adds a line, updates the total, and queues it for later', async () => {
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));

    await waitFor(() => expect(screen.getByText('10.00')).toBeInTheDocument());
    expect((await getOrder(BILL_ID))?.lines).toHaveLength(1);
    // The mutation is durable now: a tablet that dies here still has the sale.
    expect(await totalUnsent()).toBe(1);
  });

  it('merges a second tap into the same line rather than stacking rows', async () => {
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));
    await waitFor(() => expect(screen.getByLabelText('เพิ่ม น้ำเปล่า')).toBeInTheDocument());
    await tap(menuTile(/น้ำเปล่า/));

    await waitFor(async () => {
      const stored = await getOrder(BILL_ID);
      expect(stored?.lines).toHaveLength(1);
      expect(stored?.lines[0]?.qty).toBe(2);
    });
  });

  it('locks printing and payment, and says why', async () => {
    // A receipt number must come from the server; two tablets numbering their
    // own offline would issue the same one twice (rule #9).
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));

    await waitFor(() => expect(screen.getByRole('button', { name: 'รับเงิน' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'พิมพ์ใบแจ้งยอด' })).toBeDisabled();
    expect(screen.getByText(/เลขที่ใบเสร็จต้องออกจากเซิร์ฟเวอร์/)).toBeInTheDocument();
  });

  it('locks the discount too — the approver PIN is checked on the server', async () => {
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));

    await waitFor(() => expect(screen.getByRole('button', { name: 'ลดราคา' })).toBeDisabled());
  });

  it('unlocks them the moment the connection is back', async () => {
    // The bill already has a line, so nothing on this test is racing a
    // background sync pass — the only thing that changes is the connection.
    await putOrder(
      {
        ...LOCAL_BILL,
        totalSatang: 1000,
        discountSatang: 0,
        lines: [
          {
            id: 'line-1',
            menuItemId: WATER_ID,
            nameSnapshot: 'น้ำเปล่า',
            qty: 1,
            unitPriceSatang: 1000,
            lineTotalSatang: 1000,
            note: null,
            firedAt: null,
            voidedAt: null,
            source: 'STAFF',
            approvedAt: null,
            modifiers: [],
          },
        ],
      },
      true,
    );

    await renderOrderPage();
    expect(screen.getByRole('button', { name: 'รับเงิน' })).toBeDisabled();

    act(() => {
      useSync.setState({ online: true });
    });

    expect(screen.getByRole('button', { name: 'รับเงิน' })).toBeEnabled();
  });
});

/**
 * A discount already granted, shown on a tablet that is now offline.
 *
 * Granting one needs the server (see DiscountDialog), but a bill that HAS one
 * has to keep it through every local edit — otherwise adding a bowl after the
 * wifi drops would quietly put the customer's money back on.
 */
describe('a discount on the bill', () => {
  /** ฿235.00 of food with ฿20.00 taken off it. */
  const discounted: OrderDto = {
    ...LOCAL_BILL,
    subtotalExVatSatang: 21500,
    totalSatang: 21500,
    discountSatang: 2000,
    lines: [
      {
        // A different dish from the one the menu tile adds, so tapping น้ำเปล่า
        // below opens a SECOND line rather than bumping this one to qty 2.
        id: 'line-1',
        menuItemId: 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj',
        nameSnapshot: 'ก๋วยเตี๋ยวรวม',
        qty: 1,
        unitPriceSatang: 23500,
        lineTotalSatang: 23500,
        note: null,
        firedAt: null,
        voidedAt: null,
        source: 'STAFF',
        approvedAt: null,
        modifiers: [],
      },
    ],
  };

  it('shows the bill, the discount and what is left', async () => {
    await putOrder(discounted, false);
    await renderOrderPage();

    expect(screen.getByText('ส่วนลด')).toBeInTheDocument();
    expect(screen.getByText('-20.00')).toBeInTheDocument();
    // 235.00 appears twice — on the line and again as the pre-discount total.
    expect(screen.getAllByText('235.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('215.00')).toBeInTheDocument();
  });

  it('says nothing at all when there is no discount', async () => {
    await putOrder(LOCAL_BILL, false);
    await renderOrderPage();

    // A "ส่วนลด 0.00" line is an invitation to ask for one.
    expect(screen.queryByText('ส่วนลด')).toBeNull();
    expect(screen.getByRole('button', { name: 'ลดราคา' })).toBeInTheDocument();
  });

  it('names the button for what it would do to an existing discount', async () => {
    await putOrder(discounted, false);
    await renderOrderPage();

    expect(screen.getByRole('button', { name: 'แก้ส่วนลด' })).toBeInTheDocument();
  });

  it('survives adding another bowl while offline', async () => {
    await putOrder(discounted, false);
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));

    await waitFor(async () => {
      const stored = await getOrder(BILL_ID);
      expect(stored?.discountSatang).toBe(2000);
      // 245.00 of food − 20.00. The discount neither grew nor vanished.
      expect(stored?.totalSatang).toBe(22500);
    });
  });

  it('shrinks to fit if the bill it was granted on has gone', async () => {
    // Granted ฿20 off, then the only line came off the bill. Subtracting the
    // signed figure would print a negative total and have the shop owing money.
    await putOrder({ ...LOCAL_BILL, discountSatang: 2000 }, false);
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));

    await waitFor(async () => {
      const stored = await getOrder(BILL_ID);
      expect(stored?.discountSatang).toBe(1000);
      expect(stored?.totalSatang).toBe(0);
    });
  });
});

/**
 * The hand-typed note.
 *
 * น้ำเปล่า has no option groups, which makes it the case that mattered: before
 * this there was no way to say anything about a dish whose only property is its
 * name, because the sheet that carries the note refused to open for it.
 */
describe('a note on a line', () => {
  /** The row on the BILL, not the tile on the menu and not its +/− buttons. */
  function billRow(): HTMLElement {
    const menu = screen.getByRole('region', { name: 'เมนู' });
    const row = screen
      .getAllByRole('button', { name: /น้ำเปล่า/ })
      .find((button) => !menu.contains(button) && !button.hasAttribute('aria-label'));
    if (!row) throw new Error('bill row not found');
    return row;
  }

  it('can be added to a dish that has no options at all', async () => {
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));
    await waitFor(() => expect(screen.getByLabelText('เพิ่ม น้ำเปล่า')).toBeInTheDocument());

    await tap(billRow());
    const note = screen.getByLabelText(/หมายเหตุถึงครัว/);
    await act(async () => {
      await userEvent.setup().type(note, 'ไม่ใส่น้ำแข็ง');
    });
    await tap(screen.getByRole('button', { name: /บันทึก/ }));

    await waitFor(async () => {
      expect((await getOrder(BILL_ID))?.lines[0]?.note).toBe('ไม่ใส่น้ำแข็ง');
    });
  });

  it('shows on the bill so the cashier can read it back', async () => {
    await renderOrderPage();
    await tap(menuTile(/น้ำเปล่า/));
    await waitFor(() => expect(screen.getByLabelText('เพิ่ม น้ำเปล่า')).toBeInTheDocument());

    await tap(billRow());
    await act(async () => {
      await userEvent.setup().type(screen.getByLabelText(/หมายเหตุถึงครัว/), 'ไม่ใส่น้ำแข็ง');
    });
    await tap(screen.getByRole('button', { name: /บันทึก/ }));

    expect(await screen.findByText('* ไม่ใส่น้ำแข็ง')).toBeInTheDocument();
  });

  it('cannot be touched once the kitchen owns the line', async () => {
    // Changing what the kitchen is already cooking needs an approval, not a
    // text box — the sheet must not open at all.
    await putOrder(
      {
        ...LOCAL_BILL,
        totalSatang: 1000,
        discountSatang: 0,
        lines: [
          {
            id: 'line-1',
            menuItemId: WATER_ID,
            nameSnapshot: 'น้ำเปล่า',
            qty: 1,
            unitPriceSatang: 1000,
            lineTotalSatang: 1000,
            note: null,
            firedAt: '2026-07-30T05:10:00.000Z',
            voidedAt: null,
            source: 'STAFF',
            approvedAt: null,
            modifiers: [],
          },
        ],
      },
      true,
    );

    await renderOrderPage();
    await tap(billRow());
    expect(screen.queryByLabelText(/หมายเหตุถึงครัว/)).not.toBeInTheDocument();
  });
});

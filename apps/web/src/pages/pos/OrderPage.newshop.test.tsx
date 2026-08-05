/**
 * The order screen on the FIRST day, before anyone has typed a menu in.
 *
 * `pnpm db:seed` makes an empty shop on purpose (see prisma/seed.ts), so the
 * very first thing the owner does after logging in is open a bill and find a
 * blank panel where the food should be. A blank panel is indistinguishable
 * from a screen that failed to load, and the difference matters: one of them
 * you fix by adding dishes, the other by checking the wifi.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MenuResponse, OrderDto, Role } from '@pos/shared';
import { api } from '../../api-client.js';
import { saveMenu } from '../../offline/catalog.js';
import { clearLocalData, putOrder } from '../../offline/db.js';
import { useSync } from '../../offline/sync-store.js';
import { useSession } from '../../session-store.js';
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

/** What the API returns for a shop that has been set up but not filled in. */
const NO_MENU: MenuResponse = { categories: [], modifierGroups: [] };

const BILL: OrderDto = {
  id: BILL_ID,
  orderNo: '260730-001',
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

function asRole(role: Role): void {
  useSession.setState({
    status: 'authenticated',
    user: { staffId: 's-1', branchId: 'b-1', role, fullName: 'สมชาย ใจดี', nickname: 'พี่ชาย' },
  } as never);
}

async function show(): Promise<HTMLElement> {
  render(
    <MemoryRouter initialEntries={[`/pos/order/${BILL_ID}`]}>
      <Routes>
        <Route path="/pos/order/:orderId" element={<OrderPage />} />
        {/* Real routing rather than a mocked useNavigate: what is being
            checked is that the button lands somewhere useful. */}
        <Route path="/office/menu" element={<p>หน้าจัดการเมนู</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return within(await screen.findByRole('region', { name: 'เมนู' })).findByText(
    'ยังไม่มีเมนูในระบบ',
  );
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();

  useSync.setState({ online: true, pending: 0, rejected: [], syncing: false });
  vi.mocked(api.menu).mockResolvedValue({ ok: true, data: NO_MENU });
  vi.mocked(api.getOrder).mockResolvedValue({ ok: true, data: { order: BILL } });
  await saveMenu(NO_MENU);
  await putOrder(BILL, false);
  asRole('OWNER');
});

describe('a shop with nothing on the menu yet', () => {
  it('says so instead of showing an empty grid', async () => {
    expect(await show()).toBeInTheDocument();
  });

  it('sends the owner to the screen that fixes it', async () => {
    await show();
    await userEvent.click(screen.getByRole('button', { name: 'ไปเพิ่มเมนู' }));

    expect(await screen.findByText('หน้าจัดการเมนู')).toBeInTheDocument();
  });

  it('tells a cashier who to ask rather than a button they cannot use', async () => {
    // MANAGE_MENU is not a cashier's to have, and a button that 403s is worse
    // than no button.
    asRole('STAFF');
    await show();

    expect(screen.queryByRole('button', { name: 'ไปเพิ่มเมนู' })).toBeNull();
    expect(screen.getByText(/ให้เจ้าของร้านเพิ่มรายการอาหารก่อน/)).toBeInTheDocument();
  });

  it('still shows the bill, so a shop can be set up with a bill already open', async () => {
    await show();
    expect(screen.getByText('รายการในบิล')).toBeInTheDocument();
  });
});

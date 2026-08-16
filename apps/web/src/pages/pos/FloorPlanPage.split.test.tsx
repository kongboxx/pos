/**
 * A table carrying more than one bill.
 *
 * Impossible before แยกบิล and ordinary after it, so the floor plan has two new
 * jobs: show the table's WHOLE outstanding amount rather than one bill's, and
 * ask which bill was meant instead of guessing. Guessing is the dangerous one —
 * silently opening the oldest would have a cashier ringing food onto a stranger's
 * bill at the same table.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TableBillDto, TableDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { clearLocalData } from '../../offline/db.js';
import { useSync } from '../../offline/sync-store.js';
import { useSession } from '../../session.js';
import { FloorPlanPage } from './FloorPlanPage.js';

vi.mock('../../api-client.js', () => ({
  api: { tables: vi.fn(), openOrders: vi.fn(), menu: vi.fn(), health: vi.fn(), call: vi.fn() },
}));

const bill = (n: number, totalSatang: number): TableBillDto => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb0${n}`,
  orderNo: `260730-00${n}`,
  totalSatang,
  lineCount: 2,
  openedAt: '2026-07-30T05:00:00.000Z',
});

const SPLIT_TABLE: TableDto = {
  id: 'tttttttt-tttt-4ttt-8ttt-tttttttttttt',
  name: 'A1',
  zone: 'ในร้าน',
  seats: 4,
  openOrder: bill(1, 5000),
  openOrders: [bill(1, 5000), bill(2, 3000)],
};

const QUIET_TABLE: TableDto = {
  ...SPLIT_TABLE,
  id: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
  name: 'A2',
  openOrder: bill(3, 7000),
  openOrders: [bill(3, 7000)],
};

async function show(tables: TableDto[]): Promise<void> {
  vi.mocked(api.tables).mockResolvedValue({ ok: true, data: { tables } });
  render(
    <MemoryRouter initialEntries={['/pos/tables']}>
      <Routes>
        <Route path="/pos/tables" element={<FloorPlanPage />} />
        <Route path="/pos/order/:orderId" element={<OrderStub />} />
      </Routes>
    </MemoryRouter>,
  );
  // Waits for the cards to be DRAWN, not merely for the request to be made.
  await screen.findByRole('button', { name: new RegExp(tables[0]?.name ?? 'A1') });
}

/** Stands in for the order screen so "which bill did it open" is readable. */
function OrderStub(): React.ReactElement {
  return <p>เปิดบิลแล้ว</p>;
}

async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

beforeEach(async () => {
  await clearLocalData();
  vi.clearAllMocks();
  useSync.setState({ online: true, pending: 0, rejected: [], syncing: false });
  useSession.setState({
    status: 'authenticated',
    user: {
      staffId: 's-1',
      branchId: 'b-1',
      role: 'STAFF',
      fullName: 'อ่อง มิน',
      nickname: 'อ่อง',
    },
  } as never);
  vi.mocked(api.openOrders).mockResolvedValue({ ok: true, data: { orders: [] } });
  vi.mocked(api.menu).mockResolvedValue({ ok: false, error: 'offline', offline: true });
});

describe('a table with two bills on it', () => {
  it('adds them up instead of showing one of them', async () => {
    await show([SPLIT_TABLE]);
    // ฿50 + ฿30. Showing 50.00 would understate what the table owes by ฿30.
    expect(screen.getByRole('button', { name: /A1/ })).toHaveTextContent('80.00');
  });

  it('says the table is split, because the total is now a sum', async () => {
    await show([SPLIT_TABLE]);
    expect(screen.getByRole('button', { name: /A1/ })).toHaveTextContent('แยก 2 บิล');
  });

  it('asks which bill rather than guessing', async () => {
    await show([SPLIT_TABLE]);
    await tap(screen.getByRole('button', { name: /A1/ }));

    const picker = await screen.findByRole('dialog', { name: /โต๊ะ A1/ });
    expect(picker).toHaveTextContent('260730-001');
    expect(picker).toHaveTextContent('260730-002');
  });

  it('opens the one that was chosen', async () => {
    await show([SPLIT_TABLE]);
    await tap(screen.getByRole('button', { name: /A1/ }));
    await tap(await screen.findByRole('button', { name: /260730-002/ }));

    expect(await screen.findByText('เปิดบิลแล้ว')).toBeInTheDocument();
  });
});

describe('a table with one bill on it', () => {
  it('goes straight in, with no tap in the way', async () => {
    // The picker must not appear here: it would sit between the cashier and
    // every order of the day.
    await show([QUIET_TABLE]);
    await tap(screen.getByRole('button', { name: /A2/ }));

    expect(await screen.findByText('เปิดบิลแล้ว')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not claim to be split', async () => {
    await show([QUIET_TABLE]);
    expect(screen.getByRole('button', { name: /A2/ })).not.toHaveTextContent('แยก');
  });
});

describe('a floor plan cached before bills could be split', () => {
  it('still draws the table as busy from the single-bill field', async () => {
    // `openOrders` absent means "this device is too old to know", not "empty".
    const legacy: TableDto = { ...QUIET_TABLE, openOrders: undefined };
    await show([legacy]);

    const card = screen.getByRole('button', { name: /A2/ });
    expect(card).toHaveTextContent('70.00');
    expect(card).not.toHaveTextContent('ว่าง');
  });
});

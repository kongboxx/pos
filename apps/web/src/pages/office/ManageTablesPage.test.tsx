/**
 * The floor plan and the stickers.
 *
 * What is worth testing here is what the screen refuses to offer, plus the two
 * things that can be wrong in a way nobody notices until a customer is standing
 * in the shop holding a phone:
 *
 *  - a table with an open bill must not offer "ปิดใช้" or "ลบ" — retiring it
 *    hides food that was served and can never be charged for;
 *  - a table that has ever held a bill must show the REASON it cannot be
 *    deleted, not a greyed-out button;
 *  - a retired table stays in the list and loses its sticker card;
 *  - the URL printed under the code, and whether "เปลี่ยนรหัส" can be hit by
 *    accident.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { TableQrDto, TableQrResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { ManageTablesPage } from './ManageTablesPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    manageTables: vi.fn(),
    createTable: vi.fn(),
    updateTable: vi.fn(),
    deleteTable: vi.fn(),
    moveTable: vi.fn(),
    rotateTableQr: vi.fn(),
    setQrOrdering: vi.fn(),
  },
}));

vi.mock('../../manage-store.js', () => ({
  useManage: (selector: (state: unknown) => unknown) =>
    selector({ error: null, notice: null, dismiss: () => undefined }),
}));

const TABLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function table(over: Partial<TableQrDto> = {}): TableQrDto {
  return {
    id: TABLE_ID,
    name: 'A1',
    zone: 'ในร้าน',
    seats: 4,
    sortOrder: 0,
    isActive: true,
    qrToken: 'AbCd1234_efGH-ij',
    hasHistory: false,
    hasOpenBill: false,
    ...over,
  };
}

function tables(overrides: Partial<TableQrResponse> = {}): TableQrResponse {
  return { orderingEnabled: true, tables: [table()], ...overrides };
}

/** The layout row for a table, as opposed to its sticker card. */
function rowFor(name: string): HTMLElement {
  return screen.getByRole('button', { name: `เลื่อน ${name} ขึ้น` }).closest('div')
    ?.parentElement as HTMLElement;
}

async function show(data: TableQrResponse = tables()): Promise<void> {
  vi.mocked(api.manageTables).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <ManageTablesPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('ผังโต๊ะ')).toBeInTheDocument());
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the floor plan list', () => {
  it('groups by zone and keeps the order the floor plan shows', async () => {
    await show(
      tables({
        tables: [
          table({ name: 'A1', zone: 'ในร้าน', sortOrder: 0 }),
          table({ id: SECOND_ID, name: 'B1', zone: 'หน้าร้าน', sortOrder: 0 }),
        ],
      }),
    );

    expect(screen.getByRole('heading', { name: 'ในร้าน' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'หน้าร้าน' })).toBeInTheDocument();
  });

  it('cannot move the only table in a zone in either direction', async () => {
    await show();

    expect(screen.getByRole('button', { name: 'เลื่อน A1 ขึ้น' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'เลื่อน A1 ลง' })).toBeDisabled();
  });

  it('moves a table by asking the server, not by reordering on screen', async () => {
    // The order has to survive a reload, and two tables can share a sortOrder
    // after a seed — so the swap is the server's job.
    vi.mocked(api.moveTable).mockResolvedValue({ ok: true, data: tables() });
    await show(
      tables({
        tables: [table({ name: 'A1' }), table({ id: SECOND_ID, name: 'A2', sortOrder: 1 })],
      }),
    );

    await tap(screen.getByRole('button', { name: 'เลื่อน A2 ขึ้น' }));
    expect(api.moveTable).toHaveBeenCalledWith(SECOND_ID, 'UP');
  });

  it('keeps a retired table in the list and takes its sticker away', async () => {
    // A table that vanished from this screen looks exactly like a table
    // somebody deleted.
    await show(tables({ tables: [table({ isActive: false })] }));

    expect(within(rowFor('A1')).getByText(/ปิดใช้อยู่/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'เปิดใช้' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'เปลี่ยนรหัส' })).not.toBeInTheDocument();
  });
});

describe('retiring and deleting', () => {
  it('will not let a table with an open bill be retired or deleted', async () => {
    await show(tables({ tables: [table({ hasOpenBill: true })] }));

    expect(screen.getByRole('button', { name: 'ปิดใช้' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ลบ' })).toBeDisabled();
    expect(screen.getByText(/มีบิลเปิดค้าง/)).toBeInTheDocument();
  });

  it('says why a table with history cannot be deleted instead of greying a button', async () => {
    await show(tables({ tables: [table({ hasHistory: true })] }));

    expect(screen.getByText('เคยมีบิลแล้ว ลบไม่ได้')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ลบ' })).not.toBeInTheDocument();
    // Retiring is still the way out, and it stays available.
    expect(screen.getByRole('button', { name: 'ปิดใช้' })).toBeEnabled();
  });

  it('takes two taps to delete a table nothing points at', async () => {
    vi.mocked(api.deleteTable).mockResolvedValue({ ok: true, data: tables({ tables: [] }) });
    await show();

    await tap(screen.getByRole('button', { name: 'ลบ' }));
    expect(api.deleteTable).not.toHaveBeenCalled();

    await tap(screen.getByRole('button', { name: 'ยืนยันลบ' }));
    expect(api.deleteTable).toHaveBeenCalledWith(TABLE_ID);
  });

  it('sends the opposite of the current state when retiring', async () => {
    vi.mocked(api.updateTable).mockResolvedValue({ ok: true, data: tables() });
    await show();

    await tap(screen.getByRole('button', { name: 'ปิดใช้' }));
    expect(api.updateTable).toHaveBeenCalledWith(TABLE_ID, {
      name: 'A1',
      zone: 'ในร้าน',
      seats: 4,
      isActive: false,
    });
  });
});

describe('adding and editing', () => {
  it('adds a table with an empty zone as null, not as an empty string', async () => {
    vi.mocked(api.createTable).mockResolvedValue({ ok: true, data: tables() });
    await show();
    await tap(screen.getByRole('button', { name: '+ เพิ่มโต๊ะ' }));

    const dialog = screen.getByRole('dialog', { name: 'เพิ่มโต๊ะ' });
    await act(async () => {
      await userEvent.setup().type(within(dialog).getByLabelText(/ชื่อโต๊ะ/), 'C1');
    });
    await tap(within(dialog).getByRole('button', { name: 'บันทึก' }));

    expect(api.createTable).toHaveBeenCalledWith({
      name: 'C1',
      zone: null,
      seats: 4,
      isActive: true,
    });
  });

  it('will not save a table with no name', async () => {
    await show();
    await tap(screen.getByRole('button', { name: '+ เพิ่มโต๊ะ' }));

    const dialog = screen.getByRole('dialog', { name: 'เพิ่มโต๊ะ' });
    expect(within(dialog).getByRole('button', { name: 'บันทึก' })).toBeDisabled();
  });

  it('editing does not flip the active switch by accident', async () => {
    // ปิดใช้ is a separate button because it is the one that has to check for
    // an open bill. Renaming a retired table must leave it retired.
    vi.mocked(api.updateTable).mockResolvedValue({ ok: true, data: tables() });
    await show(tables({ tables: [table({ isActive: false })] }));
    await tap(screen.getByRole('button', { name: 'แก้ไข' }));

    const dialog = screen.getByRole('dialog', { name: 'แก้ไขโต๊ะ' });
    await act(async () => {
      const user = userEvent.setup();
      await user.clear(within(dialog).getByLabelText(/ชื่อโต๊ะ/));
      await user.type(within(dialog).getByLabelText(/ชื่อโต๊ะ/), 'A01');
    });
    await tap(within(dialog).getByRole('button', { name: 'บันทึก' }));

    expect(api.updateTable).toHaveBeenCalledWith(TABLE_ID, {
      name: 'A01',
      zone: 'ในร้าน',
      seats: 4,
      isActive: false,
    });
  });

  it('says out loud that renaming does not break the sticker', async () => {
    await show();
    await tap(screen.getByRole('button', { name: 'แก้ไข' }));

    expect(screen.getByText(/สติกเกอร์ QR เดิมยังใช้ได้/)).toBeInTheDocument();
  });

  it('shows what the server said when a name is taken', async () => {
    vi.mocked(api.createTable).mockResolvedValue({
      ok: false,
      error: 'มีโต๊ะชื่อ "A1" อยู่แล้ว ใช้ชื่ออื่น',
      offline: false,
      status: 409,
    });
    await show();
    await tap(screen.getByRole('button', { name: '+ เพิ่มโต๊ะ' }));

    const dialog = screen.getByRole('dialog', { name: 'เพิ่มโต๊ะ' });
    await act(async () => {
      await userEvent.setup().type(within(dialog).getByLabelText(/ชื่อโต๊ะ/), 'A1');
    });
    await tap(within(dialog).getByRole('button', { name: 'บันทึก' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/มีโต๊ะชื่อ/)).toBeInTheDocument();
  });
});

describe('the printable code', () => {
  it('points at the address this browser is on, not at the API', async () => {
    await show();

    // The server knows it is on localhost:3001, which is exactly the address a
    // customer's phone cannot reach. Whoever is looking at this page is already
    // somewhere that works from inside the shop.
    const url = `${globalThis.location.origin}/t/AbCd1234_efGH-ij`;
    expect(screen.getByText(url)).toBeInTheDocument();
  });
});

describe('rotating a sticker', () => {
  it('takes two taps and says what it will break', async () => {
    vi.mocked(api.rotateTableQr).mockResolvedValue({ ok: true, data: tables() });
    await show();

    await tap(screen.getByRole('button', { name: 'เปลี่ยนรหัส' }));
    // The first tap only arms it: this kills a sticker that is physically
    // stuck to a table, so a mis-tap costs a trip with a printer.
    expect(api.rotateTableQr).not.toHaveBeenCalled();
    expect(screen.getByText('สติกเกอร์เดิมของโต๊ะนี้จะใช้ไม่ได้ทันที')).toBeInTheDocument();

    await tap(screen.getByRole('button', { name: 'ยืนยันเปลี่ยน' }));
    expect(api.rotateTableQr).toHaveBeenCalledWith(TABLE_ID);
  });
});

describe('the off switch', () => {
  it('says which way it is currently set, not just what the button does', async () => {
    await show();
    expect(screen.getByText(/เปิดอยู่/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ปิดรับ' })).toBeInTheDocument();
  });

  it('sends the opposite of what is set now', async () => {
    vi.mocked(api.setQrOrdering).mockResolvedValue({
      ok: true,
      data: tables({ orderingEnabled: false }),
    });
    await show();

    await tap(screen.getByRole('button', { name: 'ปิดรับ' }));
    expect(api.setQrOrdering).toHaveBeenCalledWith(false);

    // ...and the screen then reads the other way round.
    expect(await screen.findByRole('button', { name: 'เปิดรับ' })).toBeInTheDocument();
    expect(screen.getByText(/ปิดอยู่/)).toBeInTheDocument();
  });

  it('shows what the server said when it refuses', async () => {
    vi.mocked(api.setQrOrdering).mockResolvedValue({
      ok: false,
      error: 'บัญชีนี้ไม่มีสิทธิ์จัดการโต๊ะ',
      offline: false,
      status: 403,
    });
    await show();

    await tap(screen.getByRole('button', { name: 'ปิดรับ' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('บัญชีนี้ไม่มีสิทธิ์จัดการโต๊ะ')).toBeInTheDocument();
  });
});

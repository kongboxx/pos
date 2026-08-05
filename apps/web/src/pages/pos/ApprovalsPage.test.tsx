/**
 * The queue that stands between a customer's phone and the kitchen.
 *
 * The cases here are the ones where the screen quietly stops doing its job:
 * a press that only approves half a table, a refusal that fires the food
 * anyway, and a clock that makes three minutes look like nothing.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PendingApprovalOrderDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { ApprovalsPage, formatWait } from './ApprovalsPage.js';

vi.mock('../../api-client.js', () => ({
  api: { pendingApproval: vi.fn(), approveQrLines: vi.fn(), rejectQrLines: vi.fn() },
}));

vi.mock('../../live-store.js', () => ({ onLiveEvent: () => () => undefined }));

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINE_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function waiting(overrides: Partial<PendingApprovalOrderDto> = {}): PendingApprovalOrderDto {
  return {
    orderId: ORDER_ID,
    orderNo: '260801-004',
    tableId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tableName: 'A3',
    waitingSince: new Date().toISOString(),
    lines: [
      {
        id: LINE_A,
        name: 'ก๋วยเตี๋ยวหมู',
        qty: 2,
        optionsSummary: 'เส้นเล็ก · น้ำใส',
        note: null,
        lineTotalSatang: 10000,
        submittedAt: new Date().toISOString(),
      },
      {
        id: LINE_B,
        name: 'ลูกชิ้นทอด',
        qty: 1,
        optionsSummary: null,
        note: 'ไม่เอาผัก',
        lineTotalSatang: 4000,
        submittedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

/**
 * Waits for the queue to be ON SCREEN, not merely for the fetch to have been
 * called.
 *
 * The difference is a real flake, not pedantry: waiting on the call only
 * proves the request went out, so a test that then reaches for a row with a
 * synchronous `getByText` is racing the state update that renders it. Under
 * load it lost that race roughly one run in three.
 */
async function show(orders: PendingApprovalOrderDto[]): Promise<void> {
  vi.mocked(api.pendingApproval).mockResolvedValue({ ok: true, data: { orders } });
  render(
    <MemoryRouter>
      <ApprovalsPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(api.pendingApproval).toHaveBeenCalled());

  const first = orders[0]?.lines[0]?.name;
  if (first) await screen.findByText(first);
  else await screen.findByText('ยังไม่มีลูกค้าสั่งผ่าน QR ตอนนี้');
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.approveQrLines).mockResolvedValue({
    ok: true,
    data: { order: {} as never, stations: ['ครัวเส้น'] },
  });
  vi.mocked(api.rejectQrLines).mockResolvedValue({ ok: true, data: { order: {} as never } });
});

describe('the queue', () => {
  it('groups by table and shows what was asked for, options and all', async () => {
    await show([waiting()]);

    expect(await screen.findByText('A3')).toBeInTheDocument();
    expect(screen.getByText('เส้นเล็ก · น้ำใส')).toBeInTheDocument();
    // The note is what a kitchen gets wrong when it is not on screen.
    expect(screen.getByText('ไม่เอาผัก')).toBeInTheDocument();
  });

  it('says so plainly when nothing is waiting', async () => {
    await show([]);
    expect(await screen.findByText('ยังไม่มีลูกค้าสั่งผ่าน QR ตอนนี้')).toBeInTheDocument();
  });
});

describe('answering', () => {
  it('approves the WHOLE table in one press', async () => {
    await show([waiting()]);
    await tap(await screen.findByRole('button', { name: 'ยืนยัน & ส่งครัว' }));

    // Half a table approved is a customer served half their order, which is
    // worse than none of it — they stop watching the phone.
    expect(api.approveQrLines).toHaveBeenCalledWith(ORDER_ID, [LINE_A, LINE_B]);
  });

  it('refuses one line without touching the rest', async () => {
    await show([waiting()]);
    const row = screen.getByText('ลูกชิ้นทอด').closest('li') as HTMLElement;
    await tap(within(row).getByRole('button', { name: 'ปฏิเสธ' }));

    expect(api.rejectQrLines).toHaveBeenCalledWith(ORDER_ID, [LINE_B]);
    expect(api.approveQrLines).not.toHaveBeenCalled();
  });

  it('refuses the whole table when asked to, and never fires it', async () => {
    await show([waiting()]);
    await tap(await screen.findByRole('button', { name: 'ปฏิเสธทั้งโต๊ะ' }));

    expect(api.rejectQrLines).toHaveBeenCalledWith(ORDER_ID, [LINE_A, LINE_B]);
    expect(api.approveQrLines).not.toHaveBeenCalled();
  });

  it('shows the server`s refusal rather than pretending it worked', async () => {
    vi.mocked(api.approveQrLines).mockResolvedValue({
      ok: false,
      error: 'รายการเหล่านี้ถูกยืนยันหรือถูกปฏิเสธไปแล้ว',
      offline: false,
      status: 409,
    });

    await show([waiting()]);
    await tap(await screen.findByRole('button', { name: 'ยืนยัน & ส่งครัว' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ถูกยืนยันหรือถูกปฏิเสธไปแล้ว');
  });
});

describe('the wait clock', () => {
  it('counts seconds first, because a minute of silence is already too long', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    expect(formatWait('2026-08-01T11:59:45Z', now)).toBe('15 วินาที');
    expect(formatWait('2026-08-01T11:56:40Z', now)).toBe('3:20 นาที');
  });
});

/**
 * เปิดกะ / ปิดกะ / นับเงินลิ้นชัก.
 *
 * The assertion that matters most in here is a NEGATIVE one: while the shift is
 * open, the screen must not print what the drawer should hold. Everything else
 * is arithmetic the server already owns; this is the one thing only the screen
 * can get wrong, and getting it wrong turns a count into a copy.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ShiftDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { useSession } from '../../session.js';
import { useSync } from '../../offline/sync-store.js';
import { ShiftPage } from './ShiftPage.js';

vi.mock('../../api-client.js', () => ({
  api: { currentShift: vi.fn(), openShift: vi.fn(), closeShift: vi.fn(), shifts: vi.fn() },
}));

const SHIFT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** An open shift: ฿2,000 float, ฿1,500 taken in cash, ฿500 out to the market. */
const OPEN: ShiftDto = {
  id: SHIFT_ID,
  branchId: 'b-1',
  staffId: 's-1',
  staffName: 'อ่อง',
  openedAt: '2026-07-30T02:00:00.000Z',
  closedAt: null,
  openingCashSatang: 200_000,
  cashSalesSatang: 150_000,
  cashOutSatang: 50_000,
  transferSalesSatang: 80_000,
  billCount: 12,
  countedCashSatang: null,
  expectedCashSatang: null,
  varianceSatang: null,
  note: null,
};

const closedWith = (varianceSatang: number): ShiftDto => ({
  ...OPEN,
  closedAt: '2026-07-30T12:00:00.000Z',
  expectedCashSatang: 300_000,
  countedCashSatang: 300_000 + varianceSatang,
  varianceSatang,
});

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

async function show(): Promise<void> {
  render(
    <MemoryRouter>
      <ShiftPage />
    </MemoryRouter>,
  );
  // Waits for the page to have RENDERED, not merely for the request to have
  // been made. Waiting on the call alone passed alone and failed in the suite:
  // under load the promise resolved after waitFor returned and every assertion
  // then ran against "กำลังโหลด…".
  await screen.findByRole('heading', { name: 'กะและเงินในลิ้นชัก' });
}

const amountBox = () => screen.getAllByRole('textbox')[0] as HTMLElement;

/** Signs in as someone who may read the history unless told otherwise. */
function asRole(role: 'STAFF' | 'OWNER'): void {
  useSession.setState({
    status: 'authenticated',
    user: {
      staffId: 's-1',
      branchId: 'b-1',
      role,
      fullName: 'อ่อง มิน',
      nickname: 'อ่อง',
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSync.setState({ online: true, pending: 0, rejected: [], syncing: false });
  asRole('OWNER');
  vi.mocked(api.currentShift).mockResolvedValue({ ok: true, data: { shift: null } });
  vi.mocked(api.shifts).mockResolvedValue({ ok: true, data: { shifts: [] } });
  vi.mocked(api.openShift).mockResolvedValue({ ok: true, data: { shift: OPEN } });
  vi.mocked(api.closeShift).mockResolvedValue({ ok: true, data: { shift: closedWith(0) } });
});

describe('with the till shut', () => {
  it('asks for the float and says what will not be counted', async () => {
    await show();
    expect(screen.getByRole('region', { name: 'ยังไม่เปิดกะ' })).toBeInTheDocument();
    expect(screen.getByText(/ขายก่อนเปิดกะจะไม่ถูกนับ/)).toBeInTheDocument();
  });

  it('sends the float in satang', async () => {
    await show();
    await type(amountBox(), '2000');
    await tap(screen.getByRole('button', { name: 'เปิดกะ' }));

    expect(api.openShift).toHaveBeenCalledWith(
      expect.objectContaining({ openingCashSatang: 200_000 }),
    );
  });

  it('accepts an empty drawer — some shops start at zero', async () => {
    await show();
    await type(amountBox(), '0');
    await tap(screen.getByRole('button', { name: 'เปิดกะ' }));

    expect(api.openShift).toHaveBeenCalledWith(expect.objectContaining({ openingCashSatang: 0 }));
  });

  it('will not send an empty box', async () => {
    await show();
    expect(screen.getByRole('button', { name: 'เปิดกะ' })).toBeDisabled();
  });

  it('will not send something that is not a number', async () => {
    await show();
    await type(amountBox(), 'สองพัน');
    expect(screen.getByRole('button', { name: 'เปิดกะ' })).toBeDisabled();
  });
});

describe('with the till open', () => {
  beforeEach(() => {
    vi.mocked(api.currentShift).mockResolvedValue({ ok: true, data: { shift: OPEN } });
  });

  it('shows what has gone through the drawer so far', async () => {
    await show();
    const panel = within(screen.getByRole('region', { name: 'กะที่เปิดอยู่' }));

    expect(panel.getByText('2,000.00')).toBeInTheDocument();
    expect(panel.getByText('1,500.00')).toBeInTheDocument();
    // The sign and the figure are separate text nodes, so this matches the
    // whole cell rather than a fragment of it.
    expect(
      panel.getByText(
        (_, node) => node?.textContent?.trim() === '-500.00' && node.tagName === 'DD',
      ),
    ).toBeInTheDocument();
    expect(panel.getByText(/12 บิล/)).toBeInTheDocument();
  });

  it('does not write "-0.00" when nothing left the drawer', async () => {
    vi.mocked(api.currentShift).mockResolvedValue({
      ok: true,
      data: { shift: { ...OPEN, cashOutSatang: 0 } },
    });
    await show();

    // A minus sign in front of a zero reads as a mistake in a money column.
    expect(screen.queryByText('-0.00')).toBeNull();
  });

  it('NEVER prints what the drawer should hold while it is open', async () => {
    // 2,000 + 1,500 − 500 = 3,000.00. Putting that on screen next to the box
    // where the count goes turns a count into a copy.
    await show();
    expect(screen.queryByText('3,000.00')).toBeNull();
    expect(screen.queryByText(/ควรมีในลิ้นชัก/)).toBeNull();
  });

  it('keeps PromptPay visible but marked as not being in the drawer', async () => {
    await show();
    expect(screen.getByText(/ไม่อยู่ในลิ้นชัก/)).toBeInTheDocument();
    expect(screen.getByText('800.00')).toBeInTheDocument();
  });

  it('sends only the counted figure', async () => {
    await show();
    await type(amountBox(), '3000');
    await tap(screen.getByRole('button', { name: /ปิดกะ/ }));

    // A client that could name its own expected total could close every shift
    // dead level.
    const sent = vi.mocked(api.closeShift).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ countedCashSatang: 300_000 });
    expect('expectedCashSatang' in sent).toBe(false);
    expect('varianceSatang' in sent).toBe(false);
  });
});

describe('after the count is saved', () => {
  beforeEach(() => {
    vi.mocked(api.currentShift).mockResolvedValue({ ok: true, data: { shift: OPEN } });
  });

  it('reveals the expected figure and the gap, together', async () => {
    vi.mocked(api.closeShift).mockResolvedValue({ ok: true, data: { shift: closedWith(-5000) } });
    vi.mocked(api.currentShift).mockResolvedValueOnce({ ok: true, data: { shift: OPEN } });

    await show();
    await type(amountBox(), '2950');
    await tap(screen.getByRole('button', { name: /ปิดกะ/ }));

    const result = within(await screen.findByRole('region', { name: 'ผลการนับเงิน' }));
    expect(result.getByText(/เงินขาด 50.00 บาท/)).toBeInTheDocument();
    expect(result.getByText('3,000.00')).toBeInTheDocument();
    expect(result.getByText('2,950.00')).toBeInTheDocument();
  });

  it('does not shout about the loose change a real till drifts by', async () => {
    vi.mocked(api.closeShift).mockResolvedValue({ ok: true, data: { shift: closedWith(-500) } });

    await show();
    await type(amountBox(), '2995');
    await tap(screen.getByRole('button', { name: /ปิดกะ/ }));

    const result = await screen.findByRole('region', { name: 'ผลการนับเงิน' });
    expect(result.className).toContain('emerald');
  });

  it('does shout about a note-sized gap', async () => {
    vi.mocked(api.closeShift).mockResolvedValue({ ok: true, data: { shift: closedWith(-20_000) } });

    await show();
    await type(amountBox(), '2800');
    await tap(screen.getByRole('button', { name: /ปิดกะ/ }));

    const result = await screen.findByRole('region', { name: 'ผลการนับเงิน' });
    expect(result.className).toContain('red');
  });

  it('keeps the server’s complaint instead of failing silently', async () => {
    vi.mocked(api.closeShift).mockResolvedValue({
      ok: false,
      error: 'ยังไม่ได้เปิดกะ — ไม่มีอะไรให้ปิด',
      offline: false,
    });

    await show();
    await type(amountBox(), '3000');
    await tap(screen.getByRole('button', { name: /ปิดกะ/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ยังไม่ได้เปิดกะ');
  });
});

describe('offline', () => {
  it('locks both buttons and says why', async () => {
    useSync.setState({ online: false });
    await show();

    expect(screen.getByRole('button', { name: 'เปิดกะ' })).toBeDisabled();
    expect(screen.getByText(/ลิ้นชักมีใบเดียวทั้งร้าน/)).toBeInTheDocument();
  });
});

describe('who sees the history', () => {
  const past = [closedWith(-20_000), closedWith(0)].map((row, index) => ({
    ...row,
    id: `${SHIFT_ID.slice(0, -1)}${index}`,
  }));

  it('shows the owner past counts with the bad ones marked', async () => {
    vi.mocked(api.shifts).mockResolvedValue({ ok: true, data: { shifts: past } });
    await show();

    const list = within(await screen.findByRole('region', { name: 'กะที่ผ่านมา' }));
    expect(list.getByText(/เงินขาด 200.00 บาท/)).toBeInTheDocument();
    expect(list.getByText('ตรงพอดี')).toBeInTheDocument();
  });

  it('does not even ask for it as a cashier', async () => {
    // The variance starts a conversation about a missing ฿500, and that
    // conversation belongs to whoever is responsible for the shop.
    asRole('STAFF');
    await show();

    expect(api.shifts).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'กะที่ผ่านมา' })).toBeNull();
  });
});

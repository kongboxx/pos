/**
 * The kitchen screen.
 *
 * The things worth testing are the ones a cook would be hurt by: a bowl that
 * was cancelled must SHOUT rather than disappear, a ticket that has been
 * waiting too long must look different from a fresh one, and a finished card
 * must not push live work down the screen.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { KitchenBoardResponse, KitchenTicketDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { KitchenPage } from './KitchenPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    kitchenBoard: vi.fn(),
    startTicket: vi.fn(),
    completeTicket: vi.fn(),
    recallTicket: vi.fn(),
    completeTicketLine: vi.fn(),
  },
}));

const NOW = new Date('2026-07-30T12:00:00.000Z');
const minutesAgo = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

let nextId = 0;
function ticket(overrides: Partial<KitchenTicketDto> = {}): KitchenTicketDto {
  nextId += 1;
  return {
    id: `ticket-${nextId}`,
    orderId: `order-${nextId}`,
    orderNo: '260730-004',
    tableName: 'A1',
    channelLabel: 'ทานที่ร้าน',
    station: 'ครัวเส้น',
    status: 'PENDING',
    firedAt: minutesAgo(1),
    doneAt: null,
    lines: [
      {
        id: `line-${nextId}`,
        orderLineId: `order-line-${nextId}`,
        nameSnapshot: 'ก๋วยเตี๋ยวหมู',
        qty: 2,
        modifiersSummary: 'เส้นเล็ก · น้ำใส',
        note: null,
        doneAt: null,
        voidedAt: null,
      },
    ],
    ...overrides,
  };
}

function board(tickets: KitchenTicketDto[]): KitchenBoardResponse {
  return { stations: ['ครัวเส้น', 'เครื่องดื่ม'], tickets };
}

async function renderBoard(tickets: KitchenTicketDto[]): Promise<void> {
  vi.mocked(api.kitchenBoard).mockResolvedValue({ ok: true, data: board(tickets) });
  render(
    <MemoryRouter>
      <KitchenPage />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'ครัวเส้น' });
}

async function tap(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  // Ids restart per test so an assertion can name "ticket-1" without depending
  // on how many tickets the tests before it happened to build.
  nextId = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the board', () => {
  it('shows the table, the dish and its options in full', async () => {
    await renderBoard([ticket()]);

    const card = screen.getByRole('article', { name: 'บัตรครัว A1' });
    expect(within(card).getByText('A1')).toBeInTheDocument();
    expect(within(card).getByText('ก๋วยเตี๋ยวหมู')).toBeInTheDocument();
    // The options are what the cook actually cooks from.
    expect(within(card).getByText('เส้นเล็ก · น้ำใส')).toBeInTheDocument();
    expect(within(card).getByText('2×')).toBeInTheDocument();
  });

  it('falls back to the channel when there is no table', async () => {
    await renderBoard([ticket({ tableName: null, channelLabel: 'กลับบ้าน' })]);
    expect(screen.getByRole('article', { name: 'บัตรครัว กลับบ้าน' })).toBeInTheDocument();
  });

  it('says how long each ticket has been waiting', async () => {
    await renderBoard([ticket({ firedAt: minutesAgo(14) })]);
    expect(screen.getByText('14 น.')).toBeInTheDocument();
  });

  it('shouts about a line that was cancelled after it was sent', async () => {
    // A row that silently vanished is a row nobody noticed, and somebody is
    // standing at a wok cooking it right now.
    const cancelled = ticket();
    cancelled.lines[0]!.voidedAt = minutesAgo(0);
    await renderBoard([cancelled]);

    expect(screen.getByText('ยกเลิกแล้ว — หยุดทำ')).toBeInTheDocument();
    expect(screen.getByText('ก๋วยเตี๋ยวหมู')).toHaveClass('line-through');
  });

  it('shows the note the customer asked for', async () => {
    const withNote = ticket();
    withNote.lines[0]!.note = 'ไม่ใส่ผักชี';
    await renderBoard([withNote]);
    expect(screen.getByText('* ไม่ใส่ผักชี')).toBeInTheDocument();
  });

  it('puts finished tickets below live ones', async () => {
    // A card closed thirty seconds ago must never push a live order down.
    const done = ticket({ status: 'DONE', doneAt: minutesAgo(0), firedAt: minutesAgo(30) });
    const waiting = ticket({ tableName: 'B2', firedAt: minutesAgo(2) });
    await renderBoard([done, waiting]);

    const cards = screen.getAllByRole('article');
    expect(cards[0]).toHaveAccessibleName('บัตรครัว B2');
  });

  it('says so plainly when there is nothing to cook', async () => {
    await renderBoard([]);
    expect(screen.getByText('ยังไม่มีออร์เดอร์')).toBeInTheDocument();
  });
});

describe('working a ticket', () => {
  it('starts it, finishes it, and reloads the board each time', async () => {
    await renderBoard([ticket()]);
    vi.mocked(api.startTicket).mockResolvedValue({ ok: true, data: { ticket: ticket() } });

    await tap(screen.getByRole('button', { name: 'เริ่มทำ' }));

    expect(api.startTicket).toHaveBeenCalledWith('ticket-1');
    // Refetched rather than patched in place: one code path for "we changed it"
    // and "somebody else did".
    await waitFor(() => expect(api.kitchenBoard).toHaveBeenCalledTimes(2));
  });

  it('ticks off one bowl without closing the whole ticket', async () => {
    await renderBoard([ticket()]);
    vi.mocked(api.completeTicketLine).mockResolvedValue({ ok: true, data: { ticket: ticket() } });

    await tap(screen.getByRole('button', { name: /ก๋วยเตี๋ยวหมู/ }));

    expect(api.completeTicketLine).toHaveBeenCalledWith('line-1');
  });

  it('offers to bring a closed ticket back', async () => {
    await renderBoard([ticket({ status: 'DONE', doneAt: minutesAgo(1) })]);
    vi.mocked(api.recallTicket).mockResolvedValue({ ok: true, data: { ticket: ticket() } });

    await tap(screen.getByRole('button', { name: 'เรียกคืน' }));

    expect(api.recallTicket).toHaveBeenCalledWith('ticket-1');
  });

  it('shows the server’s complaint instead of failing silently', async () => {
    await renderBoard([ticket({ status: 'DONE', doneAt: minutesAgo(1) })]);
    vi.mocked(api.recallTicket).mockResolvedValue({
      ok: false,
      error: 'เรียกคืนได้ภายใน 15 นาทีเท่านั้น',
      offline: false,
      status: 409,
    });

    await tap(screen.getByRole('button', { name: 'เรียกคืน' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('เรียกคืนได้ภายใน 15 นาที');
  });
});

describe('filtering by station', () => {
  it('asks the server for one station only', async () => {
    await renderBoard([ticket()]);

    await tap(screen.getByRole('button', { name: 'เครื่องดื่ม' }));

    await waitFor(() => expect(api.kitchenBoard).toHaveBeenCalledWith('เครื่องดื่ม'));
  });
});

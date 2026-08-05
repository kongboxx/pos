/**
 * The kitchen display.
 *
 * This screen is read from about a metre and a half away by someone holding a
 * ladle, in a room that is hot and loud. Everything below follows from that:
 *
 *  - Type is large and the card is the touch target, not a row of small icons.
 *  - Colour carries ONE meaning — how long this has been waiting — and nothing
 *    else on the screen is allowed to use red or amber, so red always means the
 *    same thing across the room.
 *  - There is no money anywhere. The kitchen does not need the price of a bowl
 *    and the payload does not carry it past them.
 *  - A voided line is crossed out and stays visible. A row that silently
 *    disappears is a row nobody noticed, and the whole point of telling the
 *    kitchen about a void is to stop someone cooking it.
 *
 * The board refreshes on a websocket signal AND on a timer. The timer is not
 * belt-and-braces nervousness: it is what makes a dead socket a few seconds of
 * lag instead of a kitchen standing in front of a frozen screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  minutesWaiting,
  ticketUrgency,
  TicketStatus,
  type KitchenTicketDto,
  type KitchenTicketLineDto,
  type TicketUrgency,
} from '@pos/shared';
import { api } from '../../api-client.js';
import { onLiveEvent, useLive } from '../../live-store.js';
import { path } from '../../routes.js';

/** How often the board refetches with, and without, a working socket. */
const POLL_LIVE_MS = 15_000;
const POLL_FALLBACK_MS = 4000;
/** How often the "x นาที" figures are redrawn. */
const CLOCK_MS = 10_000;

const URGENCY_CARD: Readonly<Record<TicketUrgency, string>> = {
  fresh: 'border-slate-300 bg-white',
  warn: 'border-amber-400 bg-amber-50',
  late: 'border-red-500 bg-red-50',
};

const URGENCY_CLOCK: Readonly<Record<TicketUrgency, string>> = {
  fresh: 'text-slate-500',
  warn: 'text-amber-700',
  late: 'text-red-700',
};

export function KitchenPage(): React.ReactElement {
  const navigate = useNavigate();
  const connected = useLive((state) => state.connected);

  const [tickets, setTickets] = useState<KitchenTicketDto[] | null>(null);
  const [stations, setStations] = useState<string[]>([]);
  const [station, setStation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held in state so the waiting times tick upward without refetching the board.
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const result = await api.kitchenBoard(station ?? undefined);
    if (result.ok) {
      setTickets(result.data.tickets);
      setStations(result.data.stations);
      setError(null);
    } else {
      setError(result.error);
    }
  }, [station]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), connected ? POLL_LIVE_MS : POLL_FALLBACK_MS);
    return () => clearInterval(timer);
  }, [load, connected]);

  useEffect(() => onLiveEvent((event) => event.type === 'kitchen' && void load()), [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const act = useCallback(
    async (work: () => Promise<{ ok: boolean; error?: string }>) => {
      const result = await work();
      // Reload FIRST, then report. A successful reload clears the error banner,
      // so setting the message before it would wipe the one thing the cook
      // needed to read — which is exactly what happened the first time.
      await load();
      if (!result.ok) setError(result.error ?? 'ทำรายการไม่สำเร็จ');
    },
    [load],
  );

  /**
   * Waiting first, oldest first; finished cards sink to the bottom.
   *
   * The ticket most at risk of being forgotten has to be the one nearest the
   * cook's eye, and a card that was closed thirty seconds ago must never push
   * a live order down the screen.
   */
  const ordered = useMemo(() => {
    const done = (ticket: KitchenTicketDto): number =>
      ticket.status === TicketStatus.DONE ? 1 : 0;
    return [...(tickets ?? [])].sort(
      (a, b) => done(a) - done(b) || a.firedAt.localeCompare(b.firedAt),
    );
  }, [tickets]);

  return (
    <div className="min-h-full bg-slate-800 p-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(path.tables)}
          className="btn h-14 bg-slate-700 px-5 text-lg text-slate-100 hover:bg-slate-600"
        >
          ← ผังโต๊ะ
        </button>

        <StationButton active={station === null} onPress={() => setStation(null)}>
          ทุกจุด
        </StationButton>
        {stations.map((name) => (
          <StationButton key={name} active={station === name} onPress={() => setStation(name)}>
            {name}
          </StationButton>
        ))}

        <span className="ml-auto flex items-center gap-2 text-lg text-slate-300">
          {/* Not an alarm — the board still works without the socket, it just
              refreshes on the timer instead. Saying so keeps a cook from
              chasing a problem that does not affect them. */}
          <span
            aria-hidden
            className={`h-3 w-3 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-500'}`}
          />
          {connected ? 'เชื่อมต่ออยู่' : 'อัปเดตทุก 4 วินาที'}
        </span>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-2xl bg-red-100 p-4 text-xl text-red-900">
          {error}
        </p>
      ) : null}

      {tickets === null ? (
        <p className="p-10 text-center text-2xl text-slate-400">กำลังโหลด…</p>
      ) : ordered.length === 0 ? (
        <p className="p-10 text-center text-3xl text-slate-400">ยังไม่มีออร์เดอร์</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {ordered.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              now={now}
              onStart={() => void act(() => api.startTicket(ticket.id))}
              onDone={() => void act(() => api.completeTicket(ticket.id))}
              onRecall={() => void act(() => api.recallTicket(ticket.id))}
              onLineDone={(lineId) => void act(() => api.completeTicketLine(lineId))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StationButton({
  children,
  active,
  onPress,
}: {
  children: React.ReactNode;
  active: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={active}
      className={`btn h-14 px-6 text-lg ${
        active ? 'bg-white text-slate-900' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
      }`}
    >
      {children}
    </button>
  );
}

function TicketCard({
  ticket,
  now,
  onStart,
  onDone,
  onRecall,
  onLineDone,
}: {
  ticket: KitchenTicketDto;
  now: Date;
  onStart: () => void;
  onDone: () => void;
  onRecall: () => void;
  onLineDone: (lineId: string) => void;
}): React.ReactElement {
  const isDone = ticket.status === TicketStatus.DONE;
  // A finished card is grey whatever its age: it is history, and leaving it red
  // would keep drawing the eye to the one thing that needs no attention.
  const urgency: TicketUrgency = isDone ? 'fresh' : ticketUrgency(ticket.firedAt, now);
  const minutes = minutesWaiting(ticket.firedAt, now);

  return (
    <article
      aria-label={`บัตรครัว ${ticket.tableName ?? ticket.channelLabel}`}
      className={`flex flex-col rounded-2xl border-4 ${URGENCY_CARD[urgency]} ${
        isDone ? 'opacity-60' : ''
      }`}
    >
      <header className="flex items-start justify-between gap-2 border-b-2 border-inherit p-3">
        <div className="min-w-0">
          <p className="truncate text-4xl font-bold leading-tight">
            {ticket.tableName ?? ticket.channelLabel}
          </p>
          <p className="tnum text-base text-slate-500">
            {ticket.orderNo ?? 'รอเลขบิล'} · {ticket.station}
          </p>
        </div>
        <p className={`tnum shrink-0 text-3xl font-bold ${URGENCY_CLOCK[urgency]}`}>{minutes} น.</p>
      </header>

      <ul className="flex-1 divide-y divide-slate-200">
        {ticket.lines.map((line) => (
          <TicketLine key={line.id} line={line} onDone={() => onLineDone(line.id)} />
        ))}
      </ul>

      <footer className="p-3">
        {isDone ? (
          <button
            type="button"
            onClick={onRecall}
            className="btn h-16 w-full bg-slate-200 text-xl text-slate-700 hover:bg-slate-300"
          >
            เรียกคืน
          </button>
        ) : ticket.status === TicketStatus.PENDING ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onStart}
              className="btn h-16 bg-slate-200 text-xl text-slate-800 hover:bg-slate-300"
            >
              เริ่มทำ
            </button>
            <button
              type="button"
              onClick={onDone}
              className="btn h-16 bg-emerald-600 text-xl text-white hover:bg-emerald-500"
            >
              เสร็จแล้ว
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onDone}
            className="btn h-16 w-full bg-emerald-600 text-2xl text-white hover:bg-emerald-500"
          >
            เสร็จแล้ว
          </button>
        )}
      </footer>
    </article>
  );
}

function TicketLine({
  line,
  onDone,
}: {
  line: KitchenTicketLineDto;
  onDone: () => void;
}): React.ReactElement {
  const voided = line.voidedAt !== null;
  const done = line.doneAt !== null;

  return (
    <li>
      <button
        type="button"
        onClick={onDone}
        disabled={voided || done}
        className="flex w-full items-start gap-3 p-3 text-left disabled:cursor-default"
      >
        <span className="tnum shrink-0 text-3xl font-bold">{line.qty}×</span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-2xl font-semibold ${
              voided ? 'text-red-700 line-through' : done ? 'text-slate-400 line-through' : ''
            }`}
          >
            {line.nameSnapshot}
          </span>
          {/* The options are the part a cook actually cooks from, so they are
              nearly as large as the dish name rather than a caption under it. */}
          {line.modifiersSummary ? (
            <span className="block text-xl text-slate-600">{line.modifiersSummary}</span>
          ) : null}
          {line.note ? (
            <span className="block text-xl font-semibold text-amber-800">* {line.note}</span>
          ) : null}
          {voided ? (
            <span className="block text-xl font-bold text-red-700">ยกเลิกแล้ว — หยุดทำ</span>
          ) : null}
        </span>
        {done && !voided ? <span className="shrink-0 text-3xl text-emerald-600">✓</span> : null}
      </button>
    </li>
  );
}

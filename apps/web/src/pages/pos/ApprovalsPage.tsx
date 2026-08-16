/**
 * The queue of things customers have asked for and nobody has answered (Step 7).
 *
 * This screen is the reason the QR code is safe to have: nothing a customer
 * types reaches the kitchen until somebody presses a button here. So the
 * screen's job is to make that press fast and to make a forgotten row
 * impossible to miss.
 *
 * Grouped by TABLE, not by line, because the question a member of staff asks is
 * "is anyone actually sitting at A3" — and that question is answered once for
 * the whole table, not once per bowl. The per-line buttons are still there for
 * the case that needs them ("ลูกชิ้นหมด, the rest is fine").
 *
 * The wait clock counts in seconds and goes red at three minutes, because a
 * customer who has been staring at "รอพนักงานยืนยัน" for three minutes has
 * already decided the QR code does not work and is looking for someone to wave
 * at — which is the walk this whole feature was meant to save.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  formatSatang,
  qrWaitUrgency,
  secondsWaiting,
  type PendingApprovalOrderDto,
  type QrWaitUrgency,
} from '@pos/shared';
import { api } from '../../api-client.js';
import { onLiveEvent } from '../../live-store.js';
import { path } from '@pos/web-kit';

/** Slow: the socket does the telling. This only covers a socket that died. */
const POLL_MS = 15_000;

export function ApprovalsPage(): React.ReactElement {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<PendingApprovalOrderDto[] | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-renders the clocks. The data does not change; the elapsed time does.
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    const result = await api.pendingApproval();
    if (result.ok) {
      setOrders(result.data.orders);
      setError(null);
    } else if (!result.offline) {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    // The push is what makes this feel immediate: a customer presses send and
    // the row appears here without anyone touching the tablet.
    const unsubscribe = onLiveEvent((event) => {
      if (event.type === 'qr') void load();
    });
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      unsubscribe();
    };
  }, [load]);

  const answer = useCallback(
    async (orderId: string, lineIds: string[], accept: boolean) => {
      setBusyOrderId(orderId);
      const result = accept
        ? await api.approveQrLines(orderId, lineIds)
        : await api.rejectQrLines(orderId, lineIds);
      setBusyOrderId(null);

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      await load();
    },
    [load],
  );

  return (
    <div className="min-h-full bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div>
          <h1 className="text-xl font-bold">ออร์เดอร์จาก QR</h1>
          <p className="text-sm text-slate-500">
            {orders === null
              ? 'กำลังโหลด…'
              : orders.length === 0
                ? 'ไม่มีรายการรอยืนยัน'
                : `${orders.length} โต๊ะกำลังรอ`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate(path.tables)}
          className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
        >
          ← กลับไปหน้าโต๊ะ
        </button>
      </header>

      {error ? (
        <p role="alert" className="mx-6 mt-4 rounded-xl bg-red-50 p-4 text-red-900">
          {error}
        </p>
      ) : null}

      <main className="grid gap-4 p-6 lg:grid-cols-2">
        {orders?.length === 0 ? (
          <p className="text-slate-400">ยังไม่มีลูกค้าสั่งผ่าน QR ตอนนี้</p>
        ) : null}

        {(orders ?? []).map((order) => (
          <TableCard
            key={order.orderId}
            order={order}
            busy={busyOrderId === order.orderId}
            onOpenBill={() => navigate(path.order(order.orderId))}
            onAnswer={(lineIds, accept) => void answer(order.orderId, lineIds, accept)}
          />
        ))}
      </main>
    </div>
  );
}

function TableCard({
  order,
  busy,
  onOpenBill,
  onAnswer,
}: {
  order: PendingApprovalOrderDto;
  busy: boolean;
  onOpenBill: () => void;
  onAnswer: (lineIds: string[], accept: boolean) => void;
}): React.ReactElement {
  const allIds = order.lines.map((line) => line.id);
  const urgency = qrWaitUrgency(order.waitingSince);

  return (
    <section className={`rounded-2xl border-2 bg-white p-4 ${CARD_TONE[urgency]}`}>
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-2xl font-bold">{order.tableName ?? 'ไม่ระบุโต๊ะ'}</h2>
        <span className={`tnum text-lg ${TEXT_TONE[urgency]}`}>
          รอมา {formatWait(order.waitingSince)}
        </span>
      </header>

      <ul className="mb-4">
        {order.lines.map((line) => (
          <li key={line.id} className="flex items-center gap-3 border-b border-slate-100 py-2">
            <span className="tnum w-8 text-xl font-bold">{line.qty}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg">{line.name}</p>
              {line.optionsSummary ? (
                <p className="truncate text-slate-500">{line.optionsSummary}</p>
              ) : null}
              {line.note ? <p className="truncate text-amber-700">{line.note}</p> : null}
            </div>
            <span className="tnum text-slate-600">{formatSatang(line.lineTotalSatang)}</span>
            {/* Per-line, for "ลูกชิ้นหมด but the rest is fine". The common case
                is the pair of buttons below, so this one stays small. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => onAnswer([line.id], false)}
              className="btn h-11 shrink-0 bg-slate-100 px-3 text-sm text-slate-700 disabled:opacity-40"
            >
              ปฏิเสธ
            </button>
          </li>
        ))}
      </ul>

      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer(allIds, true)}
          className="btn h-16 flex-1 bg-emerald-600 text-lg text-white hover:bg-emerald-500
            disabled:opacity-40"
        >
          ยืนยัน & ส่งครัว
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer(allIds, false)}
          className="btn h-16 bg-slate-100 px-5 text-slate-700 disabled:opacity-40"
        >
          ปฏิเสธทั้งโต๊ะ
        </button>
        <button
          type="button"
          onClick={onOpenBill}
          className="btn h-16 bg-slate-100 px-5 text-slate-700"
        >
          เปิดบิล
        </button>
      </div>
    </section>
  );
}

const CARD_TONE: Readonly<Record<QrWaitUrgency, string>> = {
  fresh: 'border-slate-200',
  warn: 'border-amber-400',
  late: 'border-red-500',
};

const TEXT_TONE: Readonly<Record<QrWaitUrgency, string>> = {
  fresh: 'text-slate-500',
  warn: 'text-amber-700',
  late: 'font-bold text-red-700',
};

/** "45 วินาที" then "3:20 นาที" — seconds matter here, unlike on the board. */
export function formatWait(submittedAt: string, now: Date = new Date()): string {
  const seconds = secondsWaiting(submittedAt, now);
  if (seconds < 60) return `${seconds} วินาที`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} นาที`;
}

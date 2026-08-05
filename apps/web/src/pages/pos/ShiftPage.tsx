/**
 * เปิดกะ / ปิดกะ / นับเงินลิ้นชัก.
 *
 * THE SCREEN IS BUILT AROUND ONE REFUSAL: while the shift is open it will not
 * show what the drawer should hold. Not because the number is a secret — the
 * daily report has the day's cash sales on it — but because putting it next to
 * the box where the cashier types what they counted turns a count into a copy.
 * The expected figure and the gap appear the moment the count is saved, and by
 * then the count is already written down with a name and a time on it.
 *
 * A shift is a time window, so the running figures ARE shown while it is open:
 * "what has this till taken so far" is a fair question at 3pm, and hiding it
 * would only send people to the reports screen for the same number.
 *
 * ONLINE ONLY, and not by omission: the drawer count is a single record for the
 * whole branch and two tablets counting the same drawer offline would be two
 * different answers to one question. The button says so rather than failing.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  describeVariance,
  formatSatang,
  isVarianceWorthAsking,
  parseBahtToSatang,
  Permission,
  type ShiftDto,
} from '@pos/shared';
import { api } from '../../api-client.js';
import { useSession } from '../../session-store.js';
import { useSync } from '../../offline/sync-store.js';
import { path } from '../../routes.js';

export function ShiftPage(): React.ReactElement {
  const navigate = useNavigate();
  const online = useSync((state) => state.online);
  const canViewReports = useSession((state) => state.can(Permission.VIEW_REPORTS));

  const [shift, setShift] = useState<ShiftDto | null | undefined>(undefined);
  const [history, setHistory] = useState<ShiftDto[]>([]);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The shift that was just closed, held so its variance stays on screen. */
  const [justClosed, setJustClosed] = useState<ShiftDto | null>(null);

  const load = useCallback(async () => {
    const current = await api.currentShift();
    if (!current.ok) {
      setError(current.error);
      setShift(null);
      return;
    }
    setShift(current.data.shift);
    setError(null);

    // Only the owner and managers may read it; a cashier gets the top half of
    // this screen and no history, which is the permission matrix showing
    // through rather than a hidden feature.
    if (canViewReports) {
      const past = await api.shifts();
      if (past.ok) setHistory(past.data.shifts.filter((row) => row.closedAt !== null));
    }
  }, [canViewReports]);

  useEffect(() => {
    void load();
  }, [load]);

  const amountSatang = parseBahtToSatang(typed);
  const ready = amountSatang !== null && amountSatang >= 0 && !busy && online;

  const submit = useCallback(async () => {
    if (amountSatang === null) return;
    setBusy(true);
    setError(null);

    const result = shift
      ? await api.closeShift({ countedCashSatang: amountSatang, note: note.trim() || null })
      : await api.openShift({ openingCashSatang: amountSatang, note: note.trim() || null });

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setTyped('');
    setNote('');
    setJustClosed(shift ? result.data.shift : null);
    await load();
  }, [amountSatang, shift, note, load]);

  if (shift === undefined) {
    return <p className="p-6 text-slate-400">กำลังโหลด…</p>;
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(path.tables)}
          className="btn h-12 bg-slate-100 px-5 text-slate-700 hover:bg-slate-200"
        >
          ← ผังโต๊ะ
        </button>
        <h1 className="text-2xl font-bold">กะและเงินในลิ้นชัก</h1>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-red-900">
          {error}
        </p>
      ) : null}

      {!online ? (
        <p className="mb-4 rounded-xl bg-amber-50 p-3 text-amber-900">
          ออฟไลน์อยู่ — เปิด/ปิดกะไม่ได้ เพราะลิ้นชักมีใบเดียวทั้งร้าน
          ถ้าสองเครื่องนับพร้อมกันตอนไม่มีเน็ตจะได้คนละคำตอบ
        </p>
      ) : null}

      {/* The result of the count that was just saved. Shown above the form so
          it is the first thing read after pressing ปิดกะ. */}
      {justClosed && justClosed.varianceSatang !== null ? (
        <section
          aria-label="ผลการนับเงิน"
          className={`mb-6 rounded-2xl p-5 ${
            isVarianceWorthAsking(justClosed.varianceSatang)
              ? 'bg-red-50 text-red-900'
              : 'bg-emerald-50 text-emerald-900'
          }`}
        >
          <h2 className="text-xl font-bold">
            ปิดกะแล้ว — {describeVariance(justClosed.varianceSatang)}
          </h2>
          <dl className="tnum mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-lg">
            <dt>ควรมีในลิ้นชัก</dt>
            <dd className="text-right">{formatSatang(justClosed.expectedCashSatang ?? 0)}</dd>
            <dt>นับได้จริง</dt>
            <dd className="text-right">{formatSatang(justClosed.countedCashSatang ?? 0)}</dd>
          </dl>
        </section>
      ) : null}

      {shift ? (
        <section
          aria-label="กะที่เปิดอยู่"
          className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
        >
          <h2 className="text-xl font-bold">กะเปิดอยู่</h2>
          <p className="mt-1 text-slate-500">
            {shift.staffName} · เปิดเมื่อ {formatClock(shift.openedAt)}
          </p>

          <dl className="tnum mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-lg">
            <dt>เงินทอนตั้งต้น</dt>
            <dd className="text-right">{formatSatang(shift.openingCashSatang)}</dd>
            <dt>ขายเงินสด ({shift.billCount} บิล)</dt>
            <dd className="text-right">{formatSatang(shift.cashSalesSatang)}</dd>
            <dt>จ่ายออกจากลิ้นชัก</dt>
            {/* The minus sign only when there is something to subtract:
                "-0.00" reads as a mistake to anyone glancing at a money column. */}
            <dd className="text-right">
              {shift.cashOutSatang > 0 ? '-' : ''}
              {formatSatang(shift.cashOutSatang)}
            </dd>
            <dt className="text-slate-400">พร้อมเพย์ (ไม่อยู่ในลิ้นชัก)</dt>
            <dd className="text-right text-slate-400">{formatSatang(shift.transferSalesSatang)}</dd>
          </dl>

          {/* Deliberately no "ควรมีในลิ้นชัก" line here. See the file header. */}
          <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
            นับเงินในลิ้นชักให้เสร็จก่อน แล้วค่อยพิมพ์ยอดที่นับได้
            ระบบจะบอกว่าตรงกับที่ควรมีไหมหลังกดปิดกะ
          </p>
        </section>
      ) : (
        <section
          aria-label="ยังไม่เปิดกะ"
          className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
        >
          <h2 className="text-xl font-bold">ยังไม่ได้เปิดกะ</h2>
          <p className="mt-1 text-slate-600">
            ใส่เงินทอนตั้งต้นที่อยู่ในลิ้นชักตอนนี้ แล้วกดเปิดกะ
            ของที่ขายก่อนเปิดกะจะไม่ถูกนับในกะนี้
          </p>
        </section>
      )}

      <section aria-label={shift ? 'ปิดกะ' : 'เปิดกะ'} className="mt-6">
        <label className="block">
          <span className="text-lg font-semibold">
            {shift ? 'นับเงินในลิ้นชักได้เท่าไหร่' : 'เงินทอนตั้งต้น'}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={!online}
            className="tnum mt-1 h-16 w-full rounded-xl border border-slate-300 px-4 text-3xl
              disabled:bg-slate-50"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm text-slate-600">หมายเหตุ (ไม่ใส่ก็ได้)</span>
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={200}
            disabled={!online}
            className="mt-1 h-12 w-full rounded-xl border border-slate-300 px-4 text-lg
              disabled:bg-slate-50"
          />
        </label>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!ready}
          className={`btn mt-5 h-16 w-full text-xl text-white disabled:opacity-40 ${
            shift ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-brand-600 hover:bg-brand-500'
          }`}
        >
          {shift ? 'ปิดกะและบันทึกยอดที่นับได้' : 'เปิดกะ'}
        </button>
      </section>

      {canViewReports && history.length > 0 ? (
        <section aria-label="กะที่ผ่านมา" className="mt-8">
          <h2 className="mb-3 text-xl font-bold">กะที่ผ่านมา</h2>
          <ul className="space-y-2">
            {history.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline justify-between rounded-xl bg-white p-4 ring-1
                  ring-slate-200"
              >
                <span>
                  {formatClock(row.openedAt)} – {formatClock(row.closedAt ?? row.openedAt)}
                  <span className="ml-2 text-slate-500">{row.staffName}</span>
                </span>
                <span
                  className={`tnum font-semibold ${
                    row.varianceSatang !== null && isVarianceWorthAsking(row.varianceSatang)
                      ? 'text-red-700'
                      : 'text-slate-600'
                  }`}
                >
                  {describeVariance(row.varianceSatang ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** "30/07 20:45" — the date matters because a shift can cross midnight. */
function formatClock(iso: string): string {
  const at = new Date(iso);
  return at.toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

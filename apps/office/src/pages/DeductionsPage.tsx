/**
 * หักเงิน — recording money that will come off somebody's pay (Step 9).
 *
 * This is a ledger, not a running balance, and that is the important part. Each
 * row is one event on one date with one reason, and it stays visible after the
 * payslip has taken it — marked ตัดแล้ว rather than removed. A screen that only
 * showed "อ่องติดอยู่ 300" would be impossible to argue with when the person it
 * describes disagrees, which is exactly the conversation this data exists for.
 *
 * A settled row cannot be edited or deleted: the money has been handed over and
 * printed on a slip, and changing it now would only make the two disagree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEDUCTION_TYPES,
  DeductionType,
  deductionTypeLabel,
  formatSatang,
  parseBahtToSatang,
  Permission,
  yearMonthOf,
  type DeductionDto,
  type DeductionListResponse,
  type StaffListResponse,
} from '@pos/shared';
import { officeApi } from '../api-office.js';
import { useBusinessToday } from '../business-day.js';
import { StaffShell } from '../components/StaffShell.js';
import { useSession } from '../session.js';

export function DeductionsPage(): React.ReactElement {
  const today = useBusinessToday();
  const canWrite = useSession((state) => state.can(Permission.MANAGE_STAFF));

  const [month, setMonth] = useState(() => yearMonthOf(today));
  const [data, setData] = useState<DeductionListResponse | null>(null);
  const [roster, setRoster] = useState<StaffListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(today);
  const [type, setType] = useState<DeductionType>(DeductionType.LATE);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (on: string) => {
    setLoading(true);
    const result = await officeApi.deductions(on);
    setLoading(false);
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — หน้านี้ต้องออนไลน์' : result.error);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [month, load]);

  useEffect(() => {
    void (async () => {
      const result = await officeApi.staff();
      if (result.ok) setRoster(result.data);
    })();
  }, []);

  const submit = useCallback(async () => {
    const amountSatang = parseBahtToSatang(amount);
    if (!staffId) {
      setError('เลือกพนักงานก่อน');
      return;
    }
    if (amountSatang === null || amountSatang <= 0) {
      setError('ใส่จำนวนเงินให้ถูกต้อง');
      return;
    }

    setBusy(true);
    const result = await officeApi.createDeduction({
      staffId,
      date,
      type,
      amountSatang,
      note: note.trim() === '' ? null : note.trim(),
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — บันทึกไม่สำเร็จ' : result.error);
      return;
    }
    setError(null);
    setData(result.data);
    setMonth(result.data.yearMonth);
    // Keep the person, the date and the reason: recording a shift's worth of
    // lateness is the same three fields over and over.
    setAmount('');
    setNote('');
    amountRef.current?.focus();
  }, [staffId, date, type, amount, note]);

  const remove = useCallback(async (row: DeductionDto) => {
    if (!globalThis.confirm(`ลบรายการหัก ${formatSatang(row.amountSatang)} ของ ${row.staffName}?`))
      return;
    setBusy(true);
    const result = await officeApi.deleteDeduction(row.id);
    setBusy(false);
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  const controls = (
    <label className="flex items-center gap-2">
      <span className="text-sm text-slate-600">เดือน</span>
      <input
        type="month"
        aria-label="เดือน"
        value={month}
        onChange={(event) => setMonth(event.target.value)}
        className="tnum h-12 rounded-xl border border-slate-300 px-3 text-lg"
      />
    </label>
  );

  const employable = (roster?.staff ?? []).filter((person) => person.status !== 'LEFT');

  return (
    <StaffShell controls={controls} error={error} loading={loading && data === null}>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {canWrite ? (
            <form
              aria-label="บันทึกการหักเงิน"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="rounded-2xl bg-white p-5"
            >
              <h2 className="text-lg font-semibold">บันทึกการหักเงิน</h2>

              <div className="mt-3 grid grid-cols-5 gap-2">
                {DEDUCTION_TYPES.map((info) => (
                  <button
                    key={info.key}
                    type="button"
                    aria-pressed={type === info.key}
                    onClick={() => setType(info.key)}
                    className={`btn h-16 flex-col gap-0 px-2 ${
                      type === info.key
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    <span className="font-semibold">{info.label}</span>
                    <span className="text-xs opacity-70">{info.hint}</span>
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="w-56">
                  <span className="text-sm text-slate-600">พนักงาน</span>
                  <select
                    aria-label="พนักงาน"
                    value={staffId}
                    onChange={(event) => setStaffId(event.target.value)}
                    className="input mt-1"
                  >
                    <option value="">— เลือก —</option>
                    {employable.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.nickname ?? person.fullName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="w-44">
                  <span className="text-sm text-slate-600">วันที่</span>
                  <input
                    type="date"
                    aria-label="วันที่"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    className="input tnum mt-1"
                  />
                </label>
                <label className="w-40">
                  <span className="text-sm text-slate-600">จำนวนเงิน (บาท)</span>
                  <input
                    ref={amountRef}
                    type="text"
                    inputMode="decimal"
                    aria-label="จำนวนเงิน (บาท)"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    className="input tnum mt-1 text-right"
                  />
                </label>
                <label className="min-w-48 flex-1">
                  <span className="text-sm text-slate-600">หมายเหตุ</span>
                  <input
                    type="text"
                    aria-label="หมายเหตุ"
                    placeholder="เช่น สาย 30 นาที"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    className="input mt-1"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="btn h-12 bg-brand-600 px-8 text-white hover:bg-brand-500 disabled:opacity-50"
                >
                  บันทึก
                </button>
              </div>
            </form>
          ) : null}

          <ul className="space-y-2">
            {(data?.deductions ?? []).map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4"
              >
                <span className="tnum w-28 text-slate-500">{row.date}</span>
                <span className="w-32 font-medium">{row.staffName}</span>
                <span className="w-32">{deductionTypeLabel(row.type)}</span>
                <span className="min-w-32 flex-1 text-slate-600">{row.note ?? ''}</span>
                <span className="tnum w-28 text-right text-lg font-semibold">
                  {formatSatang(row.amountSatang)}
                </span>
                {row.isSettled ? (
                  <span className="rounded-lg bg-slate-100 px-2 py-1 text-sm text-slate-500">
                    ตัดจากสลิปแล้ว
                  </span>
                ) : canWrite ? (
                  <button
                    type="button"
                    onClick={() => void remove(row)}
                    disabled={busy}
                    className="btn h-11 bg-red-50 px-4 text-red-800 hover:bg-red-100 disabled:opacity-50"
                  >
                    ลบ
                  </button>
                ) : null}
              </li>
            ))}
            {data && data.deductions.length === 0 ? (
              <li className="rounded-2xl bg-white p-6 text-center text-slate-400">
                เดือนนี้ยังไม่มีการหักเงิน
              </li>
            ) : null}
          </ul>
        </div>

        <section className="h-fit rounded-2xl bg-white p-5">
          <h2 className="text-lg font-semibold">รวมทั้งเดือน</h2>
          <div className="mt-3 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-600">หักทั้งหมด</span>
              <span className="tnum text-lg">{formatSatang(data?.totalSatang ?? 0)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2">
              <span className="text-slate-600">ยังไม่ได้ตัดจากสลิป</span>
              <span className="tnum text-lg font-semibold">
                {formatSatang(data?.unsettledSatang ?? 0)}
              </span>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            ยอดที่ยังไม่ตัดจะถูกดึงเข้าสลิปรอบถัดไปที่กดจ่าย และจะตัดได้ครั้งเดียวเท่านั้น
          </p>
        </section>
      </div>
    </StaffShell>
  );
}

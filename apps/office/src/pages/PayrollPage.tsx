/**
 * เงินเดือน — the monthly run (Step 9).
 *
 * The screen has exactly two moods and never blurs them:
 *
 *  - ยังไม่จ่าย: a worksheet. Days and bonuses are editable, deductions appear
 *    the moment they are recorded, and every figure is recomputed live. Nothing
 *    has been committed.
 *  - จ่ายแล้ว: frozen. Every input is gone, the slips are printable, and the
 *    only remaining action is an explicit ยกเลิกการจ่าย.
 *
 * The one thing this screen must say out loud is what the pay button DOES: it
 * writes a single ค่าแรง expense for the total, which is how wages reach the
 * P&L. If wages were also typed into the expense screen by hand, the month is
 * wrong by a full payroll — so if that has happened, it is on screen before the
 * button is pressed, not after.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatSatang,
  parseBahtToSatang,
  Permission,
  satangToBaht,
  WageType,
  yearMonthOf,
  type PayrollLineDto,
  type PayrollResponse,
} from '@pos/shared';
import { officeApi } from '../api-office.js';
import { useBusinessToday } from '../business-day.js';
import { PayslipDialog } from '../components/PayslipDialog.js';
import { StaffShell } from '../components/StaffShell.js';
import { useSession } from '../session.js';

export function PayrollPage(): React.ReactElement {
  const today = useBusinessToday();
  const canWrite = useSession((state) => state.can(Permission.MANAGE_STAFF));
  const branchName = useSession((state) => state.branch?.name ?? 'ร้าน');

  const [month, setMonth] = useState(() => yearMonthOf(today));
  const [data, setData] = useState<PayrollResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paidDate, setPaidDate] = useState(today);
  const [slipFor, setSlipFor] = useState<string | null>(null);

  const load = useCallback(async (on: string) => {
    setLoading(true);
    const result = await officeApi.payroll(on);
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

  const apply = useCallback(
    (result: Awaited<ReturnType<typeof officeApi.payroll>>, message: string | null) => {
      if (!result.ok) {
        setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — ทำรายการไม่สำเร็จ' : result.error);
        return;
      }
      setData(result.data);
      setError(null);
      setNotice(message);
    },
    [],
  );

  const run = useCallback(
    async (
      call: () => Promise<Awaited<ReturnType<typeof officeApi.payroll>>>,
      message: string | null,
    ) => {
      setBusy(true);
      const result = await call();
      setBusy(false);
      apply(result, message);
    },
    [apply],
  );

  const payroll = data?.payroll ?? null;
  const isPaid = payroll?.paidAt != null;
  const total = payroll?.totalSatang ?? 0;
  const negativeLine = useMemo(
    () => payroll?.lines.find((line) => line.netSatang < 0) ?? null,
    [payroll],
  );

  const pay = useCallback(async () => {
    if (
      !globalThis.confirm(
        `จ่ายเงินเดือนเดือน ${month} รวม ${formatSatang(total)} ?\n` +
          `ระบบจะบันทึกเป็นรายจ่ายหมวดค่าแรง ลงวันที่ ${paidDate} และล็อกสลิปทุกใบ`,
      )
    )
      return;
    await run(
      () => officeApi.payPayroll(month, { paidDate, paidBy: 'CASH' }),
      'จ่ายเงินเดือนเรียบร้อย',
    );
  }, [month, total, paidDate, run]);

  const unpay = useCallback(async () => {
    if (
      !globalThis.confirm(
        'ยกเลิกการจ่ายรอบนี้?\n' +
          'รายจ่ายค่าแรงที่ระบบสร้างจะถูกลบ และรายการหักเงินจะกลับมาเป็น "ยังไม่ตัด"\n' +
          'สลิปที่แจกไปแล้วจะไม่ตรงกับระบบ — ระบบบันทึกไว้ว่าใครกดยกเลิก',
      )
    )
      return;
    await run(() => officeApi.unpayPayroll(month), 'ยกเลิกการจ่ายแล้ว กลับเป็นร่าง');
  }, [month, run]);

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

  const slipLine = payroll?.lines.find((line) => line.id === slipFor) ?? null;

  return (
    <StaffShell
      controls={controls}
      error={error}
      notice={notice}
      loading={loading && data === null}
    >
      {payroll === null ? (
        <section className="rounded-2xl bg-white p-8 text-center">
          <p className="text-lg text-slate-600">ยังไม่ได้สร้างรอบเงินเดือนของเดือน {month}</p>
          <p className="mt-2 text-slate-500">
            ระบบจะดึงพนักงานทุกคนที่ทำงานอยู่ในเดือนนี้มาให้ รวมถึงคนที่ออกกลางเดือน
          </p>
          {canWrite ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => officeApi.generatePayroll(month), 'สร้างรอบเงินเดือนแล้ว')
              }
              className="btn mt-4 h-12 bg-brand-600 px-8 text-white hover:bg-brand-500 disabled:opacity-50"
            >
              สร้างรอบเงินเดือน {month}
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-white p-5">
            <span
              className={`rounded-lg px-3 py-1.5 text-lg font-semibold ${
                isPaid ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'
              }`}
            >
              {isPaid ? `จ่ายแล้ว ${payroll.paidAt?.slice(0, 10)}` : 'ร่าง — ยังไม่จ่าย'}
            </span>
            <span className="text-slate-600">{payroll.lines.length} คน</span>
            <span className="tnum ml-auto text-2xl font-bold">{formatSatang(total)}</span>
          </div>

          {data && data.staffWithoutWageCount > 0 && !isPaid ? (
            <p role="status" className="mb-4 rounded-2xl bg-amber-50 p-4 text-amber-900">
              ⚠ มีพนักงาน {data.staffWithoutWageCount} คนที่ยังไม่ได้ตั้งค่าแรง —
              สลิปของคนนั้นจะเป็น 0.00
            </p>
          ) : null}

          {data && data.manualWageSatang > 0 ? (
            // The wage version of Step 8's double-count warning. Not blocked:
            // usually a genuine advance to one person, occasionally the whole
            // payroll entered twice, and only the owner can tell which.
            <p role="status" className="mb-4 rounded-2xl bg-amber-50 p-4 text-amber-900">
              ⚠ เดือนนี้มีรายจ่ายหมวด "ค่าแรง" ที่พิมพ์เองไว้แล้ว{' '}
              {formatSatang(data.manualWageSatang)} — การกดจ่ายจะบันทึกค่าแรงเพิ่มอีกก้อน
              ถ้าเป็นเงินก้อนเดียวกันให้ไปลบรายการที่พิมพ์เองออกก่อน
            </p>
          ) : null}

          {negativeLine ? (
            <p role="alert" className="mb-4 rounded-2xl bg-red-50 p-4 text-red-900">
              {negativeLine.nickname ?? negativeLine.fullName} ถูกหักมากกว่าค่าแรงที่ได้ —
              จ่ายไม่ได้ ลดยอดหักลงก่อน แล้วค่อยหักส่วนที่เหลือเดือนหน้า
            </p>
          ) : null}

          <table className="w-full overflow-hidden rounded-2xl bg-white">
            <thead className="bg-slate-100 text-left">
              <tr>
                <th className="p-3">พนักงาน</th>
                <th className="p-3">ค่าแรง</th>
                <th className="p-3 text-right">วันทำงาน</th>
                <th className="p-3 text-right">ค่าแรงรวม</th>
                <th className="p-3 text-right">โบนัส</th>
                <th className="p-3 text-right">หัก</th>
                <th className="p-3 text-right">รับสุทธิ</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {payroll.lines.map((line) => (
                <PayrollRow
                  key={line.id}
                  line={line}
                  editable={canWrite && !isPaid}
                  busy={busy}
                  onSave={(daysWorked, bonusSatang) =>
                    run(
                      () =>
                        officeApi.updatePayrollLine(line.id, {
                          daysWorked,
                          bonusSatang,
                          note: null,
                        }),
                      null,
                    )
                  }
                  onSlip={() => setSlipFor(line.id)}
                />
              ))}
            </tbody>
          </table>

          {canWrite ? (
            <div className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-5">
              {isPaid ? (
                <>
                  <p className="flex-1 text-slate-600">
                    รอบนี้ล็อกแล้ว — ตัวเลขทุกใบคงที่ และมีรายจ่ายหมวดค่าแรงบันทึกไว้ในงบแล้ว
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void unpay()}
                    className="btn h-12 bg-red-50 px-6 text-red-800 hover:bg-red-100 disabled:opacity-50"
                  >
                    ยกเลิกการจ่าย
                  </button>
                </>
              ) : (
                <>
                  <label className="w-48">
                    <span className="text-sm text-slate-600">วันที่จ่ายจริง</span>
                    <input
                      type="date"
                      aria-label="วันที่จ่ายจริง"
                      value={paidDate}
                      onChange={(event) => setPaidDate(event.target.value)}
                      className="input tnum mt-1"
                    />
                  </label>
                  <p className="min-w-64 flex-1 text-sm text-slate-500">
                    งบกำไรขาดทุนคิดตามเงินที่ออกจริง ค่าแรงก้อนนี้จะไปอยู่ในเดือนของ
                    "วันที่จ่ายจริง" ไม่ใช่เดือนที่ทำงาน
                  </p>
                  <button
                    type="button"
                    disabled={busy || negativeLine !== null}
                    onClick={() => void pay()}
                    className="btn h-12 bg-brand-600 px-8 text-white hover:bg-brand-500 disabled:opacity-50"
                  >
                    จ่ายเงินเดือน {formatSatang(total)}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => officeApi.generatePayroll(month), 'ดึงรายชื่อพนักงานใหม่แล้ว')
                    }
                    className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                  >
                    ดึงรายชื่อใหม่
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!globalThis.confirm(`ลบร่างเงินเดือนเดือน ${month} ทิ้ง?`)) return;
                      void run(() => officeApi.discardPayroll(month), 'ลบร่างแล้ว');
                    }}
                    className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                  >
                    ลบร่าง
                  </button>
                </>
              )}
            </div>
          ) : null}
        </>
      )}

      {slipLine ? (
        <PayslipDialog
          line={slipLine}
          yearMonth={month}
          branchName={branchName}
          paidAt={payroll?.paidAt ?? null}
          onClose={() => setSlipFor(null)}
        />
      ) : null}
    </StaffShell>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One person's row.
 *
 * Days and bonus are local state committed on blur rather than on every
 * keystroke: each save re-totals the whole run on the server, and firing that
 * per digit would make "24" briefly mean two days' pay on screen.
 */
function PayrollRow({
  line,
  editable,
  busy,
  onSave,
  onSlip,
}: {
  line: PayrollLineDto;
  editable: boolean;
  busy: boolean;
  onSave: (daysWorked: number, bonusSatang: number) => void;
  onSlip: () => void;
}): React.ReactElement {
  const [days, setDays] = useState(String(line.daysWorked));
  const [bonus, setBonus] = useState(String(satangToBaht(line.bonusSatang)));

  useEffect(() => {
    setDays(String(line.daysWorked));
    setBonus(String(satangToBaht(line.bonusSatang)));
  }, [line.daysWorked, line.bonusSatang]);

  const commit = (): void => {
    const daysWorked = Number.parseInt(days, 10);
    const bonusSatang = parseBahtToSatang(bonus === '' ? '0' : bonus);
    if (!Number.isInteger(daysWorked) || daysWorked < 0 || bonusSatang === null) return;
    if (daysWorked === line.daysWorked && bonusSatang === line.bonusSatang) return;
    onSave(daysWorked, bonusSatang);
  };

  return (
    <tr className="border-t border-slate-100">
      <td className="p-3">
        <span className="font-medium">{line.nickname ?? line.fullName}</span>
        {line.position ? (
          <span className="ml-2 text-sm text-slate-500">{line.position}</span>
        ) : null}
      </td>
      <td className="tnum p-3 text-slate-600">
        {formatSatang(line.wageRateSnapshot)}
        <span className="ml-1 text-sm">
          {line.wageTypeSnapshot === WageType.DAILY ? '/วัน' : '/เดือน'}
        </span>
      </td>
      <td className="p-3 text-right">
        {editable ? (
          <input
            type="number"
            aria-label={`วันทำงานของ ${line.nickname ?? line.fullName}`}
            min={0}
            max={31}
            value={days}
            disabled={busy}
            onChange={(event) => setDays(event.target.value)}
            onBlur={commit}
            className="tnum h-11 w-20 rounded-xl border border-slate-300 px-2 text-right text-lg"
          />
        ) : (
          <span className="tnum">{line.daysWorked}</span>
        )}
      </td>
      <td className="tnum p-3 text-right">{formatSatang(line.grossSatang)}</td>
      <td className="p-3 text-right">
        {editable ? (
          <input
            type="text"
            inputMode="decimal"
            aria-label={`โบนัสของ ${line.nickname ?? line.fullName}`}
            value={bonus}
            disabled={busy}
            onChange={(event) => setBonus(event.target.value)}
            onBlur={commit}
            className="tnum h-11 w-24 rounded-xl border border-slate-300 px-2 text-right text-lg"
          />
        ) : (
          <span className="tnum">{formatSatang(line.bonusSatang)}</span>
        )}
      </td>
      <td className="tnum p-3 text-right text-red-700">
        {line.deductSatang > 0 ? `-${formatSatang(line.deductSatang)}` : '—'}
      </td>
      <td
        className={`tnum p-3 text-right text-lg font-semibold ${
          line.netSatang < 0 ? 'text-red-700' : ''
        }`}
      >
        {formatSatang(line.netSatang)}
      </td>
      <td className="p-3 text-right">
        <button
          type="button"
          onClick={onSlip}
          className="btn h-11 bg-slate-100 px-4 text-slate-700 hover:bg-slate-200"
        >
          สลิป
        </button>
      </td>
    </tr>
  );
}

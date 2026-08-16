/**
 * ของที่ยกเลิก (Step 8).
 *
 * Step 5 made every void carry a reason from a fixed list and the PIN of
 * someone who was not the person asking. This is the screen that was the point
 * of all that: at the end of the month the owner can ask "ทิ้งไปเท่าไหร่
 * เพราะอะไร" and get an answer that was not typed by whoever caused it.
 *
 * TWO COLUMNS OF MONEY THAT MEAN DIFFERENT THINGS, and keeping them apart is
 * the whole value of the report:
 *
 *  - ยอดขายที่หายไป is revenue that did not happen. A customer who changes
 *    their mind before the cook starts costs the shop nothing at all.
 *  - ต้นทุนที่ทิ้ง is food in the bin, and only for lines that had already been
 *    fired. THAT is money the shop paid out and will not get back, and it is
 *    the number worth acting on.
 *
 * Sorted by cost, not by count: five cancelled waters are noise, one dropped
 * bowl of หมูตุ๋น is the row to look at.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatSatang, type VoidReportResponse } from '@pos/shared';
import { officeApi } from '../../api-office.js';
import { useBusinessToday } from '../../business-day.js';
import { Card, ReportShell, Row } from '../../components/office/ReportShell.js';

export function VoidReportPage(): React.ReactElement {
  const today = useBusinessToday();
  const [from, setFrom] = useState(() => `${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<VoidReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (start: string, end: string) => {
    if (start > end) {
      setError('วันเริ่มต้องไม่เกินวันสิ้นสุด');
      return;
    }
    setLoading(true);
    const result = await officeApi.voidReport(start, end);
    setLoading(false);
    if (result.ok) {
      setReport(result.data);
      setError(null);
    } else {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — รายงานต้องออนไลน์' : result.error);
    }
  }, []);

  useEffect(() => {
    void load(from, to);
  }, [from, to, load]);

  const controls = (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2">
        <span className="text-sm text-slate-600">ตั้งแต่</span>
        <input
          type="date"
          aria-label="ตั้งแต่"
          value={from}
          max={to}
          onChange={(event) => setFrom(event.target.value)}
          className="tnum h-12 rounded-xl border border-slate-300 px-3 text-lg"
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="text-sm text-slate-600">ถึง</span>
        <input
          type="date"
          aria-label="ถึง"
          value={to}
          max={today}
          onChange={(event) => setTo(event.target.value)}
          className="tnum h-12 rounded-xl border border-slate-300 px-3 text-lg"
        />
      </label>
    </div>
  );

  return (
    <ReportShell controls={controls} error={error} loading={loading && report === null}>
      {report ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="รวมทั้งช่วง">
              <Row label="ยกเลิกไป" value={`${report.totalCount} รายการ`} />
              <Row label="รวมจำนวน" value={`${report.totalQty} ที่`} />
              <Row
                label="ยอดขายที่หายไป"
                hint="รายได้ที่ไม่ได้เกิด"
                value={formatSatang(report.salesValueSatang)}
                tone="muted"
              />
              <Row
                label="ทำแล้วต้องทิ้งจริง"
                hint={`${report.firedCount} รายการ`}
                value={formatSatang(report.firedCostSatang)}
                tone={report.firedCostSatang > 0 ? 'bad' : 'good'}
                strong
              />
              <p className="mt-3 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">
                ตัวที่เป็นเงินจริงคือบรรทัดล่าง — ลูกค้าเปลี่ยนใจก่อนครัวลงมือ ไม่ได้เสียอะไรเลย
              </p>
            </Card>

            <Card title="แยกตามเหตุผล" subtitle="เรียงตามต้นทุนที่เสียไป">
              {report.byReason.length === 0 ? (
                <p className="text-slate-400">ไม่มีรายการที่ถูกยกเลิกในช่วงนี้</p>
              ) : (
                report.byReason.map((row) => (
                  <Row
                    key={row.reason}
                    label={row.reason}
                    hint={`${row.count} ครั้ง · ทำแล้ว ${row.firedCount}`}
                    value={formatSatang(row.costSatang)}
                    tone={row.costSatang > 0 ? 'bad' : 'muted'}
                  />
                ))
              )}
            </Card>
          </div>

          {report.rows.length > 0 ? (
            <section className="overflow-x-auto rounded-2xl bg-white p-5">
              <h2 className="mb-3 text-lg font-semibold">รายการทั้งหมด</h2>
              <table className="w-full min-w-[52rem] text-left">
                <thead className="text-sm text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-2 pr-3 font-medium">วันขาย</th>
                    <th className="py-2 pr-3 font-medium">บิล</th>
                    <th className="py-2 pr-3 font-medium">รายการ</th>
                    <th className="py-2 pr-3 text-right font-medium">ราคาขาย</th>
                    <th className="py-2 pr-3 text-right font-medium">ต้นทุนที่ทิ้ง</th>
                    <th className="py-2 pr-3 font-medium">เหตุผล</th>
                    <th className="py-2 pr-3 font-medium">ใครขอ / ใครอนุมัติ</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100">
                      <td className="tnum py-2 pr-3 text-slate-500">{row.businessDate}</td>
                      <td className="tnum py-2 pr-3 text-slate-500">{row.orderNo ?? '—'}</td>
                      <td className="py-2 pr-3">
                        {row.qty}× {row.nameSnapshot}
                        {row.note ? (
                          <span className="ml-2 text-sm text-slate-400">{row.note}</span>
                        ) : null}
                      </td>
                      <td className="tnum py-2 pr-3 text-right text-slate-500">
                        {formatSatang(row.salesValueSatang)}
                      </td>
                      <td
                        className={`tnum py-2 pr-3 text-right ${
                          row.wasFired ? 'font-semibold text-red-700' : 'text-slate-400'
                        }`}
                      >
                        {/* A line that never reached the kitchen cost nothing,
                            and printing its ingredient cost here would make the
                            column impossible to add up by eye. */}
                        {row.wasFired ? formatSatang(row.costSatang) : '—'}
                      </td>
                      <td className="py-2 pr-3">{row.reason}</td>
                      <td className="py-2 pr-3 text-slate-500">
                        {row.requestedByName} / {row.approvedByName}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>
      ) : null}
    </ReportShell>
  );
}

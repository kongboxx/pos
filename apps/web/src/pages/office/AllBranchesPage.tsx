/**
 * ยอดขายทุกสาขา (Step 10).
 *
 * The screen the owner opens standing in branch 2 wondering how branch 1 is
 * doing. Deliberately thin: takings, bills, average, what is still open, and
 * what was handed back. Anything more belongs on that branch's own report,
 * which is a login away and correctly scoped by rule #1.
 *
 * Owner only. A branch manager runs their own shop and is measured on it;
 * every other branch's daily total is not part of that job.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatSatang, type AllBranchesResponse } from '@pos/shared';
import { officeApi } from '../../api-office.js';
import { useBusinessToday } from '../../business-day.js';
import { SettingsShell } from '../../components/office/SettingsShell.js';

export function AllBranchesPage(): React.ReactElement {
  const today = useBusinessToday();
  const [date, setDate] = useState(today);
  const [data, setData] = useState<AllBranchesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (on: string) => {
    setLoading(true);
    const result = await officeApi.allBranches(on);
    setLoading(false);
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — หน้านี้ต้องออนไลน์' : result.error);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  return (
    <SettingsShell
      error={error}
      loading={loading}
      controls={
        <input
          type="date"
          aria-label="วันที่"
          className="input w-44"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      }
    >
      <section className="rounded-2xl bg-white p-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-left text-sm text-slate-500">
                <th className="py-2">สาขา</th>
                <th className="py-2 text-right">บิล</th>
                <th className="py-2 text-right">ยอดขาย</th>
                <th className="py-2 text-right">VAT</th>
                <th className="py-2 text-right">เฉลี่ย/บิล</th>
                <th className="py-2 text-right">บิลค้าง</th>
                <th className="py-2 text-right">ใบลดหนี้</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((row) => (
                <tr key={row.branchId} className="border-b border-slate-100">
                  <td className="py-3">
                    <span className="font-semibold">{row.branchName}</span>
                    <span className="ml-2 text-sm text-slate-400">{row.branchCode}</span>
                    {row.isCurrent ? (
                      <span className="ml-2 rounded-lg bg-brand-50 px-2 py-0.5 text-sm text-brand-700">
                        สาขานี้
                      </span>
                    ) : null}
                  </td>
                  <td className="tnum py-3 text-right">{row.paidOrderCount}</td>
                  <td className="tnum py-3 text-right text-lg font-semibold">
                    {formatSatang(row.netSalesSatang)}
                  </td>
                  <td className="tnum py-3 text-right text-slate-500">
                    {row.vatSatang > 0 ? formatSatang(row.vatSatang) : '—'}
                  </td>
                  <td className="tnum py-3 text-right text-slate-500">
                    {row.averageBillSatang === null ? '—' : formatSatang(row.averageBillSatang)}
                  </td>
                  <td className="tnum py-3 text-right">
                    {row.openOrderCount === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <>
                        {row.openOrderCount} ใบ · {formatSatang(row.openOrderTotalSatang)}
                      </>
                    )}
                  </td>
                  <td className="tnum py-3 text-right">
                    {row.creditNoteCount === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span className="text-red-700">
                        {row.creditNoteCount} ใบ · {formatSatang(row.creditNoteSatang)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="py-3">รวมทุกสาขา</td>
                <td className="tnum py-3 text-right">{data?.totalPaidOrderCount ?? 0}</td>
                <td className="tnum py-3 text-right text-xl">
                  {formatSatang(data?.totalNetSalesSatang ?? 0)}
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="mt-4 text-sm text-slate-500">
          ยอดขายไม่รวม VAT (เก็บแทนสรรพากร ไม่ใช่เงินร้าน) และไม่รวมบิลที่ยังไม่ปิด ·
          บิลที่ออกใบลดหนี้จะถูกหักออกจากวันที่ขายเดิม ไม่ใช่วันที่ออกใบลดหนี้
        </p>
      </section>
    </SettingsShell>
  );
}

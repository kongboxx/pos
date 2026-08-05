/**
 * กำไรขาดทุน + จุดคุ้มทุน (Step 8).
 *
 * THE LAYOUT IS THE ARGUMENT. There are two panels and they are deliberately
 * not stacked into one column of arithmetic, because the single most damaging
 * thing this screen could do is invite someone to subtract both cost figures
 * from the same sales:
 *
 *  - LEFT is the P&L, cash basis. เงินเข้า minus เงินที่จ่ายออกจริง. It is the
 *    number that should agree with the shop's bank account, and it answers
 *    "เดือนนี้ได้กำไรไหม".
 *  - RIGHT is the recipe view, and it is a PRICING tool. It answers "ตั้งราคา
 *    ชามนี้ถูกไปไหม" and it is what feeds the break-even, where a per-bowl
 *    variable cost is exactly right and a lumpy purchase invoice is useless.
 *
 * ค่าวัตถุดิบที่ซื้อ and ต้นทุนอาหารตามสูตร are two ways of counting the same
 * money. The line under the right-hand panel says so in as many words, because
 * the person reading this will otherwise do the subtraction themselves and
 * conclude a profitable shop is losing money.
 */

import { useCallback, useEffect, useState } from 'react';
import { expenseCategoryLabel, formatSatang, yearMonthOf, type PnlResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { useBusinessToday } from '../../business-day.js';
import { Card, formatBp, ReportShell, Row } from '../../components/office/ReportShell.js';

export function PnlPage(): React.ReactElement {
  const today = useBusinessToday();
  const [month, setMonth] = useState(() => yearMonthOf(today));
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (on: string) => {
    setLoading(true);
    const result = await api.pnl(on);
    setLoading(false);
    if (result.ok) {
      setPnl(result.data);
      setError(null);
    } else {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — รายงานต้องออนไลน์' : result.error);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [month, load]);

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

  return (
    <ReportShell controls={controls} error={error} loading={loading && pnl === null}>
      {pnl ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="กำไรขาดทุน" subtitle="เงินเข้าจริง − เงินออกจริงที่บันทึกไว้">
            <Row
              label="ยอดขาย"
              hint={`${pnl.paidOrderCount} บิล`}
              value={formatSatang(pnl.grossSalesSatang)}
            />
            {pnl.vatSatang > 0 ? (
              <Row
                label="หัก VAT"
                hint="เก็บแทนสรรพากร"
                value={`−${formatSatang(pnl.vatSatang)}`}
                tone="muted"
              />
            ) : null}
            <Row label="รายรับสุทธิ" value={formatSatang(pnl.netSalesSatang)} strong />

            <div className="mt-4">
              {pnl.byCategory.length === 0 ? (
                <p className="text-slate-400">ยังไม่ได้บันทึกรายจ่ายของเดือนนี้</p>
              ) : (
                pnl.byCategory.map((row) => (
                  <Row
                    key={row.category}
                    label={expenseCategoryLabel(row.category)}
                    hint={row.kind === 'VARIABLE' ? 'ผันแปร' : 'คงที่'}
                    value={`−${formatSatang(row.amountSatang)}`}
                  />
                ))
              )}
              <Row label="รวมรายจ่าย" value={`−${formatSatang(pnl.expenseTotalSatang)}`} strong />
            </div>

            <div className="mt-4">
              <Row
                label={pnl.netProfitSatang >= 0 ? 'กำไรสุทธิ' : 'ขาดทุน'}
                value={formatSatang(Math.abs(pnl.netProfitSatang))}
                tone={pnl.netProfitSatang >= 0 ? 'good' : 'bad'}
                strong
              />
            </div>

            {pnl.byCategory.length === 0 && pnl.grossSalesSatang > 0 ? (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-900">
                ⚠ เดือนนี้ยังไม่มีรายจ่ายเลยสักรายการ ตัวเลข &quot;กำไรสุทธิ&quot;
                ข้างบนจึงเท่ากับยอดขาย — ไปบันทึกที่แท็บ รายจ่าย ก่อน
              </p>
            ) : null}
          </Card>

          <div className="space-y-4">
            <Card
              title="เช็คว่าตั้งราคาถูกไหม"
              subtitle="คิดจากสูตรของแต่ละชาม ไม่ใช่เงินที่จ่ายซื้อของ"
            >
              <Row label="ต้นทุนอาหารตามสูตร" value={formatSatang(pnl.recipeCostSatang)} />
              <Row
                label="ต้นทุนคิดเป็น"
                hint="ของรายรับสุทธิ"
                value={formatBp(pnl.recipeCostPercentBp)}
              />
              <Row
                label="เหลือไว้จ่ายค่าเช่า/ค่าแรง"
                value={formatSatang(pnl.contributionSatang)}
                tone={pnl.contributionSatang >= 0 ? 'good' : 'bad'}
                strong
              />

              {pnl.coverage.linesWithoutRecipeCount > 0 ? (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-900">
                  ⚠ ขายไป {pnl.coverage.soldLineCount} รายการ มี{' '}
                  <strong>{pnl.coverage.linesWithoutRecipeCount} รายการที่ยังไม่ได้ใส่สูตร</strong>{' '}
                  — ระบบคิดต้นทุนเป็น 0 ตัวเลขต้นทุนจึงต่ำกว่าความจริง
                  และจุดคุ้มทุนข้างล่างจะดูง่ายเกินไป
                </p>
              ) : null}

              <p className="mt-3 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">
                อย่าเอาตัวเลขก้อนนี้ไปลบออกจากกำไรทางซ้ายอีกรอบ —
                <strong>
                  {' '}
                  &quot;ค่าวัตถุดิบ&quot; ที่จ่ายจริง กับ &quot;ต้นทุนตามสูตร&quot;
                  คือเงินก้อนเดียวกัน
                </strong>{' '}
                แค่คนละวิธีนับ ก้อนซ้ายคือเงินที่ออกจากกระเป๋าจริง ก้อนนี้ไว้ดูว่าราคาขายเหมาะไหม
              </p>
            </Card>

            <Card title="จุดคุ้มทุน" subtitle="ต้องขายเท่าไหร่ถึงจะไม่ขาดทุน">
              {pnl.breakEven.fixedByCategory.map((row) => (
                <Row
                  key={row.category}
                  label={expenseCategoryLabel(row.category)}
                  value={formatSatang(row.amountSatang)}
                  tone="muted"
                />
              ))}
              <Row
                label="ต้นทุนคงที่ต่อเดือน"
                value={formatSatang(pnl.breakEven.fixedCostSatang)}
                strong
              />
              <Row
                label="กำไรส่วนเกิน"
                hint="ทุก 100 บาทที่ขาย เหลือเท่านี้"
                value={formatBp(pnl.breakEven.contributionMarginBp)}
              />

              {pnl.breakEven.breakEvenSalesSatang === null ? (
                <p className="mt-3 rounded-xl bg-red-50 p-3 text-red-900">
                  คำนวณจุดคุ้มทุนไม่ได้ —{' '}
                  {pnl.netSalesSatang === 0
                    ? 'เดือนนี้ยังไม่มียอดขาย'
                    : 'ต้นทุนอาหารสูงกว่าราคาขาย ขายเท่าไหร่ก็ไม่คุ้ม ต้องขึ้นราคาหรือลดต้นทุนก่อน'}
                </p>
              ) : (
                <>
                  <Row
                    label="ต้องขายเดือนละ"
                    value={formatSatang(pnl.breakEven.breakEvenSalesSatang)}
                    strong
                  />
                  <Row
                    label="= วันละ"
                    hint={`ถือว่าเปิด ${pnl.breakEven.daysInMonth} วัน`}
                    value={formatSatang(pnl.breakEven.breakEvenPerDaySatang ?? 0)}
                  />
                  {pnl.breakEven.surplusSatang !== null ? (
                    <Row
                      label={pnl.breakEven.surplusSatang >= 0 ? 'เกินจุดคุ้มทุนแล้ว' : 'ยังขาดอีก'}
                      value={formatSatang(Math.abs(pnl.breakEven.surplusSatang))}
                      tone={pnl.breakEven.surplusSatang >= 0 ? 'good' : 'bad'}
                      strong
                    />
                  ) : null}
                </>
              )}

              {pnl.breakEven.rentFromSettings ? (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-900">
                  เดือนนี้ยังไม่ได้บันทึกค่าเช่าเป็นรายจ่าย ระบบใช้ค่าเช่าที่ตั้งไว้ในสาขาแทนไปก่อน
                </p>
              ) : null}
              {pnl.breakEven.fixedCostSatang === 0 ? (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-900">
                  ⚠ ยังไม่มีต้นทุนคงที่เลย (ค่าเช่า ค่าแรง ค่าน้ำไฟ) จุดคุ้มทุนจึงเป็น 0
                  ซึ่งไม่ใช่ความจริง — บันทึกรายจ่ายพวกนี้ก่อน
                </p>
              ) : null}
            </Card>
          </div>
        </div>
      ) : null}
    </ReportShell>
  );
}

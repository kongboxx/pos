/**
 * ปิดวัน — what happened today (Step 8).
 *
 * The screen someone reads standing up at 21:00 with the drawer open, so the
 * order of it is the order the questions get asked: ขายได้เท่าไหร่ → เงินสด
 * เท่าไหร่ (that is the number counted against the drawer) → จ่ายอะไรไปบ้าง →
 * มีอะไรผิดปกติไหม.
 *
 * TWO WARNINGS ARE LOAD-BEARING AND BOTH SIT ABOVE THE NUMBERS:
 *
 *  1. Open bills. Read at 18:00 with four tables still eating, "ขายได้ 4,850"
 *     is true and useless. The tables are counted on their own line and never
 *     folded into sales, because the moment they are, the report stops matching
 *     the drawer and nobody trusts it again.
 *  2. Dishes with no recipe. unitCostSatang = 0 does not read as "unknown" on
 *     a report, it reads as "free", and a food cost of 12% that is really 34%
 *     is the kind of number a shop makes a pricing decision on.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  formatSatang,
  PAYMENT_METHOD_LABEL,
  expenseCategoryLabel,
  type DailyReportResponse,
} from '@pos/shared';
import { api } from '../../api-client.js';
import { useBusinessToday } from '../../business-day.js';
import { Card, formatBp, ReportShell, Row } from '../../components/office/ReportShell.js';

export function DailyReportPage(): React.ReactElement {
  const today = useBusinessToday();
  const [date, setDate] = useState(today);
  const [report, setReport] = useState<DailyReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (on: string) => {
    setLoading(true);
    const result = await api.dailyReport(on);
    setLoading(false);
    if (result.ok) {
      setReport(result.data);
      setError(null);
    } else {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — รายงานต้องออนไลน์' : result.error);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const controls = (
    <label className="flex items-center gap-2">
      <span className="text-sm text-slate-600">วันขาย</span>
      <input
        type="date"
        aria-label="วันขาย"
        value={date}
        max={today}
        onChange={(event) => setDate(event.target.value)}
        className="tnum h-12 rounded-xl border border-slate-300 px-3 text-lg"
      />
    </label>
  );

  return (
    <ReportShell controls={controls} error={error} loading={loading && report === null}>
      {report ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {report.openOrderCount > 0 ? (
            <p role="status" className="rounded-2xl bg-amber-100 p-4 text-amber-900 lg:col-span-2">
              ยังมีบิลเปิดค้างอยู่ {report.openOrderCount} โต๊ะ รวม{' '}
              <span className="tnum font-bold">{formatSatang(report.openOrderTotalSatang)}</span> —{' '}
              <strong>ยังไม่นับเป็นยอดขาย</strong> ตัวเลขข้างล่างจะขยับอีกเมื่อเก็บเงินครบ
            </p>
          ) : null}

          <Card title="ขายได้" subtitle="นับเฉพาะบิลที่รับเงินแล้ว">
            <Row label="จำนวนบิล" value={`${report.paidOrderCount} บิล`} />
            <Row label="ยอดขายรวม" value={formatSatang(report.grossSalesSatang)} />
            {report.vatSatang > 0 ? (
              <Row
                label="หัก VAT"
                hint="เก็บแทนสรรพากร ไม่ใช่เงินร้าน"
                value={`−${formatSatang(report.vatSatang)}`}
                tone="muted"
              />
            ) : null}
            {report.discountSatang > 0 ? (
              <Row
                label="ส่วนลดที่ให้ไป"
                value={formatSatang(report.discountSatang)}
                tone="muted"
              />
            ) : null}
            <Row
              label="เฉลี่ยต่อบิล"
              value={
                report.averageBillSatang === null ? '—' : formatSatang(report.averageBillSatang)
              }
              tone="muted"
            />
            <Row label="รายรับสุทธิ" value={formatSatang(report.netSalesSatang)} strong />
          </Card>

          <Card title="รับเงินมาทางไหน" subtitle="ใช้ตัวเลขเงินสดเทียบกับลิ้นชัก">
            {report.payments.length === 0 ? (
              <p className="text-slate-400">ยังไม่มีการรับเงินวันนี้</p>
            ) : (
              report.payments.map((payment) => (
                <Row
                  key={payment.method}
                  label={PAYMENT_METHOD_LABEL[payment.method]}
                  hint={`${payment.count} บิล`}
                  value={formatSatang(payment.amountSatang)}
                />
              ))
            )}
          </Card>

          <Card
            title="ต้นทุนอาหารตามสูตร"
            subtitle="คิดจากสูตรที่ใส่ไว้ ไม่ใช่เงินที่จ่ายซื้อของจริง"
          >
            <Row label="ต้นทุนวัตถุดิบในชาม" value={formatSatang(report.recipeCostSatang)} />
            <Row
              label="คิดเป็น"
              hint="ของรายรับสุทธิ"
              value={formatBp(report.recipeCostPercentBp)}
            />
            <Row
              label="เหลือหลังหักของในชาม"
              value={formatSatang(report.grossProfitSatang)}
              tone={report.grossProfitSatang >= 0 ? 'good' : 'bad'}
              strong
            />
            {report.coverage.linesWithoutRecipeCount > 0 ? (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-900">
                ⚠ ขายไป {report.coverage.soldLineCount} รายการ มี{' '}
                <strong>{report.coverage.linesWithoutRecipeCount} รายการที่ยังไม่ได้ใส่สูตร</strong>{' '}
                — ระบบคิดว่าต้นทุนเป็น 0 ตัวเลขข้างบนจึงต่ำกว่าความจริง
              </p>
            ) : null}
          </Card>

          <Card title="จ่ายอะไรไปวันนี้">
            {report.byCategory.length === 0 ? (
              <p className="text-slate-400">ยังไม่ได้บันทึกรายจ่ายของวันนี้</p>
            ) : (
              report.byCategory.map((row) => (
                <Row
                  key={row.category}
                  label={expenseCategoryLabel(row.category)}
                  value={formatSatang(row.amountSatang)}
                />
              ))
            )}
            <Row label="รวมจ่าย" value={formatSatang(report.expenseTotalSatang)} strong />
          </Card>

          <Card title="ของที่ยกเลิกวันนี้" subtitle="ดูรายละเอียดได้ที่แท็บ ของที่ยกเลิก">
            {report.voidCount === 0 ? (
              <p className="text-slate-400">ไม่มีรายการที่ถูกยกเลิก</p>
            ) : (
              <>
                <Row label="ยกเลิกไป" value={`${report.voidCount} รายการ`} />
                <Row
                  label="ยอดขายที่หายไป"
                  value={formatSatang(report.voidSalesValueSatang)}
                  tone="muted"
                />
                <Row
                  label="ทำแล้วต้องทิ้งจริง"
                  hint={`${report.voidFiredCount} รายการ`}
                  value={formatSatang(report.voidCostSatang)}
                  tone={report.voidCostSatang > 0 ? 'bad' : 'plain'}
                />
              </>
            )}
            {report.cancelledOrderCount > 0 ? (
              <Row
                label="บิลที่ถูกยกเลิกทั้งใบ"
                value={`${report.cancelledOrderCount} บิล`}
                tone="muted"
              />
            ) : null}
            {/* Step 10. Kept separate from the figures above it, and the hint
                says why: a credit note takes its sale out of the day the money
                was TAKEN, so the takings on this page already exclude it. This
                line is what was handed back TODAY, which is often another
                day's sale. */}
            {report.creditNoteCount > 0 ? (
              <Row
                label="ใบลดหนี้ที่ออกวันนี้"
                hint={`${report.creditNoteCount} ใบ — หักออกจากยอดของวันที่ขาย`}
                value={formatSatang(report.creditNoteSatang)}
                tone="bad"
              />
            ) : null}
          </Card>
        </div>
      ) : null}
    </ReportShell>
  );
}

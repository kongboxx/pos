/**
 * สลิปเงินเดือน — one person, one month, on paper (Step 9).
 *
 * Every deduction is itemised with its date and reason. That is the whole
 * purpose of the document: a slip reading "หัก 500" is a slip that starts an
 * argument nobody can settle, because the only other copy of why is in somebody's
 * memory. Four lines saying which days and what for ends the conversation.
 *
 * Printed through the browser rather than the thermal printer. The receipt
 * printer is 58mm of till roll that lives at the counter, and a wage slip is
 * neither something to hand over in front of customers nor something to keep on
 * paper that fades.
 */

import {
  formatSatang,
  deductionTypeLabel,
  WAGE_TYPE_LABEL,
  type PayrollLineDto,
} from '@pos/shared';

interface PayslipDialogProps {
  line: PayrollLineDto;
  yearMonth: string;
  branchName: string;
  /** null while the run is still a draft — the slip then says so, loudly. */
  paidAt: string | null;
  onClose: () => void;
}

export function PayslipDialog({
  line,
  yearMonth,
  branchName,
  paidAt,
  onClose,
}: PayslipDialogProps): React.ReactElement {
  return (
    <div
      role="dialog"
      aria-label={`สลิปเงินเดือน ${line.fullName}`}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-6 print:static print:bg-white print:p-0"
    >
      <div className="print-sheet w-full max-w-xl rounded-2xl bg-white p-8">
        <header className="border-b border-slate-300 pb-4 text-center">
          <h2 className="text-xl font-bold">สลิปเงินเดือน</h2>
          <p className="text-slate-600">{branchName}</p>
          <p className="tnum text-slate-600">ประจำเดือน {yearMonth}</p>
        </header>

        {paidAt === null ? (
          // A draft slip printed and handed over would be a promise the shop
          // has not made. Saying so on the paper is cheaper than remembering.
          <p className="mt-4 rounded-xl bg-amber-100 p-3 text-center font-semibold text-amber-900">
            ยังไม่ได้จ่าย — ตัวเลขนี้ยังเปลี่ยนได้
          </p>
        ) : null}

        <dl className="mt-4 space-y-1">
          <SlipRow label="ชื่อ" value={line.fullName} />
          {line.position ? <SlipRow label="ตำแหน่ง" value={line.position} /> : null}
          <SlipRow
            label="ค่าแรง"
            value={`${formatSatang(line.wageRateSnapshot)} ${
              line.wageTypeSnapshot === 'DAILY' ? 'ต่อวัน' : 'ต่อเดือน'
            } (${WAGE_TYPE_LABEL[line.wageTypeSnapshot]})`}
          />
          <SlipRow label="จำนวนวันทำงาน" value={`${line.daysWorked} วัน`} />
        </dl>

        <div className="mt-5 border-t border-slate-300 pt-4">
          <MoneyRow label="ค่าแรงรวม" satang={line.grossSatang} />
          {line.bonusSatang > 0 ? (
            <MoneyRow label="โบนัส / เบี้ยขยัน" satang={line.bonusSatang} />
          ) : null}

          {line.deductions.length > 0 ? (
            <div className="mt-2">
              <p className="font-semibold">รายการหัก</p>
              <ul className="mt-1 space-y-0.5">
                {line.deductions.map((row, index) => (
                  <li key={`${row.date}-${index}`} className="flex justify-between text-slate-700">
                    <span>
                      <span className="tnum">{row.date}</span> {deductionTypeLabel(row.type)}
                      {row.note ? ` — ${row.note}` : ''}
                    </span>
                    <span className="tnum">-{formatSatang(row.amountSatang)}</span>
                  </li>
                ))}
              </ul>
              <MoneyRow label="รวมหัก" satang={-line.deductSatang} />
            </div>
          ) : null}

          <div className="mt-3 flex justify-between border-t-2 border-slate-800 pt-3 text-xl font-bold">
            <span>ยอดรับสุทธิ</span>
            <span className="tnum">{formatSatang(line.netSatang)}</span>
          </div>
        </div>

        {line.note ? <p className="mt-4 text-slate-600">หมายเหตุ: {line.note}</p> : null}

        <div className="mt-10 grid grid-cols-2 gap-8 text-center text-sm text-slate-600">
          <div className="border-t border-slate-400 pt-2">ผู้จ่ายเงิน</div>
          <div className="border-t border-slate-400 pt-2">ผู้รับเงิน</div>
        </div>

        <div className="mt-6 flex justify-end gap-3 print:hidden">
          <button
            type="button"
            onClick={() => globalThis.print()}
            className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500"
          >
            พิมพ์
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}

function SlipRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MoneyRow({ label, satang }: { label: string; satang: number }): React.ReactElement {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-slate-700">{label}</span>
      <span className="tnum">{formatSatang(satang)}</span>
    </div>
  );
}

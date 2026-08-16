/**
 * บิลที่ปิดแล้ว (Step 10).
 *
 * This screen exists for one sentence a customer says a minute after paying:
 * "ขอใบกำกับภาษีด้วยครับ". Until Step 10 a paid bill was unreachable — the
 * table had been cleared and the order screen only knows OPEN bills — so there
 * was nowhere to issue a tax invoice from once the customer had walked away
 * from the till.
 *
 * A bill that was reversed stays on the list, greyed, with its credit note
 * number. Removing it would look exactly like a bill somebody deleted, and
 * "where did that bill go" is the question this whole step exists to never
 * have to answer with a shrug.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  formatSatang,
  OrderStatus,
  Permission,
  type CreditNoteDto,
  type PaidBillListResponse,
  type PaidBillRow,
  type TaxInvoiceDto,
} from '@pos/shared';
import { api } from '../../api-client.js';
import { CreditNoteDialog } from '../../components/CreditNoteDialog.js';
import { useBusinessToday } from '../../business-day.js';
import { TaxInvoiceDialog } from '../../components/TaxInvoiceDialog.js';
import { useSession } from '../../session-store.js';
import { path } from '@pos/web-kit';

export function PaidBillsPage(): React.ReactElement {
  const navigate = useNavigate();
  const today = useBusinessToday();
  const canIssue = useSession((state) => state.can(Permission.ISSUE_TAX_INVOICE));

  const [date, setDate] = useState(today);
  const [data, setData] = useState<PaidBillListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [taxInvoiceFor, setTaxInvoiceFor] = useState<PaidBillRow | null>(null);
  const [creditNoteFor, setCreditNoteFor] = useState<PaidBillRow | null>(null);

  const load = useCallback(async (on: string) => {
    setLoading(true);
    const result = await api.paidBills(on);
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

  const afterTaxInvoice = async (invoice: TaxInvoiceDto): Promise<void> => {
    setTaxInvoiceFor(null);
    setNotice(`ออกใบกำกับภาษีเลขที่ ${invoice.taxInvoiceNo} แล้ว — กำลังพิมพ์`);
    await load(date);
  };

  const afterCreditNote = async (creditNote: CreditNoteDto): Promise<void> => {
    setCreditNoteFor(null);
    setNotice(`ออกใบลดหนี้เลขที่ ${creditNote.creditNoteNo} แล้ว — บิลนี้ถูกยกเลิก`);
    await load(date);
  };

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">บิลที่ปิดแล้ว</h1>
            <p className="text-sm text-slate-500">
              {data?.vatActive
                ? 'ร้านคิด VAT อยู่ — ออกใบกำกับภาษีเต็มรูปให้ลูกค้าได้'
                : 'ร้านยังไม่ได้คิด VAT — ออกได้แต่ใบลดหนี้'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="date"
              aria-label="วันที่"
              className="input w-44"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
            <button
              type="button"
              onClick={() => navigate(path.tables)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              ← กลับไปหน้าโต๊ะ
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mx-6 mt-4 rounded-xl bg-red-50 p-4 text-red-900">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mx-6 mt-4 rounded-xl bg-emerald-50 p-4 text-emerald-900">{notice}</p>
      ) : null}

      <main className="p-6">
        {loading ? <p className="mb-4 text-slate-400">กำลังโหลด…</p> : null}

        {data && data.rows.length === 0 ? (
          <p className="rounded-2xl bg-white p-6 text-slate-500">วันนี้ยังไม่มีบิลที่ปิดแล้ว</p>
        ) : null}

        <div className="flex flex-col gap-3">
          {(data?.rows ?? []).map((row) => {
            const cancelled = row.status === OrderStatus.CANCELLED;
            return (
              <section
                key={row.id}
                className={`rounded-2xl p-4 ${cancelled ? 'bg-slate-100' : 'bg-white'}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold">
                      {row.receiptNo ?? 'ไม่มีเลขใบเสร็จ'}
                      <span className="ml-3 text-slate-500">
                        บิล {row.orderNo ?? '—'} · {row.tableName ?? row.channel}
                      </span>
                    </p>
                    <p className="text-sm text-slate-500">
                      {row.paidAt ? new Date(row.paidAt).toLocaleTimeString('th-TH') : '—'} ·{' '}
                      {row.itemCount} รายการ
                      {row.vatAmountSatang > 0 ? ` · VAT ${formatSatang(row.vatAmountSatang)}` : ''}
                    </p>
                  </div>
                  <p
                    className={`tnum text-2xl font-bold ${
                      cancelled ? 'text-slate-400 line-through' : ''
                    }`}
                  >
                    {formatSatang(row.totalSatang)}
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {row.taxInvoiceNo ? (
                    <span className="rounded-lg bg-brand-50 px-3 py-1 text-brand-800">
                      ใบกำกับภาษี {row.taxInvoiceNo}
                      {row.customerName ? ` · ${row.customerName}` : ''}
                    </span>
                  ) : null}
                  {row.creditNoteNo ? (
                    <span className="rounded-lg bg-red-50 px-3 py-1 text-red-800">
                      ยกเลิกแล้ว · ใบลดหนี้ {row.creditNoteNo}
                    </span>
                  ) : null}

                  {canIssue && !cancelled ? (
                    <>
                      {!row.taxInvoiceNo && row.vatRateBpSnapshot > 0 ? (
                        <button
                          type="button"
                          onClick={() => setTaxInvoiceFor(row)}
                          className="btn h-12 bg-brand-600 px-5 text-white hover:bg-brand-700"
                        >
                          ออกใบกำกับภาษี
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setCreditNoteFor(row)}
                        className="btn h-12 bg-slate-100 px-5 text-slate-700 hover:bg-slate-200"
                      >
                        ออกใบลดหนี้
                      </button>
                    </>
                  ) : null}

                  {!row.taxInvoiceNo && row.vatRateBpSnapshot === 0 && !cancelled ? (
                    <span className="text-sm text-slate-400">
                      บิลนี้ปิดตอนยังไม่คิด VAT — ออกใบกำกับภาษีเต็มรูปไม่ได้
                    </span>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {taxInvoiceFor ? (
        <TaxInvoiceDialog
          bill={taxInvoiceFor}
          onClose={() => setTaxInvoiceFor(null)}
          onIssued={(invoice) => void afterTaxInvoice(invoice)}
        />
      ) : null}
      {creditNoteFor ? (
        <CreditNoteDialog
          bill={creditNoteFor}
          onClose={() => setCreditNoteFor(null)}
          onIssued={(creditNote) => void afterCreditNote(creditNote)}
        />
      ) : null}
    </div>
  );
}

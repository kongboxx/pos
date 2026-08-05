/**
 * ขอใบกำกับภาษีเต็มรูป (Step 10).
 *
 * Opened when a customer says "ขอใบกำกับภาษีด้วยครับ" a minute after paying,
 * so it is typed at the counter with somebody waiting — which drives two
 * decisions:
 *
 *  - THE TAX ID IS CHECKED HERE, before the request leaves. The check digit
 *    catches a one-digit typo while the customer is still standing there. Found
 *    tomorrow instead, the fix is a credit note plus a reissue.
 *  - สาขา DEFAULTS TO สำนักงานใหญ่. It is required on the document and means
 *    nothing to most people who have to type it, which is exactly the field
 *    that gets filled with anything if it is asked for cold.
 *
 * ONLINE ONLY. The number comes from the server's DocSequence (rule #9); an
 * offline device that issued one would hand the same number to two customers.
 */

import { useState } from 'react';
import {
  formatSatang,
  HEAD_OFFICE_LABEL,
  isValidThaiTaxId,
  normalizeTaxId,
  type PaidBillRow,
  type TaxInvoiceDto,
} from '@pos/shared';
import { api } from '../api-client.js';

interface TaxInvoiceDialogProps {
  bill: PaidBillRow;
  onClose: () => void;
  onIssued: (invoice: TaxInvoiceDto) => void;
}

export function TaxInvoiceDialog({
  bill,
  onClose,
  onIssued,
}: TaxInvoiceDialogProps): React.ReactElement {
  const [customerName, setCustomerName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [address, setAddress] = useState('');
  const [branchLabel, setBranchLabel] = useState(HEAD_OFFICE_LABEL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const digits = normalizeTaxId(taxId);
  const taxIdOk = isValidThaiTaxId(digits);
  const ready = customerName.trim().length > 0 && taxIdOk;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await api.issueTaxInvoice(bill.id, {
      customerName: customerName.trim(),
      customerTaxId: digits,
      customerAddress: address.trim() || null,
      customerBranchLabel: branchLabel.trim() || HEAD_OFFICE_LABEL,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onIssued(result.data.taxInvoice);
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="ออกใบกำกับภาษี"
        className="flex max-h-full w-full max-w-xl flex-col overflow-y-auto rounded-3xl bg-white p-6"
      >
        <header>
          <h2 className="text-2xl font-bold">ออกใบกำกับภาษีเต็มรูป</h2>
          <p className="mt-1 text-slate-600">
            บิล {bill.orderNo ?? '—'} · {bill.receiptNo ?? 'ไม่มีเลขใบเสร็จ'} ·{' '}
            <span className="tnum">{formatSatang(bill.totalSatang)}</span> บาท
          </p>
          <p className="mt-2 rounded-xl bg-amber-50 p-3 text-amber-900">
            ออกได้ครั้งเดียว — ถ้าพิมพ์ผิดต้องออกใบลดหนี้แล้วออกใบใหม่
          </p>
        </header>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {error}
          </p>
        ) : null}

        <div className="mt-5 grid gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">ชื่อผู้ซื้อ</span>
            <input
              className="input"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">เลขประจำตัวผู้เสียภาษี</span>
            <input
              className="input tnum"
              inputMode="numeric"
              value={taxId}
              onChange={(event) => setTaxId(event.target.value)}
            />
            {digits.length > 0 && !taxIdOk ? (
              <span className="text-sm text-red-700">
                เลขไม่ถูกต้อง — ตรวจอีกครั้งกับลูกค้า (ต้องเป็นตัวเลข 13 หลัก)
              </span>
            ) : (
              <span className="text-sm text-slate-400">13 หลัก มีขีดหรือไม่มีก็ได้</span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">สาขาของผู้ซื้อ</span>
            <input
              className="input"
              value={branchLabel}
              onChange={(event) => setBranchLabel(event.target.value)}
            />
            <span className="text-sm text-slate-400">
              บริษัทส่วนใหญ่ใช้ &quot;สำนักงานใหญ่&quot; ถ้าลูกค้าบอกเลขสาขาให้พิมพ์ตามนั้น
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">ที่อยู่ผู้ซื้อ</span>
            <textarea
              rows={2}
              className="w-full rounded-xl border border-slate-300 p-3 text-lg"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
        </div>

        <footer className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn h-14 flex-1 bg-slate-100 text-lg text-slate-700 hover:bg-slate-200"
          >
            ปิด
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ready || busy}
            className="btn h-14 flex-1 bg-brand-600 text-lg text-white hover:bg-brand-500
              disabled:opacity-40"
          >
            ออกใบกำกับภาษี
          </button>
        </footer>
      </div>
    </div>
  );
}

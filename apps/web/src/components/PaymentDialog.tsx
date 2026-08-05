/**
 * Taking the money.
 *
 * Cash and PromptPay, because those are what a noodle shop actually receives.
 *
 * Two deliberate choices:
 *
 *  - The cash keypad enters WHOLE BAHT. Nobody hands over 61.50 in a shop with
 *    no 25-satang coins, and an entry box that can produce fractional satang is
 *    a rounding bug waiting for a busy night. The quick buttons cover the
 *    common notes, and "พอดี" covers the exact-change case in one tap.
 *
 *  - The PromptPay QR is fetched from the SERVER, per bill. The shop's
 *    PromptPay id is never sent to the tablet, and the amount is locked to the
 *    stored total, so the QR on screen cannot ask for a number the till made up.
 *
 * The slip is NOT verified automatically. Staff look at the customer's phone
 * and confirm. Real verification needs a bank API and is not in this system.
 */

import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  calculateChange,
  formatSatang,
  PaymentMethod,
  SATANG_PER_BAHT,
  WIDTH_80MM,
  type OrderDto,
  type PayOrderResponse,
} from '@pos/shared';
import { api } from '../api-client.js';
import { putOrder } from '../offline/db.js';
import { Keypad } from './Keypad.js';

/** Notes a Thai customer actually hands over. */
const QUICK_NOTES = [10000, 50000, 100000];

interface PaymentDialogProps {
  order: OrderDto;
  onClose: () => void;
  onPaid: () => void;
}

export function PaymentDialog({ order, onClose, onPaid }: PaymentDialogProps): React.ReactElement {
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [bahtInput, setBahtInput] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PayOrderResponse | null>(null);

  const receivedSatang = bahtInput === '' ? null : Number(bahtInput) * SATANG_PER_BAHT;
  const change =
    receivedSatang === null ? null : calculateChange(order.totalSatang, receivedSatang);

  useEffect(() => {
    if (method !== PaymentMethod.PROMPTPAY || qr) return;
    let cancelled = false;
    void (async () => {
      const result = await api.promptPayQr(order.id);
      if (cancelled) return;
      if (result.ok) setQr(result.data.payload);
      else setQrError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [method, order.id, qr]);

  const confirm = useCallback(async () => {
    setBusy(true);
    const result = await api.pay(order.id, {
      method,
      receivedSatang: method === PaymentMethod.CASH ? receivedSatang : null,
      referenceNo: referenceNo.trim() === '' ? null : referenceNo.trim(),
      width: WIDTH_80MM,
    });
    setBusy(false);
    if (result.ok) {
      // The device's copy has to learn that this bill is closed, or the floor
      // plan would keep the table amber and the next customer could not be
      // seated until a refresh happened to land.
      await putOrder(result.data.order, false);
      setDone(result.data);
    } else setError(result.error);
  }, [order.id, method, receivedSatang, referenceNo]);

  if (done) {
    return (
      <Overlay>
        <h2 className="text-center text-2xl font-bold text-emerald-700">รับเงินเรียบร้อย</h2>
        <p className="mt-1 text-center text-slate-500">เลขที่ {done.receiptNo}</p>

        {method === PaymentMethod.CASH ? (
          <div className="mt-6 rounded-2xl bg-emerald-50 p-6 text-center">
            <p className="text-lg text-emerald-900">เงินทอน</p>
            <p className="tnum text-5xl font-bold text-emerald-900">
              {formatSatang(done.changeSatang)}
            </p>
          </div>
        ) : null}

        <p className="mt-4 text-center text-sm text-slate-500">
          {done.printJobId
            ? 'ส่งใบเสร็จเข้าคิวพิมพ์แล้ว'
            : 'บันทึกการชำระเงินแล้ว แต่ส่งงานพิมพ์ไม่สำเร็จ — ตรวจเครื่องพิมพ์'}
        </p>

        <button
          type="button"
          onClick={onPaid}
          className="btn mt-6 h-16 w-full bg-brand-600 text-lg text-white hover:bg-brand-500"
        >
          กลับไปผังโต๊ะ
        </button>
      </Overlay>
    );
  }

  const canConfirm =
    !busy && (method === PaymentMethod.PROMPTPAY || (receivedSatang !== null && change !== null));

  return (
    <Overlay>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-slate-500">ยอดที่ต้องชำระ</p>
          <p className="tnum text-4xl font-bold">{formatSatang(order.totalSatang)}</p>
        </div>
        <button type="button" onClick={onClose} className="btn h-11 bg-slate-100 px-4">
          ปิด
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <MethodButton
          active={method === PaymentMethod.CASH}
          onSelect={() => setMethod(PaymentMethod.CASH)}
          label="เงินสด"
        />
        <MethodButton
          active={method === PaymentMethod.PROMPTPAY}
          onSelect={() => setMethod(PaymentMethod.PROMPTPAY)}
          label="พร้อมเพย์"
        />
      </div>

      {method === PaymentMethod.CASH ? (
        <div className="mt-5">
          <div className="flex items-center justify-between rounded-2xl bg-slate-100 px-4 py-3">
            <span className="text-slate-600">รับเงินมา</span>
            <span className="tnum text-2xl font-semibold">
              {receivedSatang === null ? '—' : formatSatang(receivedSatang)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => setBahtInput(String(order.totalSatang / SATANG_PER_BAHT))}
              className="btn h-12 bg-brand-50 text-brand-900"
            >
              พอดี
            </button>
            {QUICK_NOTES.filter((note) => note >= order.totalSatang).map((note) => (
              <button
                key={note}
                type="button"
                onClick={() => setBahtInput(String(note / SATANG_PER_BAHT))}
                className="btn tnum h-12 bg-slate-100"
              >
                {note / SATANG_PER_BAHT}
              </button>
            ))}
          </div>

          <div className="mt-3">
            <Keypad
              onDigit={(digit) =>
                setBahtInput((current) =>
                  // Leading zeros would make "05" read as five hundred satang
                  // once multiplied; drop them at the source.
                  current === '' && digit === '0' ? '' : (current + digit).slice(0, 7),
                )
              }
              onBackspace={() => setBahtInput((current) => current.slice(0, -1))}
              onClear={() => setBahtInput('')}
              disabled={busy}
            />
          </div>

          <div className="mt-4 flex items-center justify-between rounded-2xl bg-emerald-50 px-4 py-3">
            <span className="text-emerald-900">เงินทอน</span>
            <span className="tnum text-3xl font-bold text-emerald-900">
              {change === null ? '—' : formatSatang(change)}
            </span>
          </div>
          {receivedSatang !== null && change === null ? (
            <p className="mt-2 text-center text-sm text-red-700">เงินที่รับมายังไม่พอ</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-5">
          {qrError ? (
            <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{qrError}</p>
          ) : qr ? (
            <div className="flex flex-col items-center">
              <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                <QRCodeSVG value={qr} size={220} level="M" />
              </div>
              <p className="mt-2 text-sm text-slate-500">
                ให้ลูกค้าสแกน — ยอดถูกล็อกไว้ที่ {formatSatang(order.totalSatang)} บาท
              </p>
            </div>
          ) : (
            <p className="text-center text-slate-400">กำลังสร้าง QR…</p>
          )}

          <label className="mt-4 block">
            <span className="text-sm text-slate-600">เลขอ้างอิงจากสลิป (ถ้ามี)</span>
            <input
              value={referenceNo}
              onChange={(event) => setReferenceNo(event.target.value)}
              className="tnum mt-1 h-12 w-full rounded-xl border border-slate-300 px-3"
              inputMode="numeric"
            />
          </label>
          <p className="mt-2 text-sm text-amber-800">
            ระบบยังไม่ตรวจสลิปอัตโนมัติ — พนักงานต้องดูหน้าจอลูกค้าก่อนกดยืนยัน
          </p>
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void confirm()}
        disabled={!canConfirm}
        className="btn mt-5 h-16 w-full bg-emerald-600 text-xl text-white hover:bg-emerald-500
          disabled:opacity-40"
      >
        {busy ? 'กำลังบันทึก…' : 'ยืนยันรับเงิน'}
      </button>
    </Overlay>
  );
}

function MethodButton({
  active,
  onSelect,
  label,
}: {
  active: boolean;
  onSelect: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`btn h-14 text-lg ${
        active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700'
      }`}
    >
      {label}
    </button>
  );
}

function Overlay({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

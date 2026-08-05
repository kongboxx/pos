/**
 * ออกใบลดหนี้ — undoing a sale that has already been paid for (Step 10).
 *
 * Same two screens as VoidDialog and in the same order — WHY first, WHO second
 * — because this is the same kind of event, one size up: a void takes one line
 * off a bill, this takes the whole bill back out of the day's takings and
 * cancels a tax document with it (rule #8).
 *
 * The PIN authorises exactly this one reversal and does NOT sign the approver
 * in. A tablet left holding a manager's session after they walk away is the
 * hole the approval was supposed to close.
 *
 * ONLINE ONLY: the PIN is bcrypt-checked on the server against a hash this
 * device has never seen, and the credit note number comes from DocSequence.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  canApproveVoid,
  CREDIT_NOTE_REASONS,
  CreditNoteReason,
  formatSatang,
  type CreditNoteDto,
  type PaidBillRow,
  type StaffPublic,
} from '@pos/shared';
import { api } from '../api-client.js';
import { Keypad } from './Keypad.js';

const PIN_LENGTH = 4;

interface CreditNoteDialogProps {
  bill: PaidBillRow;
  onClose: () => void;
  onIssued: (creditNote: CreditNoteDto) => void;
}

export function CreditNoteDialog({
  bill,
  onClose,
  onIssued,
}: CreditNoteDialogProps): React.ReactElement {
  const [step, setStep] = useState<'reason' | 'approve'>('reason');
  const [reason, setReason] = useState<CreditNoteReason | null>(null);
  const [note, setNote] = useState('');
  const [approvers, setApprovers] = useState<StaffPublic[] | null>(null);
  const [approver, setApprover] = useState<StaffPublic | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.staffList();
      if (cancelled) return;
      if (result.ok)
        setApprovers(result.data.staff.filter((person) => canApproveVoid(person.role)));
      else setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const noteRequired = reason === CreditNoteReason.OTHER;
  const reasonReady = reason !== null && (!noteRequired || note.trim().length > 0);

  const submit = useCallback(
    async (candidate: string) => {
      if (!reason || !approver) return;
      setBusy(true);
      setError(null);
      const result = await api.issueCreditNote(bill.id, {
        reason,
        note: note.trim() || null,
        approverStaffId: approver.id,
        approverPin: candidate,
      });
      setBusy(false);
      // Always cleared: a PIN left on screen is the next person's hint.
      setPin('');

      if (!result.ok) {
        setError(result.error);
        return;
      }
      onIssued(result.data.creditNote);
    },
    [reason, approver, note, bill.id, onIssued],
  );

  /**
   * Submitting from OUTSIDE the setPin updater, deliberately — a state updater
   * must be pure and React may call it twice, which sent two requests for one
   * entry and burned two of the five attempts before the lockout. Same bug,
   * same fix as VoidDialog and LoginPage.
   */
  const pressDigit = useCallback(
    (digit: string) => {
      if (!approver || busy || pin.length >= PIN_LENGTH) return;
      const next = pin + digit;
      setPin(next);
      if (next.length === PIN_LENGTH) void submit(next);
    },
    [approver, busy, pin, submit],
  );

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="ออกใบลดหนี้"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-3xl bg-white p-6"
      >
        <header>
          <h2 className="text-2xl font-bold">ออกใบลดหนี้ (ยกเลิกบิลที่รับเงินแล้ว)</h2>
          <p className="mt-1 text-lg">
            บิล {bill.orderNo ?? '—'} · {bill.receiptNo ?? 'ไม่มีเลขใบเสร็จ'} ·{' '}
            <span className="tnum font-semibold">{formatSatang(bill.totalSatang)}</span> บาท
          </p>
          <p className="mt-2 rounded-xl bg-amber-50 p-3 text-amber-900">
            {bill.taxInvoiceNo
              ? `บิลนี้ออกใบกำกับภาษี ${bill.taxInvoiceNo} ไปแล้ว — ลบไม่ได้ ต้องออกใบลดหนี้เท่านั้น`
              : 'ยอดนี้จะถูกหักออกจากยอดขายของวันที่ขาย ไม่ใช่วันนี้'}
          </p>
        </header>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {error}
          </p>
        ) : null}

        {step === 'reason' ? (
          <section aria-label="เหตุผล" className="mt-5">
            <h3 className="mb-2 font-semibold">เพราะอะไร</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CREDIT_NOTE_REASONS.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  onClick={() => setReason(candidate.key)}
                  aria-pressed={reason === candidate.key}
                  className={`btn h-auto flex-col items-start gap-0.5 px-4 py-3 text-left ${
                    reason === candidate.key
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                  }`}
                >
                  <span className="text-lg font-semibold">{candidate.label}</span>
                  <span className={reason === candidate.key ? 'text-sm' : 'text-sm text-slate-500'}>
                    {candidate.hint}
                  </span>
                </button>
              ))}
            </div>

            <label className="mt-4 block">
              <span className="text-sm text-slate-600">
                หมายเหตุ{noteRequired ? ' (จำเป็นเมื่อเลือกอื่น ๆ)' : ''}
              </span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={200}
                className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-lg"
              />
            </label>
          </section>
        ) : (
          <section aria-label="ผู้อนุมัติ" className="mt-5">
            <h3 className="mb-2 font-semibold">ผู้จัดการหรือเจ้าของกด PIN</h3>
            {approvers === null ? (
              <p className="text-slate-400">กำลังโหลด…</p>
            ) : approvers.length === 0 ? (
              <p className="rounded-xl bg-amber-50 p-3 text-amber-900">
                สาขานี้ยังไม่มีผู้จัดการหรือเจ้าของในระบบ — ออกใบลดหนี้ไม่ได้
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {approvers.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => {
                      setApprover(person);
                      setPin('');
                      setError(null);
                    }}
                    aria-pressed={approver?.id === person.id}
                    className={`btn h-16 text-lg ${
                      approver?.id === person.id
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                    }`}
                  >
                    {person.nickname ?? person.fullName}
                  </button>
                ))}
              </div>
            )}

            {approver ? (
              <div className="mt-5">
                <div className="flex justify-center gap-4">
                  {Array.from({ length: PIN_LENGTH }, (_, index) => (
                    <span
                      key={index}
                      data-testid="approver-pin-dot"
                      data-filled={index < pin.length}
                      className={`h-5 w-5 rounded-full ${
                        index < pin.length ? 'bg-brand-600' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
                <div className="mt-4">
                  <Keypad
                    onDigit={pressDigit}
                    onBackspace={() => setPin((current) => current.slice(0, -1))}
                    onClear={() => setPin('')}
                    disabled={busy}
                  />
                </div>
              </div>
            ) : null}
          </section>
        )}

        <footer className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={step === 'reason' ? onClose : () => setStep('reason')}
            className="btn h-14 flex-1 bg-slate-100 text-lg text-slate-700 hover:bg-slate-200"
          >
            {step === 'reason' ? 'ปิด' : '← เปลี่ยนเหตุผล'}
          </button>
          {step === 'reason' ? (
            <button
              type="button"
              onClick={() => setStep('approve')}
              disabled={!reasonReady}
              className="btn h-14 flex-1 bg-brand-600 text-lg text-white hover:bg-brand-500
                disabled:opacity-40"
            >
              ถัดไป
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

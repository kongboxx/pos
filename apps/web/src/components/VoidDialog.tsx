/**
 * Cancelling a line that the kitchen already has.
 *
 * Two screens, in this order, and the order matters: WHY first, WHO second.
 * Asked the other way round the manager types their PIN and then everyone
 * argues about the reason with a keypad open — and the reason is the part the
 * owner reads at the end of the month.
 *
 * The PIN is the manager's own, typed here, and it authorises exactly this one
 * void. It does not sign them in (see approval.service.ts): a tablet left
 * holding a manager's session after they walk away is the hole this was
 * supposed to close.
 *
 * ONLINE ONLY. The PIN is checked by bcrypt on the server against a hash this
 * device has never seen and must never see, so there is no offline version of
 * this dialog that means anything.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  canApproveVoid,
  formatModifierSummary,
  formatSatang,
  VOID_REASONS,
  type OrderDto,
  type OrderLineDto,
  type StaffPublic,
  type VoidReason,
} from '@pos/shared';
import { api } from '../api-client.js';
import { putOrder } from '../offline/db.js';
import { Keypad } from './Keypad.js';

const PIN_LENGTH = 4;
const REASON_NEEDING_NOTE: VoidReason = 'อื่นๆ';

interface VoidDialogProps {
  order: OrderDto;
  line: OrderLineDto;
  onClose: () => void;
  onVoided: () => void;
}

export function VoidDialog({
  order,
  line,
  onClose,
  onVoided,
}: VoidDialogProps): React.ReactElement {
  const [step, setStep] = useState<'reason' | 'approve'>('reason');
  const [reason, setReason] = useState<VoidReason | null>(null);
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

  const noteRequired = reason === REASON_NEEDING_NOTE;
  const reasonReady = reason !== null && (!noteRequired || note.trim().length > 0);

  const summary = useMemo(
    () => formatModifierSummary(line.modifiers.map((modifier) => modifier.nameSnapshot)),
    [line.modifiers],
  );

  const submit = useCallback(
    async (candidate: string) => {
      if (!reason || !approver) return;
      setBusy(true);
      setError(null);
      const result = await api.voidLine(order.id, line.id, {
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
      // The server's version of the bill is now the truth, and it is synced —
      // writing it to the device keeps the till and the mirror in step without
      // a round trip through the sync queue.
      await putOrder(result.data.order, false);
      onVoided();
    },
    [reason, approver, note, order.id, line.id, onVoided],
  );

  /**
   * Two things here were wrong the first time and both cost real money.
   *
   * 1. `submit` used to be called from INSIDE the setPin updater. A state
   *    updater must be pure — React calls it more than once — so one four-digit
   *    entry fired TWO void requests, and a wrong PIN therefore burned two of
   *    the five attempts. A manager was locked out after three tries.
   *
   * 2. The error used to be cleared on the first digit. That removes the banner
   *    mid-entry, the keypad jumps up by the height of a line of text, and the
   *    next tap lands on the wrong number. The message now survives until there
   *    is a new answer, so nothing moves under a finger.
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
        aria-label="ยกเลิกรายการ"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-3xl bg-white p-6"
      >
        <header>
          <h2 className="text-2xl font-bold">ยกเลิกรายการ</h2>
          <p className="mt-1 text-lg">
            <span className="tnum font-semibold">{line.qty}×</span> {line.nameSnapshot}
            <span className="tnum ml-2 text-slate-500">{formatSatang(line.lineTotalSatang)}</span>
          </p>
          {summary ? <p className="text-slate-500">{summary}</p> : null}
          {line.firedAt ? (
            // Not a warning to be dismissed — it is the reason a manager is
            // being fetched at all, and the cook needs telling either way.
            <p className="mt-2 rounded-xl bg-amber-50 p-3 text-amber-900">
              รายการนี้ส่งครัวไปแล้ว — ถ้ายกเลิก ครัวจะเห็นทันทีว่าให้หยุดทำ
            </p>
          ) : null}
        </header>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {error}
          </p>
        ) : null}

        {step === 'reason' ? (
          <section aria-label="เหตุผล" className="mt-5">
            <h3 className="mb-2 font-semibold">เพราะอะไร</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {VOID_REASONS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setReason(candidate)}
                  aria-pressed={reason === candidate}
                  className={`btn h-16 text-lg ${
                    reason === candidate
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                  }`}
                >
                  {candidate}
                </button>
              ))}
            </div>

            {noteRequired ? (
              <label className="mt-4 block">
                <span className="text-sm text-slate-600">เขียนเหตุผล</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  maxLength={200}
                  className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-lg"
                />
              </label>
            ) : null}
          </section>
        ) : (
          <section aria-label="ผู้อนุมัติ" className="mt-5">
            <h3 className="mb-2 font-semibold">ผู้จัดการหรือเจ้าของกด PIN</h3>
            {approvers === null ? (
              <p className="text-slate-400">กำลังโหลด…</p>
            ) : approvers.length === 0 ? (
              <p className="rounded-xl bg-amber-50 p-3 text-amber-900">
                สาขานี้ยังไม่มีผู้จัดการหรือเจ้าของในระบบ — ยกเลิกรายการไม่ได้
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

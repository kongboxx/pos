/**
 * Giving money away.
 *
 * Built as a sibling of VoidDialog rather than a variation on it, because the
 * two do different damage and are worth reading separately — but the shape is
 * deliberately identical: HOW MUCH and WHY first, WHO second. A manager who has
 * typed their PIN and is then asked to argue about the amount has already
 * signed for a number nobody has agreed on.
 *
 * TWO WAYS TO SAY IT, one stored. A cashier who was told "ลดให้ยี่สิบ" types 20
 * baht; one told "ลดสิบเปอร์เซ็นต์" types 10 percent. Both end up as satang on
 * the bill — see discount.ts for why the percentage is not what gets stored —
 * and the screen shows the resulting figure BEFORE the PIN is asked for, so the
 * person signing sees the number they are signing.
 *
 * NO FREE-TYPED AMOUNT ABOVE THE BILL. The button that submits is disabled and
 * the reason is on screen, rather than letting it through to a red box from the
 * server: a supervisor standing at a till with a customer waiting should find
 * out at the moment of typing, not after a round trip.
 *
 * ONLINE ONLY, same as VoidDialog: the PIN is checked by bcrypt against a hash
 * this device has never seen and must never see.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  can,
  DISCOUNT_REASONS,
  formatSatang,
  MAX_DISCOUNT_PERCENT_BP,
  parseBahtToSatang,
  Permission,
  type DiscountMode,
  type DiscountReason,
  type OrderDto,
  type StaffPublic,
} from '@pos/shared';
import { api } from '../api-client.js';
import { putOrder } from '../offline/db.js';
import { Keypad } from './Keypad.js';

const PIN_LENGTH = 4;
const REASON_NEEDING_NOTE: DiscountReason = 'อื่นๆ';

/**
 * The percentages worth a button.
 *
 * Unlike the "เผ็ดน้อย" chips that ModifierSheet deliberately does not have,
 * these are not a second menu hiding in free text — they are the same field,
 * pre-filled. Anything else is still typeable.
 */
const QUICK_PERCENTS = [5, 10, 15, 20] as const;

interface DiscountDialogProps {
  order: OrderDto;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function DiscountDialog({
  order,
  onClose,
  onDone,
}: DiscountDialogProps): React.ReactElement {
  const [step, setStep] = useState<'amount' | 'approve'>('amount');
  const [mode, setMode] = useState<DiscountMode>('AMOUNT');
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState<DiscountReason | null>(null);
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
      if (result.ok) {
        setApprovers(
          result.data.staff.filter((person) => can(person.role, Permission.APPROVE_DISCOUNT)),
        );
      } else setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * What the bill was worth before any discount.
   *
   * `totalSatang` already has the current discount taken off it, so basing a
   * new percentage on that would make a second 10% mean 10% of the discounted
   * figure — a smaller discount than the same words meant a minute earlier.
   */
  const grossSatang = order.totalSatang + order.discountSatang;

  /** null while the box is empty or holds something that is not a number. */
  const requested = useMemo((): number | null => {
    if (typed.trim() === '') return null;
    if (mode === 'AMOUNT') return parseBahtToSatang(typed);
    const percent = Number(typed.trim());
    if (!Number.isFinite(percent) || percent <= 0) return null;
    const bp = Math.round(percent * 100);
    if (bp > MAX_DISCOUNT_PERCENT_BP) return null;
    return Math.round((grossSatang * bp) / 10_000);
  }, [typed, mode, grossSatang]);

  const tooLarge = requested !== null && requested > grossSatang;
  const noteRequired = reason === REASON_NEEDING_NOTE;
  const ready =
    requested !== null &&
    requested > 0 &&
    !tooLarge &&
    reason !== null &&
    (!noteRequired || note.trim().length > 0);

  const submit = useCallback(
    async (candidate: string) => {
      if (!reason || !approver || requested === null) return;
      setBusy(true);
      setError(null);
      const result = await api.setDiscount(order.id, {
        mode,
        // Satang for AMOUNT, basis points for PERCENT — the server resolves the
        // percentage against its own copy of the bill, not against ours.
        value: mode === 'AMOUNT' ? requested : Math.round(Number(typed.trim()) * 100),
        reason,
        note: note.trim() || null,
        approverStaffId: approver.id,
        approverPin: candidate,
      });
      setBusy(false);
      setPin('');

      if (!result.ok) {
        setError(result.error);
        return;
      }
      await putOrder(result.data.order, false);
      onDone(`ลดราคาแล้ว ${formatSatang(result.data.order.discountSatang)} บาท`);
    },
    [reason, approver, requested, mode, typed, note, order.id, onDone],
  );

  // Same two lessons as VoidDialog: submit outside the state updater so one
  // entry sends one request, and the error survives until there is a new
  // answer so the keypad does not jump under a finger mid-entry.
  const pressDigit = useCallback(
    (digit: string) => {
      if (!approver || busy || pin.length >= PIN_LENGTH) return;
      const next = pin + digit;
      setPin(next);
      if (next.length === PIN_LENGTH) void submit(next);
    },
    [approver, busy, pin, submit],
  );

  const switchMode = (next: DiscountMode) => {
    setMode(next);
    // Cleared, not converted: "20" means twenty baht in one mode and twenty
    // percent in the other, and carrying it across is how ฿20 off becomes ฿47.
    setTyped('');
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="ลดราคา"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-3xl bg-white p-6"
      >
        <header>
          <h2 className="text-2xl font-bold">ลดราคาทั้งบิล</h2>
          <p className="mt-1 text-lg">
            ยอดบิล <span className="tnum font-semibold">{formatSatang(grossSatang)}</span> บาท
            {order.discountSatang > 0 ? (
              <span className="ml-2 text-slate-500">
                (ตอนนี้ลดอยู่ {formatSatang(order.discountSatang)} — ใส่ใหม่จะแทนที่ของเดิม)
              </span>
            ) : null}
          </p>
        </header>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {error}
          </p>
        ) : null}

        {step === 'amount' ? (
          <section aria-label="จำนวนที่ลด" className="mt-5">
            <div className="flex gap-3">
              {(['AMOUNT', 'PERCENT'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => switchMode(candidate)}
                  aria-pressed={mode === candidate}
                  className={`btn h-14 flex-1 text-lg ${
                    mode === candidate
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                  }`}
                >
                  {candidate === 'AMOUNT' ? 'ลดเป็นบาท' : 'ลดเป็น %'}
                </button>
              ))}
            </div>

            <label className="mt-4 block">
              <span className="text-sm text-slate-600">
                {mode === 'AMOUNT' ? 'ลดกี่บาท' : 'ลดกี่เปอร์เซ็นต์'}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                className="tnum mt-1 h-14 w-full rounded-xl border border-slate-300 px-4 text-2xl"
              />
            </label>

            {mode === 'PERCENT' ? (
              <div className="mt-3 flex gap-2">
                {QUICK_PERCENTS.map((percent) => (
                  <button
                    key={percent}
                    type="button"
                    onClick={() => setTyped(String(percent))}
                    className="btn h-11 flex-1 bg-slate-100 text-slate-800 hover:bg-slate-200"
                  >
                    {percent}%
                  </button>
                ))}
              </div>
            ) : null}

            {/* The figure being signed for, shown before anyone signs. */}
            {requested !== null && requested > 0 ? (
              <p
                className={`tnum mt-3 rounded-xl p-3 text-lg ${
                  tooLarge ? 'bg-red-50 text-red-900' : 'bg-slate-50'
                }`}
              >
                {tooLarge
                  ? `ลด ${formatSatang(requested)} มากกว่ายอดบิล ${formatSatang(grossSatang)}`
                  : `ลด ${formatSatang(requested)} → ลูกค้าจ่าย ${formatSatang(
                      grossSatang - requested,
                    )}`}
              </p>
            ) : null}

            <h3 className="mt-5 mb-2 font-semibold">เพราะอะไร</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {DISCOUNT_REASONS.map((candidate) => (
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
                สาขานี้ยังไม่มีผู้จัดการหรือเจ้าของในระบบ — ลดราคาไม่ได้
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
            onClick={step === 'amount' ? onClose : () => setStep('amount')}
            className="btn h-14 flex-1 bg-slate-100 text-lg text-slate-700 hover:bg-slate-200"
          >
            {step === 'amount' ? 'ปิด' : '← แก้จำนวน'}
          </button>
          {step === 'amount' ? (
            <button
              type="button"
              onClick={() => setStep('approve')}
              disabled={!ready}
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

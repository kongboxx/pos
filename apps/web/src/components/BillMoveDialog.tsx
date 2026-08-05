/**
 * ย้ายโต๊ะ · รวมบิล · แยกบิล — the three things a cashier does when the seating
 * plan and the paperwork stop agreeing.
 *
 * Three dialogs in one file because they share a shell and, more importantly, a
 * rule: NONE OF THEM ASKS FOR A SUPERVISOR'S PIN. Nothing here changes what
 * anything costs — the rows move, the prices do not (see bill-move.ts). Putting
 * a manager in the way of moving a table would mean tables get moved in the
 * room and not in the system, which is the exact failure the feature exists to
 * fix. What protects the shop is the audit row, written server-side.
 *
 * All three are ONLINE ONLY and say so on the button rather than failing after
 * the tap. Two tablets rearranging the same floor with no network would sync
 * two different answers about which bill still exists.
 *
 * THE SPLIT DIALOG DOES ITS OWN CHECKING with `planSplit`, the same function
 * the server runs. The point is not to save a round trip; it is that a cashier
 * standing in front of four people should learn "you cannot move every line
 * off" while ticking boxes, not after pressing the button.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  billsOnTable,
  formatSatang,
  planSplit,
  type OrderDto,
  type TableBillDto,
  type TableDto,
} from '@pos/shared';
import { api } from '../api-client.js';
import { dropOrder, putOrder } from '../offline/db.js';

interface ShellProps {
  title: string;
  subtitle: string;
  error: string | null;
  busy: boolean;
  confirmLabel: string;
  confirmDisabled: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}

function Shell({
  title,
  subtitle,
  error,
  busy,
  confirmLabel,
  confirmDisabled,
  onClose,
  onConfirm,
  children,
}: ShellProps): React.ReactElement {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-3xl bg-white p-6"
      >
        <header>
          <h2 className="text-2xl font-bold">{title}</h2>
          <p className="mt-1 text-lg text-slate-600">{subtitle}</p>
        </header>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {error}
          </p>
        ) : null}

        <div className="mt-5">{children}</div>

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn h-14 flex-1 bg-slate-100 text-lg text-slate-800 hover:bg-slate-200
              disabled:opacity-40"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || busy}
            className="btn h-14 flex-1 bg-brand-600 text-lg text-white hover:bg-brand-500
              disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ย้ายโต๊ะ                                                             */
/* ------------------------------------------------------------------ */

interface MoveTableDialogProps {
  order: OrderDto;
  tables: readonly TableDto[];
  onClose: () => void;
  onDone: (message: string) => void;
}

export function MoveTableDialog({
  order,
  tables,
  onClose,
  onDone,
}: MoveTableDialogProps): React.ReactElement {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(
    () => tables.filter((table) => table.id !== order.tableId),
    [tables, order.tableId],
  );

  const confirm = useCallback(async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const result = await api.moveBillToTable(order.id, { tableId: picked });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The mirror on this device is now behind; the bill it holds still names
    // the old table and the order screen reads from it.
    await putOrder(result.data.order, false);
    onDone(`ย้ายไปโต๊ะ ${result.data.order.tableName ?? ''} แล้ว`);
  }, [order.id, picked, onDone]);

  return (
    <Shell
      title="ย้ายโต๊ะ"
      subtitle={`บิล ${order.orderNo ?? ''} ตอนนี้อยู่โต๊ะ ${order.tableName ?? '—'}`}
      error={error}
      busy={busy}
      confirmLabel="ย้าย"
      confirmDisabled={picked === null}
      onClose={onClose}
      onConfirm={() => void confirm()}
    >
      {choices.length === 0 ? (
        <p className="text-slate-500">ไม่มีโต๊ะอื่นให้ย้าย</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {choices.map((table) => {
            const bills = billsOnTable(table);
            return (
              <button
                key={table.id}
                type="button"
                onClick={() => setPicked(table.id)}
                aria-pressed={picked === table.id}
                className={`btn h-20 flex-col gap-0.5 ${
                  picked === table.id
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                <span className="text-xl font-bold">{table.name}</span>
                {/* A table with bills on it is still a legal destination — two
                    groups can sit together and pay separately — but the cashier
                    should know before tapping, not after. */}
                <span className="text-sm opacity-80">
                  {bills.length === 0 ? 'ว่าง' : `มี ${bills.length} บิล`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* รวมบิล                                                              */
/* ------------------------------------------------------------------ */

interface MergeBillDialogProps {
  order: OrderDto;
  /** Every other bill still open in the shop, from /orders/open. */
  candidates: readonly OrderDto[];
  onClose: () => void;
  onDone: (message: string) => void;
}

export function MergeBillDialog({
  order,
  candidates,
  onClose,
  onDone,
}: MergeBillDialogProps): React.ReactElement {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(
    () => candidates.filter((bill) => bill.id !== order.id && bill.status === 'OPEN'),
    [candidates, order.id],
  );

  const confirm = useCallback(async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const result = await api.mergeBills(order.id, { fromOrderId: picked });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await putOrder(result.data.order, false);
    // The absorbed bill is CANCELLED now. Leaving this device's mirror of it
    // saying OPEN would draw a bill on the floor plan that no longer exists.
    await dropOrder(picked);
    onDone('รวมบิลแล้ว');
  }, [order.id, picked, onDone]);

  return (
    <Shell
      title="รวมบิล"
      subtitle={`เลือกบิลที่จะรวมเข้ามาในบิล ${order.orderNo ?? ''} — บิลที่เลือกจะถูกยกเลิก`}
      error={error}
      busy={busy}
      confirmLabel="รวมเข้าบิลนี้"
      confirmDisabled={picked === null}
      onClose={onClose}
      onConfirm={() => void confirm()}
    >
      {choices.length === 0 ? (
        <p className="text-slate-500">ตอนนี้ไม่มีบิลอื่นที่เปิดอยู่</p>
      ) : (
        <ul className="space-y-2">
          {choices.map((bill) => (
            <li key={bill.id}>
              <button
                type="button"
                onClick={() => setPicked(bill.id)}
                aria-pressed={picked === bill.id}
                className={`btn h-16 w-full justify-between px-4 text-left ${
                  picked === bill.id
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                <span className="text-lg font-semibold">
                  {bill.orderNo ?? 'รอเลขบิล'}
                  <span className="ml-2 font-normal opacity-80">
                    {bill.tableName ?? 'กลับบ้าน'}
                  </span>
                </span>
                <span className="tnum text-lg">
                  {formatSatang(bill.totalSatang)} · {bill.lines.length} รายการ
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* แยกบิล                                                              */
/* ------------------------------------------------------------------ */

interface SplitBillDialogProps {
  order: OrderDto;
  onClose: () => void;
  onDone: (message: string, newOrderId: string) => void;
}

export function SplitBillDialog({
  order,
  onClose,
  onDone,
}: SplitBillDialogProps): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Voided lines are not offered at all: they cannot move (bill-move.ts) and a
  // disabled row the cashier keeps poking at teaches nothing.
  const choosable = order.lines.filter((line) => line.voidedAt === null);
  const check = planSplit(order, selected);

  const movingTotal = check.ok
    ? check.plan.moving.reduce((sum, line) => sum + line.lineTotalSatang, 0)
    : 0;

  const toggle = (lineId: string): void =>
    setSelected((current) =>
      current.includes(lineId) ? current.filter((id) => id !== lineId) : [...current, lineId],
    );

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Rule #6: the tablet names the new bill, so a retry after a dropped
    // response lands on the same one instead of cutting the bill twice.
    const newOrderId = crypto.randomUUID();
    const result = await api.splitBill(order.id, { newOrderId, lineIds: selected });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await putOrder(result.data.order, false);
    await putOrder(result.data.newOrder, false);
    onDone(`แยกเป็นบิล ${result.data.newOrder.orderNo ?? ''} แล้ว`, result.data.newOrder.id);
  }, [order.id, selected, onDone]);

  return (
    <Shell
      title="แยกบิล"
      subtitle="เลือกรายการที่จะย้ายไปบิลใหม่ — บิลใหม่จะอยู่โต๊ะเดิม"
      error={error}
      busy={busy}
      confirmLabel={movingTotal > 0 ? `แยกออก ${formatSatang(movingTotal)}` : 'แยกบิล'}
      confirmDisabled={!check.ok}
      onClose={onClose}
      onConfirm={() => void confirm()}
    >
      <ul className="space-y-2">
        {choosable.map((line) => {
          const picked = selected.includes(line.id);
          return (
            <li key={line.id}>
              <button
                type="button"
                onClick={() => toggle(line.id)}
                aria-pressed={picked}
                className={`btn h-16 w-full justify-between px-4 text-left ${
                  picked
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                <span className="text-lg">
                  {line.qty} × {line.nameSnapshot}
                </span>
                <span className="tnum text-lg">{formatSatang(line.lineTotalSatang)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* The same sentence the server would have sent back, shown before the
          button is pressed rather than after. */}
      {!check.ok && check.refusal !== 'NOTHING_SELECTED' ? (
        <p className="mt-4 rounded-xl bg-amber-50 p-3 text-amber-900">{check.message}</p>
      ) : null}

      {check.ok ? (
        <p className="tnum mt-4 rounded-xl bg-slate-50 p-3 text-lg">
          บิลใหม่ {formatSatang(movingTotal)} · บิลเดิมเหลือ{' '}
          {formatSatang(order.totalSatang - movingTotal)}
        </p>
      ) : null}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Which bill did they mean, when a table is carrying more than one?
 *
 * Only shown when it has to be. A table with one bill goes straight through —
 * asking would put a tap between the cashier and every single order.
 */
export function BillPicker({
  tableName,
  bills,
  onPick,
  onClose,
}: {
  tableName: string;
  bills: readonly TableBillDto[];
  onPick: (orderId: string) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`บิลที่โต๊ะ ${tableName}`}
        className="w-full max-w-lg rounded-3xl bg-white p-6"
      >
        <h2 className="text-2xl font-bold">โต๊ะ {tableName}</h2>
        <p className="mt-1 text-slate-600">โต๊ะนี้มี {bills.length} บิล — เลือกบิลที่จะเปิด</p>

        <ul className="mt-5 space-y-2">
          {bills.map((bill) => (
            <li key={bill.id}>
              <button
                type="button"
                onClick={() => onPick(bill.id)}
                className="btn h-16 w-full justify-between bg-slate-100 px-4 text-left
                  text-slate-800 hover:bg-slate-200"
              >
                <span className="text-lg font-semibold">{bill.orderNo ?? 'รอเลขบิล'}</span>
                <span className="tnum text-lg">
                  {formatSatang(bill.totalSatang)} · {bill.lineCount} รายการ
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* No "open another bill here" button. A second bill at a table is
            made by SPLITTING one, which is the only way that has a first bill
            to point at — opening one from nothing would need the occupied-table
            guard lifted, and that guard is also what stops a customer's QR scan
            starting a second bill nobody is looking at. */}
        <button
          type="button"
          onClick={onClose}
          className="btn mt-6 h-14 w-full bg-slate-100 text-lg text-slate-800 hover:bg-slate-200"
        >
          ปิด
        </button>
      </div>
    </div>
  );
}

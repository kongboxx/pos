/**
 * Choosing options — เส้น / น้ำซุป / ขนาด / เพิ่มเติม / ไม่ใส่.
 *
 * The design constraint from the brief is that ordering one bowl must beat
 * writing it on a pad. So the sheet opens with the shop's DEFAULTS already
 * chosen (เส้นเล็ก น้ำใส ธรรมดา): an ordinary bowl is tap-item, tap-confirm,
 * and only an unusual one costs extra taps. Nothing here is a dropdown.
 *
 * Whether a selection is legal is decided by validateSelection from
 * @pos/shared — the SAME function the API runs. This screen does not carry its
 * own copy of the rule; it only renders the answer. That is what stops the
 * till offering a combination the server then refuses.
 *
 * A single-select group behaves like a radio and cannot be emptied by tapping
 * the chosen option again: at a counter that reads as "it deselected itself"
 * and costs a second tap to undo. Optional single-select groups do allow it,
 * because there "none" is a real answer.
 *
 * THE NOTE BOX IS OPT-IN (`noteEnabled`), and it is on for the till only.
 *
 * It is last, below the options, and deliberately plain: no suggestion chips.
 * Anything a shop asks for often enough to deserve a button is an OPTION — it
 * can be priced, it can subtract from a recipe, and the kitchen reads it in the
 * same place every time. Turning "เผ็ดน้อย" into a chip here would be the
 * beginning of a second, unpriced menu that only exists as free text.
 *
 * The customer's QR page shares this sheet and leaves the box OFF: a note goes
 * to the kitchen, and text typed by a stranger belongs behind the approval
 * queue at least. That is a decision for the Step that opens it, not a default.
 */

import { useMemo, useState } from 'react';
import {
  formatSatang,
  MAX_ORDER_NOTE,
  minSelectOf,
  normalizeNote,
  selectionPriceDeltaSatang,
  validateSelection,
  type ModifierDto,
  type ModifierGroupDto,
} from '@pos/shared';

interface ModifierSheetProps {
  itemName: string;
  /** Menu price before options. The header shows this plus the live delta. */
  basePriceSatang: number;
  /** In the order the item offers them. */
  groups: readonly ModifierGroupDto[];
  initialSelection: readonly string[];
  initialQty: number;
  mode: 'add' | 'edit';
  busy?: boolean;
  /** Off by default — see the note at the top of this file. */
  noteEnabled?: boolean;
  initialNote?: string | null;
  onCancel: () => void;
  onConfirm: (modifierIds: string[], qty: number, note: string | null) => void;
}

export function ModifierSheet({
  itemName,
  basePriceSatang,
  groups,
  initialSelection,
  initialQty,
  mode,
  busy = false,
  noteEnabled = false,
  initialNote = null,
  onCancel,
  onConfirm,
}: ModifierSheetProps): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([...initialSelection]);
  const [qty, setQty] = useState(initialQty);
  const [note, setNote] = useState(initialNote ?? '');

  const problem = useMemo(() => validateSelection(groups, selected), [groups, selected]);
  const unitPriceSatang = basePriceSatang + selectionPriceDeltaSatang(groups, selected);
  const totalSatang = unitPriceSatang * qty;

  const toggle = (group: ModifierGroupDto, modifier: ModifierDto): void => {
    if (!modifier.isAvailable) return;

    setSelected((current) => {
      const isOn = current.includes(modifier.id);
      const groupIds = new Set(group.modifiers.map((option) => option.id));

      if (group.maxSelect === 1) {
        const withoutGroup = current.filter((id) => !groupIds.has(id));
        // Turning the chosen one off is only allowed where "none" is legal.
        if (isOn && minSelectOf(group) === 0) return withoutGroup;
        return [...withoutGroup, modifier.id];
      }

      if (isOn) return current.filter((id) => id !== modifier.id);
      const countInGroup = current.filter((id) => groupIds.has(id)).length;
      if (countInGroup >= group.maxSelect) return current;
      return [...current, modifier.id];
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col rounded-3xl bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-bold">{itemName}</h2>
            <p className="tnum text-slate-500">
              {formatSatang(unitPriceSatang)} / ที่
              {unitPriceSatang !== basePriceSatang ? (
                <span className="ml-2 text-slate-400">
                  (ราคาปกติ {formatSatang(basePriceSatang)})
                </span>
              ) : null}
            </p>
          </div>
          <button type="button" onClick={onCancel} className="btn h-11 shrink-0 bg-slate-100 px-4">
            ยกเลิก
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {groups.map((group) => (
            <Group
              key={group.id}
              group={group}
              selected={selected}
              highlight={problem?.groupId === group.id}
              disabled={busy}
              onToggle={(modifier) => toggle(group, modifier)}
            />
          ))}

          {noteEnabled ? (
            <label className="block">
              <span className="text-lg font-semibold">หมายเหตุถึงครัว</span>
              <input
                type="text"
                value={note}
                maxLength={MAX_ORDER_NOTE}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
                placeholder="เช่น เผ็ดน้อย · ไม่ใส่ผักชี"
                className="mt-2 h-14 w-full rounded-xl border border-slate-300 px-3 text-lg"
              />
              {/* Said out loud because it is the difference between a note that
                  reaches the pass and one that only ever reached the tablet. */}
              <span className="mt-1 block text-sm text-slate-500">
                พิมพ์ลงบัตรครัวและใบเสร็จ · ถ้าเป็นสิ่งที่ลูกค้าขอบ่อย ควรทำเป็นตัวเลือกแทน
                จะได้คิดราคาและตัดสต๊อกได้
              </span>
            </label>
          ) : null}
        </div>

        <footer className="border-t border-slate-200 px-4 py-4 sm:px-6">
          {/* Stacked on a phone, side by side on a tablet.
              This sheet is shared with the customer's QR page (Step 7), and on
              a 375px screen the one row could not hold the stepper AND
              "เพิ่มลงบิล 50.00" — the price fell out of the right-hand edge of
              the one button the whole screen exists to get pressed. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setQty((n) => Math.max(1, n - 1))}
                disabled={busy || qty <= 1}
                aria-label="ลดจำนวน"
                className="btn h-14 w-12 bg-slate-100 text-2xl disabled:opacity-40 sm:w-14"
              >
                −
              </button>
              <span className="tnum w-12 text-center text-2xl font-bold">{qty}</span>
              <button
                type="button"
                onClick={() => setQty((n) => Math.min(99, n + 1))}
                disabled={busy}
                aria-label="เพิ่มจำนวน"
                className="btn h-14 w-12 bg-slate-100 text-2xl disabled:opacity-40 sm:w-14"
              >
                +
              </button>
            </div>

            <button
              type="button"
              onClick={() => onConfirm(selected, qty, normalizeNote(note))}
              disabled={busy || problem !== null}
              className="btn tnum h-16 flex-1 whitespace-nowrap bg-emerald-600 text-xl
                text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {mode === 'edit' ? 'บันทึก' : 'เพิ่มลงบิล'} {formatSatang(totalSatang)}
            </button>
          </div>

          {problem ? (
            <p role="alert" className="mt-2 text-center text-red-700">
              {problem.message}
            </p>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function Group({
  group,
  selected,
  highlight,
  disabled,
  onToggle,
}: {
  group: ModifierGroupDto;
  selected: readonly string[];
  highlight: boolean;
  disabled: boolean;
  onToggle: (modifier: ModifierDto) => void;
}): React.ReactElement {
  const min = minSelectOf(group);
  const countInGroup = group.modifiers.filter((m) => selected.includes(m.id)).length;
  const atMax = countInGroup >= group.maxSelect;

  return (
    <section aria-labelledby={`group-${group.id}`}>
      <h3 id={`group-${group.id}`} className="mb-2 flex items-baseline gap-2">
        <span className="text-lg font-semibold">{group.name}</span>
        <span className={`text-sm ${highlight ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
          {min > 0
            ? `ต้องเลือก ${min}`
            : group.maxSelect > 1
              ? `เลือกได้ถึง ${group.maxSelect}`
              : 'ไม่บังคับ'}
        </span>
      </h3>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {group.modifiers.map((modifier) => {
          const isOn = selected.includes(modifier.id);
          // Blocked rather than silently ignored: a button that does nothing
          // when tapped gets tapped again, harder.
          const blocked = !isOn && atMax && group.maxSelect > 1;
          return (
            <button
              key={modifier.id}
              type="button"
              aria-pressed={isOn}
              disabled={disabled || !modifier.isAvailable || blocked}
              onClick={() => onToggle(modifier)}
              className={`btn h-14 flex-col gap-0 px-3 text-center ${toneOf(group, isOn)}
                disabled:opacity-40`}
            >
              <span className="line-clamp-1">{modifier.name}</span>
              {modifier.priceDeltaSatang !== 0 ? (
                <span className="tnum text-xs opacity-80">
                  {modifier.priceDeltaSatang > 0 ? '+' : '−'}
                  {formatSatang(Math.abs(modifier.priceDeltaSatang))}
                </span>
              ) : null}
              {!modifier.isAvailable ? <span className="text-xs">หมด</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** "ไม่ใส่…" groups are amber: a removal is what the kitchen misreads most. */
function toneOf(group: ModifierGroupDto, isOn: boolean): string {
  if (!isOn) return 'bg-slate-100 text-slate-700 hover:bg-slate-200';
  return group.isNegative ? 'bg-amber-500 text-white' : 'bg-brand-600 text-white';
}

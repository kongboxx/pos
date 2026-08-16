/**
 * Ingredients, and what they cost.
 *
 * This is the screen that moves the most numbers with the fewest taps: change
 * what pork costs and every dish containing pork is re-costed in the same
 * request. The banner from the store then says how many moved, because
 * otherwise the only way to notice is to go and compare rows.
 *
 * A price here is per BASE UNIT — per gram, not per kilo. Buying a kilo at 200
 * baht means typing 20 satang, and the unit column is next to the field so that
 * is visible while typing. Getting this wrong by a factor of a thousand is the
 * easiest mistake on the screen, so the unit can no longer be edited once a
 * recipe uses it (the server refuses, and says why).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  formatSatang,
  parseBahtToSatang,
  satangToBaht,
  type AdminIngredientDto,
  type IngredientRequest,
} from '@pos/shared';
import { officeApi } from '../../api-office.js';
import { ManageShell } from '../../components/office/ManageShell.js';
import { useManage } from '../../manage-store.js';

interface Draft {
  name: string;
  baseUnit: string;
  cost: string;
}

const EMPTY: Draft = { name: '', baseUnit: 'กรัม', cost: '' };

export function ManageIngredientsPage(): React.ReactElement {
  const menu = useManage((state) => state.menu);
  const loading = useManage((state) => state.loading);
  const busy = useManage((state) => state.busy);
  const load = useManage((state) => state.load);
  const run = useManage((state) => state.run);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = useCallback((ingredient: AdminIngredientDto) => {
    setAdding(false);
    setProblem(null);
    setEditingId(ingredient.id);
    setDraft({
      name: ingredient.name,
      baseUnit: ingredient.baseUnit,
      cost: String(satangToBaht(ingredient.avgCostSatang)),
    });
  }, []);

  const submit = useCallback(async () => {
    const avgCostSatang = parseBahtToSatang(draft.cost);
    if (draft.name.trim() === '' || draft.baseUnit.trim() === '') {
      setProblem('ต้องใส่ชื่อและหน่วย');
      return;
    }
    if (avgCostSatang === null || avgCostSatang < 0) {
      setProblem('ราคาต่อหน่วยไม่ถูกต้อง');
      return;
    }
    setProblem(null);

    const input: IngredientRequest = {
      name: draft.name.trim(),
      baseUnit: draft.baseUnit.trim(),
      avgCostSatang,
      shelfLifeDays: null,
      isActive: true,
    };
    const ok = await run(() =>
      editingId ? officeApi.updateIngredient(editingId, input) : officeApi.createIngredient(input),
    );
    if (ok) {
      setEditingId(null);
      setAdding(false);
      setDraft(EMPTY);
    }
  }, [draft, editingId, run]);

  const remove = useCallback(
    async (ingredient: AdminIngredientDto) => {
      const ok = await run(() => officeApi.deleteIngredient(ingredient.id));
      if (ok && editingId === ingredient.id) setEditingId(null);
    },
    [run, editingId],
  );

  const ingredients = menu?.ingredients ?? [];

  return (
    <ManageShell>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-600">
          วัตถุดิบ {ingredients.length > 0 ? `(${ingredients.length})` : ''}
        </h2>
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setEditingId(null);
            setDraft(EMPTY);
          }}
          className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500"
        >
          + เพิ่มวัตถุดิบ
        </button>
      </div>

      {problem ? (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-red-900">
          {problem}
        </p>
      ) : null}

      {adding || editingId ? (
        <form
          aria-label={editingId ? 'แก้ไขวัตถุดิบ' : 'เพิ่มวัตถุดิบ'}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mb-6 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4"
        >
          <label className="flex-1">
            <span className="text-sm text-slate-600">ชื่อ</span>
            <input
              type="text"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
              className="mt-1 h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
            />
          </label>
          <label className="w-32">
            <span className="text-sm text-slate-600">หน่วย</span>
            <input
              type="text"
              value={draft.baseUnit}
              onChange={(event) =>
                setDraft((current) => ({ ...current, baseUnit: event.target.value }))
              }
              className="mt-1 h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
            />
          </label>
          <label className="w-40">
            <span className="text-sm text-slate-600">
              ราคาต่อ 1 {draft.baseUnit || 'หน่วย'} (บาท)
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={draft.cost}
              onChange={(event) =>
                setDraft((current) => ({ ...current, cost: event.target.value }))
              }
              className="tnum mt-1 h-12 w-full rounded-xl border border-slate-300 px-3 text-right text-lg"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500 disabled:opacity-50"
          >
            บันทึก
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setEditingId(null);
              setProblem(null);
            }}
            className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
          >
            ยกเลิก
          </button>
        </form>
      ) : null}

      {loading && !menu ? (
        <p className="text-slate-400">กำลังโหลด…</p>
      ) : (
        <ul className="space-y-2">
          {ingredients.map((ingredient) => (
            <li
              key={ingredient.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4"
            >
              <span className="min-w-48 flex-1 text-lg font-medium">{ingredient.name}</span>
              <span className="tnum w-40 text-right">
                {formatSatang(ingredient.avgCostSatang)}
                <span className="text-slate-500"> / {ingredient.baseUnit}</span>
              </span>
              <span className="w-32 text-slate-500">
                {ingredient.usedByCount > 0
                  ? `ใช้ใน ${ingredient.usedByCount} สูตร`
                  : 'ยังไม่ถูกใช้'}
              </span>
              <button
                type="button"
                onClick={() => startEdit(ingredient)}
                className="btn h-11 bg-slate-100 px-4 text-slate-700 hover:bg-slate-200"
              >
                แก้ไข
              </button>
              {/* Only offered when nothing points at it. The server refuses
                  either way, but a button that always fails is a trap. */}
              {ingredient.usedByCount === 0 ? (
                <button
                  type="button"
                  onClick={() => void remove(ingredient)}
                  disabled={busy}
                  className="btn h-11 bg-red-50 px-4 text-red-800 hover:bg-red-100 disabled:opacity-50"
                >
                  ลบ
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </ManageShell>
  );
}

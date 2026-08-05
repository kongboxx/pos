/**
 * The recipe (BOM) for one dish or one option.
 *
 * This is where cost comes from, so the screen's job is to make the arithmetic
 * visible while it is being typed: every row shows what that ingredient costs
 * in this dish, and the total updates as the quantity does. An owner who has to
 * press save to find out what a change did will stop trying changes.
 *
 * The maths is @pos/shared's `recipeCostSatang`, the same function the server
 * uses to write the number — not a second implementation that would drift.
 *
 * NEGATIVE QUANTITIES are allowed only for an option (`allowNegative`), where
 * they are the whole point: "บะหมี่" is −120 g of one noodle and +120 g of
 * another. A dish that leaves something out simply does not list it.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  formatQuantity,
  formatSatang,
  isStorableQuantity,
  recipeCostSatang,
  recipeLineCostSatang,
  type AdminIngredientDto,
  type AdminRecipeLineDto,
  type RecipeLineInput,
} from '@pos/shared';

interface DraftLine {
  ingredientId: string;
  /** Kept as typed text so "0." and "-" survive halfway through an entry. */
  quantity: string;
}

interface RecipeEditorProps {
  lines: readonly AdminRecipeLineDto[];
  ingredients: readonly AdminIngredientDto[];
  allowNegative: boolean;
  busy: boolean;
  onSave: (lines: RecipeLineInput[]) => Promise<boolean>;
}

export function RecipeEditor({
  lines,
  ingredients,
  allowNegative,
  busy,
  onSave,
}: RecipeEditorProps): React.ReactElement {
  const [draft, setDraft] = useState<DraftLine[]>(() =>
    lines.map((line) => ({
      ingredientId: line.ingredientId,
      quantity: formatQuantity(line.quantity),
    })),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients],
  );

  const unused = ingredients.filter(
    (ingredient) => !draft.some((line) => line.ingredientId === ingredient.id),
  );

  /** Rows that parse, so the running total can be shown while one is mid-typing. */
  const priced = draft.map((line) => {
    const ingredient = byId.get(line.ingredientId);
    const quantity = Number(line.quantity);
    const valid =
      line.quantity.trim() !== '' &&
      Number.isFinite(quantity) &&
      isStorableQuantity(quantity) &&
      quantity !== 0 &&
      (allowNegative || quantity > 0);
    return { line, ingredient, quantity, valid };
  });

  const total = recipeCostSatang(
    priced
      .filter((row) => row.valid && row.ingredient)
      .map((row) => ({
        quantity: row.quantity,
        unitCostSatang: row.ingredient?.avgCostSatang ?? 0,
      })),
  );

  const save = useCallback(async () => {
    const parsed: RecipeLineInput[] = [];
    for (const line of draft) {
      const quantity = Number(line.quantity);
      if (line.quantity.trim() === '' || !Number.isFinite(quantity) || quantity === 0) {
        setProblem('ยังมีบรรทัดที่ไม่ได้ใส่จำนวน — ลบบรรทัดออกหรือใส่จำนวนให้ครบ');
        return;
      }
      if (!isStorableQuantity(quantity)) {
        setProblem('จำนวนมีทศนิยมได้ไม่เกิน 4 ตำแหน่ง');
        return;
      }
      if (!allowNegative && quantity < 0) {
        setProblem('สูตรของเมนูใส่จำนวนติดลบไม่ได้ — ถ้าไม่ใส่ ให้ลบบรรทัดออก');
        return;
      }
      parsed.push({ ingredientId: line.ingredientId, quantity });
    }
    setProblem(null);
    await onSave(parsed);
  }, [draft, allowNegative, onSave]);

  return (
    <section aria-label="สูตร" className="rounded-2xl bg-slate-50 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">สูตร (วัตถุดิบต่อ 1 ที่)</h3>
        <p className="tnum text-lg font-semibold">
          ต้นทุนรวม <span className="text-brand-700">{formatSatang(total)}</span>
        </p>
      </div>

      {draft.length === 0 ? (
        <p className="mt-3 text-slate-500">
          ยังไม่ได้ใส่สูตร — ต้นทุนของรายการนี้จะเป็น 0 และกำไรที่เห็นจะไม่ใช่ของจริง
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {priced.map((row, index) => (
            <li
              key={row.line.ingredientId}
              className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-3"
            >
              <span className="min-w-40 flex-1 font-medium">
                {row.ingredient?.name ?? 'วัตถุดิบที่ถูกลบไปแล้ว'}
              </span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={`จำนวน ${row.ingredient?.name ?? ''}`}
                value={row.line.quantity}
                onChange={(event) => {
                  const next = event.target.value;
                  setDraft((current) =>
                    current.map((line, position) =>
                      position === index ? { ...line, quantity: next } : line,
                    ),
                  );
                }}
                className={`tnum h-12 w-28 rounded-xl border px-3 text-right text-lg ${
                  row.valid ? 'border-slate-300' : 'border-red-400 bg-red-50'
                }`}
              />
              <span className="w-20 text-slate-500">{row.ingredient?.baseUnit}</span>
              <span className="tnum w-24 text-right text-slate-700">
                {row.valid && row.ingredient
                  ? formatSatang(
                      recipeLineCostSatang({
                        quantity: row.quantity,
                        unitCostSatang: row.ingredient.avgCostSatang,
                      }),
                    )
                  : '—'}
              </span>
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => current.filter((_, position) => position !== index))
                }
                className="btn h-11 bg-red-50 px-4 text-red-800 hover:bg-red-100"
              >
                ลบ
              </button>
            </li>
          ))}
        </ul>
      )}

      {problem ? (
        <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-red-900">
          {problem}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          aria-label="เพิ่มวัตถุดิบ"
          value=""
          onChange={(event) => {
            const ingredientId = event.target.value;
            if (!ingredientId) return;
            setDraft((current) => [...current, { ingredientId, quantity: '' }]);
          }}
          disabled={unused.length === 0}
          className="h-12 flex-1 rounded-xl border border-slate-300 px-3 text-lg disabled:opacity-50"
        >
          <option value="">+ เพิ่มวัตถุดิบ…</option>
          {unused.map((ingredient) => (
            <option key={ingredient.id} value={ingredient.id}>
              {ingredient.name} ({formatSatang(ingredient.avgCostSatang)}/{ingredient.baseUnit})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500 disabled:opacity-50"
        >
          บันทึกสูตร
        </button>
      </div>

      {allowNegative ? (
        <p className="mt-3 text-sm text-slate-500">
          ใส่จำนวนติดลบได้ เพราะตัวเลือกคือ &quot;ส่วนต่าง&quot; จากชามปกติ — เช่น บะหมี่ = เส้นเล็ก
          -120 กรัม และ บะหมี่ +120 กรัม
        </p>
      ) : null}
    </section>
  );
}

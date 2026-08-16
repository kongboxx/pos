/**
 * Adding or changing one dish.
 *
 * THERE IS NO COST FIELD, and that is the point of Step 6. Cost comes from the
 * recipe below the form or it does not exist; a box to type it in would be a
 * second answer to the same question, and the typed one always turns out to be
 * from opening week.
 *
 * The recipe only appears once the dish exists, because a recipe line needs
 * something to belong to. Creating first and costing second is also the order
 * an owner works in: get it on the menu, work out what it costs later.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  foodCostBp,
  formatPercentBp,
  formatSatang,
  grossProfitSatang,
  HIGH_FOOD_COST_BP,
  parseBahtToSatang,
  satangToBaht,
  type AdminIngredientDto,
  type AdminMenuCategoryDto,
  type AdminMenuItemDto,
  type AdminModifierGroupDto,
  type MenuItemRequest,
  type RecipeLineInput,
} from '@pos/shared';
import { RecipeEditor } from './RecipeEditor.js';

interface MenuItemEditorProps {
  /** null = a new dish. */
  item: AdminMenuItemDto | null;
  categoryId: string;
  categories: readonly AdminMenuCategoryDto[];
  groups: readonly AdminModifierGroupDto[];
  ingredients: readonly AdminIngredientDto[];
  stations: readonly string[];
  busy: boolean;
  onClose: () => void;
  onSave: (input: MenuItemRequest) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onSaveRecipe: (lines: RecipeLineInput[]) => Promise<boolean>;
}

export function MenuItemEditor({
  item,
  categoryId,
  categories,
  groups,
  ingredients,
  stations,
  busy,
  onClose,
  onSave,
  onDelete,
  onSaveRecipe,
}: MenuItemEditorProps): React.ReactElement {
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.categoryId ?? categoryId);
  const [subcategory, setSubcategory] = useState(item?.subcategory ?? '');
  const [price, setPrice] = useState(item ? String(satangToBaht(item.priceSatang)) : '');
  const [station, setStation] = useState(item?.station ?? '');
  const [groupIds, setGroupIds] = useState<string[]>(item?.groupIds ?? []);
  const [isAvailable, setAvailable] = useState(item?.isAvailable ?? true);
  const [isActive, setActive] = useState(item?.isActive ?? true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const chosenCategory = categories.find((candidate) => candidate.id === category);
  const priceSatang = parseBahtToSatang(price);

  const margin = useMemo(() => {
    if (priceSatang === null || !item?.hasRecipe) return null;
    return {
      profit: grossProfitSatang(priceSatang, item.costSatang),
      bp: foodCostBp(priceSatang, item.costSatang),
    };
  }, [priceSatang, item]);

  const save = useCallback(async () => {
    if (name.trim() === '') {
      setProblem('ต้องใส่ชื่อเมนู');
      return;
    }
    if (priceSatang === null || priceSatang < 0) {
      setProblem('ราคาไม่ถูกต้อง — ใส่เป็นตัวเลข เช่น 50 หรือ 50.50');
      return;
    }
    setProblem(null);
    const saved = await onSave({
      categoryId: category,
      name: name.trim(),
      subcategory: subcategory === '' ? null : subcategory,
      priceSatang,
      station: station.trim() === '' ? null : station.trim(),
      groupIds,
      isAvailable,
      isActive,
      // No sortOrder: where a dish sits in the grid belongs to the ↑/↓ buttons
      // on the list behind this dialog, not to the form.
    });
    if (saved && !item) onClose();
  }, [
    name,
    priceSatang,
    category,
    subcategory,
    station,
    groupIds,
    isAvailable,
    isActive,
    item,
    onSave,
    onClose,
  ]);

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={item ? `แก้ไข ${item.name}` : 'เพิ่มเมนูใหม่'}
        className="w-full max-w-3xl rounded-3xl bg-white p-6"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">{item ? 'แก้ไขเมนู' : 'เพิ่มเมนูใหม่'}</h2>
          <button
            type="button"
            onClick={onClose}
            className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
          >
            ปิด
          </button>
        </header>

        {problem ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {problem}
          </p>
        ) : null}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="ชื่อเมนู">
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
            />
          </Field>

          <Field label="ราคาขาย (บาท)">
            <input
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              className="tnum h-12 w-full rounded-xl border border-slate-300 px-3 text-right text-lg"
            />
          </Field>

          <Field label="หมวด">
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                // The old subcategory belongs to the old category; keeping it
                // would be rejected by the server with a message about a
                // subcategory the owner can no longer see on screen.
                setSubcategory('');
              }}
              className="h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
            >
              {categories.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="หมวดย่อย">
            <select
              value={subcategory}
              onChange={(event) => setSubcategory(event.target.value)}
              className="h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
            >
              <option value="">ไม่ระบุ</option>
              {(chosenCategory?.subcategories ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field label="ทำที่ไหน (จุดทำ)">
            <input
              type="text"
              list="manage-stations"
              value={station}
              onChange={(event) => setStation(event.target.value)}
              className="h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
            />
            <datalist id="manage-stations">
              {stations.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </Field>

          <Field label="สถานะ">
            <div className="flex flex-col gap-2">
              <Toggle
                checked={isAvailable}
                onChange={setAvailable}
                label="มีขายอยู่ (เอาออกชั่วคราวถ้าของหมดวันนี้)"
              />
              <Toggle
                checked={isActive}
                onChange={setActive}
                label="ยังอยู่ในเมนู (ปิดคือเลิกขายถาวร — บิลเก่ายังอ่านได้)"
              />
            </div>
          </Field>
        </div>

        <section aria-label="กลุ่มตัวเลือก" className="mt-5">
          <h3 className="mb-2 text-lg font-semibold">กลุ่มตัวเลือกที่เมนูนี้มี</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            {groups.map((group) => (
              <Toggle
                key={group.id}
                checked={groupIds.includes(group.id)}
                onChange={(checked) =>
                  setGroupIds((current) =>
                    checked
                      ? [...current, group.id]
                      : current.filter((candidate) => candidate !== group.id),
                  )
                }
                label={group.name}
              />
            ))}
          </div>
        </section>

        {item ? (
          <>
            <div className="mt-5">
              <RecipeEditor
                lines={item.recipe}
                ingredients={ingredients}
                allowNegative={false}
                busy={busy}
                onSave={onSaveRecipe}
              />
            </div>

            {margin && margin.bp !== null ? (
              <p className="tnum mt-3 text-lg">
                กำไรต่อจาน <span className="font-semibold">{formatSatang(margin.profit)}</span> ·
                ต้นทุน{' '}
                <span
                  className={
                    margin.bp > HIGH_FOOD_COST_BP ? 'font-semibold text-red-700' : 'font-semibold'
                  }
                >
                  {formatPercentBp(margin.bp)}
                </span>{' '}
                ของราคาขาย
              </p>
            ) : (
              <p className="mt-3 text-slate-500">
                ยังบอกกำไรไม่ได้จนกว่าจะใส่สูตร — ต้นทุน 0 ไม่ได้แปลว่าฟรี
              </p>
            )}
          </>
        ) : (
          <p className="mt-5 rounded-xl bg-slate-50 p-4 text-slate-600">
            บันทึกเมนูก่อน แล้วค่อยใส่สูตรวัตถุดิบ — สูตรต้องมีเมนูให้ผูกก่อน
          </p>
        )}

        <footer className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="btn h-14 flex-1 bg-brand-600 text-lg text-white hover:bg-brand-500 disabled:opacity-50"
          >
            บันทึก
          </button>

          {item ? (
            confirmingDelete ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={busy}
                className="btn h-14 bg-red-600 px-6 text-lg text-white hover:bg-red-500 disabled:opacity-50"
              >
                ยืนยันลบถาวร
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="btn h-14 bg-red-50 px-6 text-lg text-red-800 hover:bg-red-100"
              >
                ลบเมนู
              </button>
            )
          ) : null}
        </footer>

        {item && item.soldCount > 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            เมนูนี้ขายไปแล้ว {item.soldCount} ครั้ง — ลบไม่ได้ เพราะบิลเก่าอ้างถึงอยู่
            ถ้าไม่ขายแล้วให้ปิด &quot;ยังอยู่ในเมนู&quot;
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-sm text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}): React.ReactElement {
  return (
    <label className="flex min-h-11 items-center gap-3 rounded-xl bg-slate-50 px-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5"
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * The menu, with what each dish actually earns — and the shape of the till.
 *
 * The list leads with the numbers an owner cannot get anywhere else — cost and
 * food-cost percentage next to the price — because "which dishes are worth
 * keeping" is the question this screen exists to answer, and it cannot be
 * answered from the till.
 *
 * A dish with no recipe says so instead of showing 0. A zero that means "we
 * never worked it out" and a zero that means "it is free" look identical, and
 * Step 8's profit report would inherit the confusion.
 *
 * THE ORDER IS PART OF THE MENU. Categories came from the seed until now, which
 * meant adding หมวดของหวาน needed a developer, and the order dishes appear in
 * was whatever the Thai alphabet decided. Both are arranged here: ↑/↓ rather
 * than drag-and-drop, the same choice the floor plan made and for the same
 * reason — a 44px button hits every time on a tablet a cook has just touched,
 * and a drag that starts a scroll instead is a dish that silently did not move.
 *
 * Nothing here posts a sortOrder. The buttons call a move endpoint that
 * renumbers the whole list server-side; see moveRequestSchema for why a client
 * that guesses a number gets it wrong.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  foodCostBp,
  formatPercentBp,
  formatSatang,
  HIGH_FOOD_COST_BP,
  type AdminMenuCategoryDto,
  type AdminMenuItemDto,
  type MenuCategoryRequest,
  type MenuItemRequest,
  type MoveDirection,
  type RecipeLineInput,
} from '@pos/shared';
import { officeApi } from '../api-office.js';
import { ManageShell } from '../components/ManageShell.js';
import { MenuItemEditor } from '../components/MenuItemEditor.js';
import { useManage } from '../manage-store.js';

export function ManageMenuPage(): React.ReactElement {
  const menu = useManage((state) => state.menu);
  const loading = useManage((state) => state.loading);
  const busy = useManage((state) => state.busy);
  const load = useManage((state) => state.load);
  const run = useManage((state) => state.run);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item: AdminMenuItemDto | null } | null>(null);
  /** The category being edited, or 'NEW' for the add form. */
  const [editingCategory, setEditingCategory] = useState<AdminMenuCategoryDto | 'NEW' | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = menu?.categories ?? [];
  const current =
    categories.find((category) => category.id === categoryId) ?? categories[0] ?? null;

  // The editor holds a copy of the dish it was opened with, so after a save the
  // recipe section would still show the OLD cost. Re-reading it from the store
  // keeps the number under the recipe honest without closing the dialog.
  const editingItem = editing?.item
    ? (categories
        .flatMap((category) => category.items)
        .find((item) => item.id === editing.item?.id) ?? null)
    : null;

  const saveItem = useCallback(
    async (input: MenuItemRequest): Promise<boolean> =>
      run(() =>
        editingItem
          ? officeApi.updateMenuItem(editingItem.id, input)
          : officeApi.createMenuItem(input),
      ),
    [run, editingItem],
  );

  const saveRecipe = useCallback(
    async (lines: RecipeLineInput[]): Promise<boolean> => {
      if (!editingItem) return false;
      return run(() => officeApi.saveMenuItemRecipe(editingItem.id, { lines }));
    },
    [run, editingItem],
  );

  const removeItem = useCallback(async (): Promise<boolean> => {
    if (!editingItem) return false;
    const ok = await run(() => officeApi.deleteMenuItem(editingItem.id));
    if (ok) setEditing(null);
    return ok;
  }, [run, editingItem]);

  const saveCategory = useCallback(
    async (input: MenuCategoryRequest): Promise<void> => {
      const target = editingCategory;
      if (!target) return;
      const ok = await run(() =>
        target === 'NEW'
          ? officeApi.createCategory(input)
          : officeApi.updateCategory(target.id, input),
      );
      if (ok) setEditingCategory(null);
    },
    [run, editingCategory],
  );

  const removeCategory = useCallback(async (): Promise<void> => {
    const target = editingCategory;
    if (!target || target === 'NEW') return;
    const ok = await run(() => officeApi.deleteCategory(target.id));
    if (ok) {
      // The list it was selected from no longer contains it, and `current`
      // falls back to the first category on its own.
      if (categoryId === target.id) setCategoryId(null);
      setEditingCategory(null);
    }
  }, [run, editingCategory, categoryId]);

  return (
    <ManageShell>
      {loading && !menu ? (
        <p className="text-slate-400">กำลังโหลด…</p>
      ) : !menu ? (
        <p className="text-slate-400">ยังโหลดเมนูไม่ได้</p>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          <nav aria-label="หมวด" className="lg:w-72">
            <ul className="space-y-2">
              {categories.map((category, index) => (
                <li key={category.id} className="flex items-stretch gap-1">
                  <MoveButtons
                    label={category.name}
                    busy={busy}
                    isFirst={index === 0}
                    isLast={index === categories.length - 1}
                    onMove={(direction) =>
                      void run(() => officeApi.moveCategory(category.id, direction))
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setCategoryId(category.id)}
                    aria-pressed={current?.id === category.id}
                    className={`btn h-14 min-w-0 flex-1 justify-between px-4 text-left ${
                      current?.id === category.id
                        ? 'bg-brand-600 text-white'
                        : 'bg-white text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <span className="truncate">
                      {category.icon ? `${category.icon} ` : ''}
                      {category.name}
                      {category.isActive ? '' : ' · ปิดอยู่'}
                    </span>
                    <span className="tnum opacity-70">{category.items.length}</span>
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => setEditingCategory('NEW')}
              className="btn mt-3 h-12 w-full bg-white px-4 text-slate-700 ring-1 ring-slate-200
                hover:bg-slate-50"
            >
              + เพิ่มหมวด
            </button>
            <p className="mt-2 text-sm text-slate-500">
              ลำดับตรงนี้คือลำดับแท็บบนหน้าสั่งอาหาร · หมวดแรกคือหมวดที่เปิดอยู่ตอนเปิดจอ
            </p>
          </nav>

          <div className="flex-1">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-600">
                {current ? current.name : 'ยังไม่มีหมวด'}
              </h2>
              {current ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingCategory(current)}
                    className="btn h-12 bg-white px-5 text-slate-700 ring-1 ring-slate-200
                      hover:bg-slate-50"
                  >
                    แก้ไขหมวด
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing({ item: null })}
                    className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500"
                  >
                    + เพิ่มเมนู
                  </button>
                </div>
              ) : null}
            </div>

            {current ? (
              <ItemTable
                category={current}
                busy={busy}
                onEdit={(item) => setEditing({ item })}
                onMove={(item, direction) =>
                  void run(() => officeApi.moveMenuItem(item.id, direction))
                }
              />
            ) : null}
          </div>
        </div>
      )}

      {editing && menu && current ? (
        <MenuItemEditor
          item={editingItem}
          categoryId={current.id}
          categories={menu.categories}
          groups={menu.modifierGroups}
          ingredients={menu.ingredients}
          stations={menu.stations}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveItem}
          onDelete={removeItem}
          onSaveRecipe={saveRecipe}
        />
      ) : null}

      {editingCategory ? (
        <CategoryEditor
          category={editingCategory === 'NEW' ? null : editingCategory}
          busy={busy}
          onClose={() => setEditingCategory(null)}
          onSave={saveCategory}
          onDelete={removeCategory}
        />
      ) : null}
    </ManageShell>
  );
}

/* ------------------------------------------------------------------ */

/**
 * ↑ / ↓, named after what they move.
 *
 * The label carries the row's name because a screen with twelve identical
 * "เลื่อนขึ้น" buttons tells a screen reader nothing, and because it is the
 * only way a test can say WHICH row it pressed.
 */
function MoveButtons({
  label,
  busy,
  isFirst,
  isLast,
  onMove,
}: {
  label: string;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: MoveDirection) => void;
}): React.ReactElement {
  return (
    // Side by side, never stacked: two 44px targets one above the other need
    // 88px of height the category row does not have, and shrinking them to fit
    // is how ↑ gets pressed when ↓ was meant.
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`เลื่อน ${label} ขึ้น`}
        disabled={busy || isFirst}
        onClick={() => onMove('UP')}
        className="btn h-11 w-11 bg-white text-lg ring-1 ring-slate-200 disabled:opacity-30"
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`เลื่อน ${label} ลง`}
        disabled={busy || isLast}
        onClick={() => onMove('DOWN')}
        className="btn h-11 w-11 bg-white text-lg ring-1 ring-slate-200 disabled:opacity-30"
      >
        ↓
      </button>
    </div>
  );
}

function ItemTable({
  category,
  busy,
  onEdit,
  onMove,
}: {
  category: AdminMenuCategoryDto;
  busy: boolean;
  onEdit: (item: AdminMenuItemDto) => void;
  onMove: (item: AdminMenuItemDto, direction: MoveDirection) => void;
}): React.ReactElement {
  if (category.items.length === 0) {
    return <p className="text-slate-400">หมวดนี้ยังไม่มีเมนู</p>;
  }

  return (
    <ul className="space-y-2">
      {category.items.map((item, index) => {
        const bp = item.hasRecipe ? foodCostBp(item.priceSatang, item.costSatang) : null;
        return (
          <li key={item.id} className="flex items-stretch gap-2">
            <MoveButtons
              label={item.name}
              busy={busy}
              isFirst={index === 0}
              isLast={index === category.items.length - 1}
              onMove={(direction) => onMove(item, direction)}
            />
            <button
              type="button"
              onClick={() => onEdit(item)}
              className={`btn h-auto min-w-0 flex-1 flex-col items-stretch gap-2 rounded-2xl p-4
                text-left
                ${item.isActive ? 'bg-white hover:bg-slate-50' : 'bg-slate-200/70 hover:bg-slate-200'}`}
            >
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-lg font-semibold">{item.name}</span>
                {item.subcategory ? (
                  <span className="text-sm text-slate-500">{item.subcategory}</span>
                ) : null}
                {!item.isActive ? <Badge tone="slate">เลิกขาย</Badge> : null}
                {item.isActive && !item.isAvailable ? <Badge tone="amber">หมดวันนี้</Badge> : null}
                {!item.hasRecipe ? <Badge tone="amber">ยังไม่ได้ใส่สูตร</Badge> : null}
              </div>

              <div className="tnum flex flex-wrap gap-x-6 gap-y-1 text-slate-700">
                <span>
                  ราคา <span className="font-semibold">{formatSatang(item.priceSatang)}</span>
                </span>
                <span>
                  ต้นทุน{' '}
                  <span className="font-semibold">
                    {item.hasRecipe ? formatSatang(item.costSatang) : '—'}
                  </span>
                </span>
                <span>
                  กำไร{' '}
                  <span className="font-semibold">
                    {item.hasRecipe ? formatSatang(item.priceSatang - item.costSatang) : '—'}
                  </span>
                </span>
                {bp !== null ? (
                  <span className={bp > HIGH_FOOD_COST_BP ? 'font-semibold text-red-700' : ''}>
                    ต้นทุน {formatPercentBp(bp)}
                  </span>
                ) : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Adding or renaming a category.
 *
 * SUBCATEGORIES ARE TYPED ONE PER LINE rather than as chips with an add button.
 * They are a short list a shop writes once ("หมู เนื้อ ไก่"), and a textarea is
 * the one control where fixing a typo does not mean deleting and retyping a
 * chip. The server refuses to drop one that dishes are still filed under, and
 * that refusal is shown as-is.
 *
 * DELETE IS OFFERED, unlike a dish or a table, because a category holds no
 * history of its own — the server refuses while it still has dishes in it, and
 * an empty category is a typo. "ปิดอยู่" is here too, for a หมวดเทศกาล that
 * comes back next year.
 */
function CategoryEditor({
  category,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  category: AdminMenuCategoryDto | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: MenuCategoryRequest) => Promise<void>;
  onDelete: () => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState(category?.name ?? '');
  const [icon, setIcon] = useState(category?.icon ?? '');
  const [subcategories, setSubcategories] = useState((category?.subcategories ?? []).join('\n'));
  const [isActive, setActive] = useState(category?.isActive ?? true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const itemCount = category?.items.length ?? 0;
  const ready = name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={category ? 'แก้ไขหมวด' : 'เพิ่มหมวด'}
        className="w-full max-w-lg rounded-3xl bg-white p-6"
      >
        <h2 className="text-2xl font-bold">
          {category ? `แก้ไขหมวด ${category.name}` : 'เพิ่มหมวดใหม่'}
        </h2>

        <div className="mt-5 grid gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">ชื่อหมวด</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">ไอคอน</span>
            <input
              className="input"
              value={icon}
              onChange={(event) => setIcon(event.target.value)}
            />
            <span className="text-sm text-slate-400">
              เว้นว่างได้ · ใส่อีโมจิสั้น ๆ เช่น 🍜 เพื่อให้หาแท็บเจอเร็วขึ้น
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">หมวดย่อย (บรรทัดละ 1 อัน)</span>
            <textarea
              className="input h-28 py-2"
              value={subcategories}
              onChange={(event) => setSubcategories(event.target.value)}
            />
            <span className="text-sm text-slate-400">
              เว้นว่างได้ · ถ้ามีเมนูอยู่ในหมวดย่อยไหน จะลบหมวดย่อยนั้นไม่ได้จนกว่าจะย้ายเมนูออก
            </span>
          </label>

          <label className="flex min-h-11 items-center gap-3 rounded-xl bg-slate-50 px-3">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setActive(event.target.checked)}
              className="h-5 w-5"
            />
            <span>เปิดใช้หมวดนี้</span>
          </label>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn h-14 bg-slate-100 px-8 text-slate-700 hover:bg-slate-200"
          >
            ยกเลิก
          </button>

          {category ? (
            itemCount > 0 ? (
              <span className="flex items-center text-sm text-slate-500">
                มีเมนูอยู่ {itemCount} รายการ ลบไม่ได้
              </span>
            ) : confirmingDelete ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={busy}
                className="btn h-14 bg-red-600 px-6 text-white disabled:opacity-40"
              >
                ยืนยันลบหมวด
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="btn h-14 bg-red-50 px-6 text-red-800 hover:bg-red-100"
              >
                ลบหมวด
              </button>
            )
          ) : null}

          <button
            type="button"
            disabled={!ready || busy}
            onClick={() =>
              void onSave({
                name: name.trim(),
                icon: icon.trim() === '' ? null : icon.trim(),
                subcategories: subcategories
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== ''),
                isActive,
              })
            }
            className="btn h-14 bg-brand-600 px-8 text-white hover:bg-brand-700 disabled:opacity-40"
          >
            บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: 'slate' | 'amber';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm ${
        tone === 'amber' ? 'bg-amber-100 text-amber-900' : 'bg-slate-300 text-slate-800'
      }`}
    >
      {children}
    </span>
  );
}

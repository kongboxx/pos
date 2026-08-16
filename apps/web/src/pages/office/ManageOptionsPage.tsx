/**
 * Option groups — เส้น / น้ำซุป / ขนาด / เพิ่มเติม / ไม่ใส่.
 *
 * Until now these could only be changed by editing the seed or opening Prisma
 * Studio, which meant "เพิ่มไข่ดาว 10 บาท" was a developer task.
 *
 * An option carries a PRICE difference and a COST difference, and only the
 * first is typed. The second comes from the option's own recipe, where a
 * negative quantity means the option takes something back out — see
 * RecipeEditor, and the seed's "บะหมี่" for the case that made it necessary.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  formatSatang,
  parseBahtToSatang,
  type AdminModifierDto,
  type AdminModifierGroupDto,
  type ModifierRequest,
  type RecipeLineInput,
} from '@pos/shared';
import { officeApi } from '../../api-office.js';
import { ManageShell } from '../../components/office/ManageShell.js';
import { RecipeEditor } from '../../components/office/RecipeEditor.js';
import { useManage } from '../../manage-store.js';

export function ManageOptionsPage(): React.ReactElement {
  const menu = useManage((state) => state.menu);
  const loading = useManage((state) => state.loading);
  const busy = useManage((state) => state.busy);
  const load = useManage((state) => state.load);
  const run = useManage((state) => state.run);

  const [groupId, setGroupId] = useState<string | null>(null);
  const [openModifierId, setOpenModifierId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  const groups = menu?.modifierGroups ?? [];
  const current = groups.find((group) => group.id === groupId) ?? groups[0] ?? null;

  const addModifier = useCallback(async () => {
    if (!current || newName.trim() === '') return;
    const priceDeltaSatang = parseBahtToSatang(newPrice === '' ? '0' : newPrice);
    if (priceDeltaSatang === null) return;
    const ok = await run(() =>
      officeApi.createModifier(current.id, {
        name: newName.trim(),
        priceDeltaSatang,
        isDefault: false,
        isAvailable: true,
        sortOrder: current.modifiers.length,
      }),
    );
    if (ok) {
      setNewName('');
      setNewPrice('');
    }
  }, [current, newName, newPrice, run]);

  const updateModifier = useCallback(
    (modifier: AdminModifierDto, changes: Partial<ModifierRequest>): Promise<boolean> =>
      run(() =>
        officeApi.updateModifier(modifier.id, {
          name: modifier.name,
          priceDeltaSatang: modifier.priceDeltaSatang,
          isDefault: modifier.isDefault,
          isAvailable: modifier.isAvailable,
          sortOrder: modifier.sortOrder,
          ...changes,
        }),
      ),
    [run],
  );

  const saveRecipe = useCallback(
    (modifierId: string, lines: RecipeLineInput[]): Promise<boolean> =>
      run(() => officeApi.saveModifierRecipe(modifierId, { lines })),
    [run],
  );

  return (
    <ManageShell>
      {loading && !menu ? (
        <p className="text-slate-400">กำลังโหลด…</p>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          <nav aria-label="กลุ่มตัวเลือก" className="lg:w-64">
            <ul className="space-y-2">
              {groups.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setGroupId(group.id);
                      setOpenModifierId(null);
                    }}
                    aria-pressed={current?.id === group.id}
                    className={`btn h-14 w-full justify-between px-4 text-left ${
                      current?.id === group.id
                        ? 'bg-brand-600 text-white'
                        : 'bg-white text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <span>{group.name}</span>
                    <span className="tnum opacity-70">{group.modifiers.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex-1">
            {current ? (
              <>
                <GroupSummary group={current} />

                <ul className="mt-4 space-y-2">
                  {current.modifiers.map((modifier) => (
                    <li key={modifier.id} className="rounded-2xl bg-white p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="min-w-40 flex-1 text-lg font-medium">
                          {modifier.name}
                          {modifier.isDefault ? (
                            <span className="ml-2 rounded-full bg-brand-100 px-3 py-1 text-sm text-brand-900">
                              ค่าเริ่มต้น
                            </span>
                          ) : null}
                        </span>
                        <span className="tnum w-28 text-right">
                          {signed(modifier.priceDeltaSatang)}
                        </span>
                        <span className="tnum w-32 text-right text-slate-600">
                          ต้นทุน{' '}
                          {modifier.hasRecipe ? signed(modifier.costDeltaSatang) : '— ไม่มีสูตร'}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            void updateModifier(modifier, { isAvailable: !modifier.isAvailable })
                          }
                          disabled={busy}
                          className={`btn h-11 px-4 disabled:opacity-50 ${
                            modifier.isAvailable
                              ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                              : 'bg-amber-100 text-amber-900 hover:bg-amber-200'
                          }`}
                        >
                          {modifier.isAvailable ? 'มีอยู่' : 'หมด'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenModifierId((current$) =>
                              current$ === modifier.id ? null : modifier.id,
                            )
                          }
                          className="btn h-11 bg-slate-100 px-4 text-slate-700 hover:bg-slate-200"
                        >
                          สูตร
                        </button>
                        {modifier.soldCount === 0 ? (
                          <button
                            type="button"
                            onClick={() => void run(() => officeApi.deleteModifier(modifier.id))}
                            disabled={busy}
                            className="btn h-11 bg-red-50 px-4 text-red-800 hover:bg-red-100 disabled:opacity-50"
                          >
                            ลบ
                          </button>
                        ) : null}
                      </div>

                      {openModifierId === modifier.id ? (
                        <div className="mt-3">
                          <RecipeEditor
                            lines={modifier.recipe}
                            ingredients={menu?.ingredients ?? []}
                            allowNegative
                            busy={busy}
                            onSave={(lines) => saveRecipe(modifier.id, lines)}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>

                <form
                  aria-label="เพิ่มตัวเลือก"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addModifier();
                  }}
                  className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4"
                >
                  <label className="flex-1">
                    <span className="text-sm text-slate-600">ชื่อตัวเลือกใหม่</span>
                    <input
                      type="text"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      className="mt-1 h-12 w-full rounded-xl border border-slate-300 px-3 text-lg"
                    />
                  </label>
                  <label className="w-40">
                    <span className="text-sm text-slate-600">บวก/ลบราคา (บาท)</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={newPrice}
                      onChange={(event) => setNewPrice(event.target.value)}
                      placeholder="0"
                      className="tnum mt-1 h-12 w-full rounded-xl border border-slate-300 px-3 text-right text-lg"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500 disabled:opacity-50"
                  >
                    เพิ่ม
                  </button>
                </form>
              </>
            ) : (
              <p className="text-slate-400">ยังไม่มีกลุ่มตัวเลือก</p>
            )}
          </div>
        </div>
      )}
    </ManageShell>
  );
}

function GroupSummary({ group }: { group: AdminModifierGroupDto }): React.ReactElement {
  return (
    <div className="rounded-2xl bg-white p-4">
      <h2 className="text-lg font-semibold">{group.name}</h2>
      <p className="mt-1 text-slate-600">
        {group.isRequired ? 'บังคับเลือก' : 'เลือกหรือไม่ก็ได้'} · เลือกได้ {group.minSelect}–
        {group.maxSelect} อย่าง
        {group.isNegative ? ' · เป็นกลุ่ม "ไม่ใส่"' : ''} · ใช้ใน {group.usedByItemCount} เมนู
      </p>
    </div>
  );
}

/** A delta reads wrong without its sign: "5.00" and "-5.00" are opposite answers. */
function signed(satang: number): string {
  if (satang === 0) return '±0.00';
  return satang > 0 ? `+${formatSatang(satang)}` : `-${formatSatang(Math.abs(satang))}`;
}

export { signed as formatDelta };

/**
 * Taking an order.
 *
 * The design target from the brief: ordering one bowl must be FASTER than
 * writing it on a pad.
 *
 * An item with no options (a drink) rings up on a single tap. An item WITH
 * options opens the sheet with the shop's defaults already chosen, so the
 * ordinary bowl is tap-item, tap-confirm — two taps, and the kitchen gets
 * เส้นเล็ก น้ำใส spelled out instead of assumed.
 *
 * Tapping the same button again bumps the quantity on the line that is already
 * there rather than stacking a second identical row. "Already there" means the
 * same item AND the same options AND the same note — see lineSignature.
 *
 * SINCE STEP 4 EVERY EDIT ON THIS SCREEN IS LOCAL FIRST. The bill is read from
 * and written to IndexedDB, and the server is told afterwards by the sync
 * queue. Nothing on this page waits for a round trip, which is why it behaves
 * identically with the wifi off — and why the two things that genuinely cannot
 * be done offline (printing, and taking the money) are the only controls that
 * lock. See the note on the pay button.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  defaultSelectionFor,
  formatModifierSummary,
  formatSatang,
  Permission,
  WIDTH_80MM,
  type MenuCategoryDto,
  type MenuItemDto,
  type ModifierGroupDto,
  type OrderDto,
  type OrderLineDto,
  type TableDto,
} from '@pos/shared';
import { api } from '../../api-client.js';
import {
  MergeBillDialog,
  MoveTableDialog,
  SplitBillDialog,
} from '../../components/BillMoveDialog.js';
import { DiscountDialog } from '../../components/DiscountDialog.js';
import { ModifierSheet } from '../../components/ModifierSheet.js';
import { PaymentDialog } from '../../components/PaymentDialog.js';
import { VoidDialog } from '../../components/VoidDialog.js';
import { onLiveEvent } from '../../live-store.js';
import { putOrder } from '../../offline/db.js';
import { addOrBumpLine, readFloorPlan, readMenu, runMutation } from '../../offline/repository.js';
import { useSync } from '../../offline/sync-store.js';
import { useLocalOrder } from '../../offline/use-local-order.js';
import { useSession } from '../../session.js';
import { path } from '@pos/web-kit';

/** What the sheet is currently working on: a new line, or an existing one. */
type SheetState =
  | { mode: 'add'; item: MenuItemDto; selection: string[]; qty: number; note: string | null }
  | {
      mode: 'edit';
      item: MenuItemDto;
      line: OrderLineDto;
      selection: string[];
      qty: number;
      note: string | null;
    };

export function OrderPage(): React.ReactElement {
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  const branch = useSession((state) => state.branch);
  const canManageMenu = useSession((state) => state.can(Permission.MANAGE_MENU));
  const online = useSync((state) => state.online);

  const { order, loading } = useLocalOrder(orderId);
  const [menu, setMenu] = useState<MenuCategoryDto[] | null>(null);
  const [groupsById, setGroupsById] = useState<Map<string, ModifierGroupDto>>(new Map());
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [voiding, setVoiding] = useState<OrderLineDto | null>(null);
  const [discounting, setDiscounting] = useState(false);
  /**
   * The three bill-shuffling dialogs.
   *
   * Two of them hold the LIST they need rather than a boolean, because both are
   * opened by a request: the floor plan for ย้ายโต๊ะ and the other open bills for
   * รวมบิล. Fetching on open rather than on page load keeps a screen that is
   * mostly used for typing orders from asking two extra questions every time it
   * is drawn.
   */
  const [moving, setMoving] = useState<TableDto[] | null>(null);
  const [merging, setMerging] = useState<OrderDto[] | null>(null);
  const [splitting, setSplitting] = useState(false);

  const loadMenu = useCallback(async () => {
    const result = await readMenu();
    if (!result) return;
    setMenu(result.categories);
    setGroupsById(new Map(result.modifierGroups.map((group) => [group.id, group])));
    setActiveCategoryId((current) => current ?? result.categories[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  /**
   * The menu changed on the management screen while this bill is open.
   *
   * Usually that is "ลูกชิ้นทอดหมดแล้ว" pressed mid-service. Without this the
   * button here keeps looking available until the cashier happens to walk back
   * to the floor plan and return — and the kitchen gets an order for something
   * the shop ran out of an hour ago.
   */
  useEffect(
    () =>
      onLiveEvent((event) => {
        if (event.type === 'menu') void loadMenu();
      }),
    [loadMenu],
  );

  /**
   * Applies a change to the local bill and hands it to the sync queue.
   *
   * Note what is NOT here: no "busy" flag around the menu. Writes go to the
   * device and are serialised in the repository, so the grid never has to
   * refuse a tap — which matters most during exactly the rush that would
   * otherwise trigger it.
   */
  const apply = useCallback(
    async (mutation: Parameters<typeof runMutation>[0]): Promise<boolean> => {
      const result = await runMutation(mutation);
      if (result.ok) {
        setError(null);
        return true;
      }
      setError(result.error);
      return false;
    },
    [],
  );

  /** The groups this item offers, in the item's own order. */
  const groupsFor = useCallback(
    (item: MenuItemDto): ModifierGroupDto[] =>
      item.groupIds.map((id) => groupsById.get(id)).filter((g): g is ModifierGroupDto => !!g),
    [groupsById],
  );

  /**
   * Adds the line, or bumps the one that is already exactly this bowl.
   *
   * The "is it already there" decision belongs in the repository, not here: it
   * has to read the bill as it stands at that instant, and this component may
   * be a render or two behind when someone is ringing up four bowls in three
   * seconds.
   */
  const commit = useCallback(
    (item: MenuItemDto, modifierIds: string[], qty: number, note: string | null) => {
      if (!order) return;
      void (async () => {
        const result = await addOrBumpLine({
          orderId: order.id,
          menuItemId: item.id,
          modifierIds,
          qty,
          note,
        });
        setError(result.ok ? null : result.error);
      })();
    },
    [order],
  );

  const pickItem = useCallback(
    (item: MenuItemDto) => {
      const groups = groupsFor(item);
      // A drink has no groups — no sheet, no extra tap. A note on one is added
      // afterwards by tapping the line on the bill, which keeps the ordinary
      // case at one tap: notes are the exception, and paying for them on every
      // น้ำเปล่า would be the wrong trade.
      if (groups.length === 0) {
        commit(item, [], 1, null);
        return;
      }
      setSheet({ mode: 'add', item, selection: defaultSelectionFor(groups), qty: 1, note: null });
    },
    [groupsFor, commit],
  );

  /**
   * Opens the sheet on a line that is already on the bill.
   *
   * Since the note box exists, an item with NO option groups opens it too —
   * otherwise "เผ็ดน้อย" would be impossible on exactly the dishes that have
   * nothing else to say about them.
   */
  const editLine = useCallback(
    (line: OrderLineDto) => {
      if (line.firedAt || line.voidedAt) return;
      const item = menu?.flatMap((c) => c.items).find((i) => i.id === line.menuItemId);
      if (!item) return;
      setSheet({
        mode: 'edit',
        item,
        line,
        selection: line.modifiers.map((modifier) => modifier.modifierId),
        qty: line.qty,
        note: line.note,
      });
    },
    [menu],
  );

  const confirmSheet = useCallback(
    (modifierIds: string[], qty: number, note: string | null) => {
      if (!order || !sheet) return;
      if (sheet.mode === 'edit') {
        void apply({
          kind: 'updateLine',
          orderId: order.id,
          lineId: sheet.line.id,
          qty,
          modifierIds,
          note,
        });
      } else {
        commit(sheet.item, modifierIds, qty, note);
      }
      setSheet(null);
    },
    [order, sheet, apply, commit],
  );

  const changeQty = useCallback(
    (line: OrderLineDto, delta: number) => {
      if (!order) return;
      const next = line.qty + delta;
      if (next <= 0) {
        void apply({ kind: 'removeLine', orderId: order.id, lineId: line.id });
      } else {
        void apply({
          kind: 'updateLine',
          orderId: order.id,
          lineId: line.id,
          qty: next,
          note: line.note,
        });
      }
    },
    [order, apply],
  );

  /**
   * Sends everything not yet fired to the kitchen.
   *
   * The server's answer is written straight to the device rather than queued:
   * this only runs online, and the bill that comes back carries the `firedAt`
   * stamps that lock those lines against further editing. Going through the
   * outbox instead would leave the screen briefly showing lines as editable
   * that the kitchen is already cooking.
   */
  const fire = useCallback(async () => {
    if (!order) return;
    setBusy(true);
    const result = await api.fireOrder(order.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await putOrder(result.data.order, false);
    setError(null);
    setNotice(`ส่งครัวแล้ว — ${result.data.stations.join(' · ')}`);
  }, [order]);

  /**
   * Opening ย้ายโต๊ะ and รวมบิล needs a list only the server has.
   *
   * The floor plan comes from the CACHE-AWARE reader rather than the API
   * directly, so a tablet whose wifi blinked between drawing this screen and
   * pressing the button still gets a list of tables to look at. The move itself
   * is refused offline by the button, not by this.
   */
  const startMove = useCallback(async () => {
    setError(null);
    const floor = await readFloorPlan();
    if (floor.tables.length === 0) {
      setError('ยังไม่มีโต๊ะในระบบ');
      return;
    }
    setMoving(floor.tables);
  }, []);

  const startMerge = useCallback(async () => {
    setError(null);
    const result = await api.openOrders();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMerging(result.data.orders);
  }, []);

  const printCheck = useCallback(async () => {
    if (!order) return;
    setBusy(true);
    const result = await api.printCheck(order.id, WIDTH_80MM);
    setBusy(false);
    if (result.ok) setNotice('ส่งใบแจ้งยอดเข้าคิวพิมพ์แล้ว');
    else setError(result.error);
  }, [order]);

  const leave = useCallback(async () => {
    // An untouched bill would otherwise hold the table hostage until someone
    // notices. Closing it on the way out is the behaviour staff expect, and it
    // works offline like everything else here.
    if (order && order.lines.length === 0) {
      await runMutation({ kind: 'cancelOrder', orderId: order.id });
    }
    navigate(path.tables);
  }, [order, navigate]);

  const activeCategory = useMemo(
    () => menu?.find((category) => category.id === activeCategoryId) ?? menu?.[0] ?? null,
    [menu, activeCategoryId],
  );

  if (!order) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100">
        <p className="text-slate-500">{loading ? 'กำลังโหลดบิล…' : 'ไม่พบบิลนี้'}</p>
      </div>
    );
  }

  // A voided line stays on the bill as evidence but is not a line to sell,
  // print or charge for — so "empty" means nothing LIVE on it.
  const activeLines = order.lines.filter((line) => !line.voidedAt);
  const isEmpty = activeLines.length === 0;
  const unfired = activeLines.filter((line) => !line.firedAt);
  // Three things need the server, for two different reasons.
  //
  // Printing and paying: a receipt number MUST come from one place. Two tablets
  // each numbering their own receipts offline would issue the same number twice
  // in a day, which is the one thing rule #9 exists to prevent.
  //
  // Sending to the kitchen: the kitchen screen is a DIFFERENT DEVICE. A ticket
  // that exists only in this tablet's memory is a ticket nobody can cook, and
  // pretending otherwise would have a cashier tell a customer their food was
  // ordered when it was not.
  //
  // Everything else on this screen still works with the wifi off.
  const settlementBlocked = !online;

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <button type="button" onClick={() => void leave()} className="btn h-12 bg-slate-100 px-5">
          ← ผังโต๊ะ
        </button>
        <div className="text-center">
          <p className="text-lg font-bold">
            {order.tableName ? `โต๊ะ ${order.tableName}` : 'กลับบ้าน'}
          </p>
          <p className="tnum text-sm text-slate-500">
            {order.orderNo ? `บิล ${order.orderNo}` : 'ยังไม่มีเลขบิล — จะได้เมื่อส่งเข้าระบบ'}
          </p>
        </div>
        <p className="text-sm text-slate-500">{branch?.branchCode}</p>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* menu — labelled because the same dish name appears both here and on
            the bill, and "the น้ำเปล่า button" has to mean one of them. */}
        <section aria-label="เมนู" className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2">
            {menu?.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategoryId(category.id)}
                className={`btn h-12 whitespace-nowrap ${
                  category.id === activeCategory?.id
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-700'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>

          {/* A shop set up with `pnpm db:seed` starts with no menu at all, and
              an empty grid here looks exactly like a screen that failed to
              load. Says which it is, and — for whoever is allowed to fix it —
              where to go. */}
          {menu !== null && menu.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
              <p className="text-lg text-slate-500">ยังไม่มีเมนูในระบบ</p>
              {canManageMenu ? (
                <button
                  type="button"
                  onClick={() => navigate(path.menu)}
                  className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500"
                >
                  ไปเพิ่มเมนู
                </button>
              ) : (
                <p className="text-slate-400">ให้เจ้าของร้านเพิ่มรายการอาหารก่อนถึงจะขายได้</p>
              )}
            </div>
          ) : (
            <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3 lg:grid-cols-4">
              {activeCategory?.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={!item.isAvailable}
                  onClick={() => pickItem(item)}
                  className="btn h-24 flex-col gap-1 bg-white text-center shadow-sm ring-1
                    ring-slate-200 hover:bg-brand-50 disabled:bg-slate-100 disabled:text-slate-400"
                >
                  <span className="line-clamp-2 font-medium">{item.name}</span>
                  <span className="tnum text-slate-500">
                    {item.isAvailable ? formatSatang(item.priceSatang) : 'หมด'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* bill */}
        {/* Wide enough that a line with its options spelled out still fits. */}
        <aside className="flex w-[26rem] flex-col border-l border-slate-200 bg-white">
          <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">รายการในบิล</h2>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Not `isEmpty`: a bill whose only line was voided still has to
                show that line, struck through. It is the evidence. */}
            {order.lines.length === 0 ? (
              <p className="p-6 text-center text-slate-400">
                ยังไม่มีรายการ
                <br />
                แตะเมนูด้านซ้ายเพื่อเพิ่ม
              </p>
            ) : (
              order.lines.map((line) => (
                <BillLine
                  key={line.id}
                  line={line}
                  canVoid={online}
                  onEdit={() => editLine(line)}
                  onDecrease={() => changeQty(line, -1)}
                  onIncrease={() => changeQty(line, 1)}
                  onVoid={() => setVoiding(line)}
                />
              ))
            )}
          </div>

          {error ? (
            <p role="alert" className="mx-4 mb-2 rounded-xl bg-red-50 p-3 text-sm text-red-900">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="mx-4 mb-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">
              {notice}
            </p>
          ) : null}

          <div className="border-t border-slate-200 p-4">
            {/* The gross and the discount only appear when there IS one. A
                shop that never discounts should not have a "ส่วนลด 0.00" line
                on the till inviting a customer to lean over and ask. */}
            {order.discountSatang > 0 ? (
              <>
                <div className="flex items-baseline justify-between text-slate-500">
                  <span>รวม</span>
                  <span className="tnum">
                    {formatSatang(order.totalSatang + order.discountSatang)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between text-emerald-700">
                  <span>ส่วนลด</span>
                  <span className="tnum">-{formatSatang(order.discountSatang)}</span>
                </div>
              </>
            ) : null}

            <div className="flex items-baseline justify-between">
              <span className="text-lg">รวมทั้งสิ้น</span>
              <span className="tnum text-3xl font-bold">{formatSatang(order.totalSatang)}</span>
            </div>

            {settlementBlocked ? (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                ออฟไลน์อยู่ — ส่งครัว พิมพ์บิล และรับเงินไม่ได้
                ส่งครัวไม่ได้เพราะจอครัวเป็นคนละเครื่อง
                ส่วนเลขที่ใบเสร็จต้องออกจากเซิร์ฟเวอร์เพื่อไม่ให้เลขซ้ำกับเครื่องอื่น
                รับออร์เดอร์ต่อได้ตามปกติ แล้วค่อยส่งครัวเมื่อเน็ตกลับมา
              </p>
            ) : null}

            <div className="mt-4 grid gap-2">
              {/* First and biggest, because it is the button pressed most often
                  and the one whose delay a customer feels. It only appears when
                  there is something new to send, so it cannot be tapped twice
                  out of doubt. */}
              {unfired.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void fire()}
                  disabled={busy || settlementBlocked}
                  className="btn h-16 bg-brand-600 text-xl text-white hover:bg-brand-500
                    disabled:opacity-40"
                >
                  ส่งครัว ({unfired.length})
                </button>
              ) : null}
              {/* Below พิมพ์ใบแจ้งยอด and above รับเงิน, which is the order it
                  happens in: the customer sees the bill, asks, and then pays.
                  Disabled offline for the same reason as รับเงิน — the
                  approver's PIN can only be checked by the server. */}
              <button
                type="button"
                onClick={() => void printCheck()}
                disabled={isEmpty || busy || settlementBlocked}
                className="btn h-14 bg-slate-100 text-slate-800 hover:bg-slate-200 disabled:opacity-40"
              >
                พิมพ์ใบแจ้งยอด
              </button>
              <button
                type="button"
                onClick={() => setDiscounting(true)}
                disabled={isEmpty || busy || settlementBlocked}
                className="btn h-14 bg-slate-100 text-slate-800 hover:bg-slate-200 disabled:opacity-40"
              >
                {order.discountSatang > 0 ? 'แก้ส่วนลด' : 'ลดราคา'}
              </button>
              <button
                type="button"
                onClick={() => setPaying(true)}
                disabled={isEmpty || busy || settlementBlocked}
                className="btn h-16 bg-emerald-600 text-xl text-white hover:bg-emerald-500
                  disabled:opacity-40"
              >
                รับเงิน
              </button>

              {/* Below รับเงิน, and smaller, because these are the errands of a
                  busy hour rather than the point of the screen. Offline they
                  lock with everything else: the floor is shared, and two
                  tablets rearranging it with no network would disagree. */}
              <div className="mt-1 grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => void startMove()}
                  disabled={busy || !online || order.channel !== 'DINE_IN'}
                  className="btn h-12 bg-slate-100 text-slate-700 hover:bg-slate-200
                    disabled:opacity-40"
                >
                  ย้ายโต๊ะ
                </button>
                <button
                  type="button"
                  onClick={() => void startMerge()}
                  disabled={busy || !online}
                  className="btn h-12 bg-slate-100 text-slate-700 hover:bg-slate-200
                    disabled:opacity-40"
                >
                  รวมบิล
                </button>
                <button
                  type="button"
                  onClick={() => setSplitting(true)}
                  disabled={isEmpty || busy || !online}
                  className="btn h-12 bg-slate-100 text-slate-700 hover:bg-slate-200
                    disabled:opacity-40"
                >
                  แยกบิล
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {sheet ? (
        <ModifierSheet
          itemName={sheet.item.name}
          basePriceSatang={sheet.item.priceSatang}
          groups={groupsFor(sheet.item)}
          initialSelection={sheet.selection}
          initialQty={sheet.qty}
          mode={sheet.mode}
          busy={busy}
          noteEnabled
          initialNote={sheet.note}
          onCancel={() => setSheet(null)}
          onConfirm={confirmSheet}
        />
      ) : null}

      {voiding ? (
        <VoidDialog
          order={order}
          line={voiding}
          onClose={() => setVoiding(null)}
          onVoided={() => {
            setVoiding(null);
            setNotice('ยกเลิกรายการแล้ว — แจ้งครัวเรียบร้อย');
          }}
        />
      ) : null}

      {discounting ? (
        <DiscountDialog
          order={order}
          onClose={() => setDiscounting(false)}
          onDone={(message) => {
            setDiscounting(false);
            setNotice(message);
          }}
        />
      ) : null}

      {paying ? (
        <PaymentDialog
          order={order}
          onClose={() => setPaying(false)}
          onPaid={() => navigate(path.tables)}
        />
      ) : null}

      {moving ? (
        <MoveTableDialog
          order={order}
          tables={moving}
          onClose={() => setMoving(null)}
          onDone={(message) => {
            setMoving(null);
            setNotice(message);
          }}
        />
      ) : null}

      {merging ? (
        <MergeBillDialog
          order={order}
          candidates={merging}
          onClose={() => setMerging(null)}
          onDone={(message) => {
            setMerging(null);
            setNotice(message);
          }}
        />
      ) : null}

      {splitting ? (
        <SplitBillDialog
          order={order}
          onClose={() => setSplitting(false)}
          onDone={(message, newOrderId) => {
            setSplitting(false);
            setNotice(message);
            // Straight to the half that is about to be paid — splitting is
            // something a cashier does with a customer's money already out.
            navigate(path.order(newOrderId));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One row of the bill, in one of three states.
 *
 * Not fired: fully editable — tap the name to change the options, +/− for the
 * quantity. This is the ordinary case and it must stay the fastest.
 *
 * Fired: the kitchen owns it. The steppers are GONE rather than disabled, so
 * nobody stabs at a dead button during a rush; the only thing offered is
 * "ยกเลิก", which is honest about what taking it back now costs.
 *
 * Voided: struck through and left in place. It is the evidence (rule #8).
 */
function BillLine({
  line,
  canVoid,
  onEdit,
  onDecrease,
  onIncrease,
  onVoid,
}: {
  line: OrderLineDto;
  /** Voiding needs the approver's PIN checked by the server. */
  canVoid: boolean;
  onEdit: () => void;
  onDecrease: () => void;
  onIncrease: () => void;
  onVoid: () => void;
}): React.ReactElement {
  const summary = formatModifierSummary(line.modifiers.map((modifier) => modifier.nameSnapshot));
  const voided = line.voidedAt !== null;
  const fired = line.firedAt !== null;

  return (
    <div
      className={`flex items-center gap-2 border-b border-slate-100 px-3 py-2 ${
        voided ? 'bg-slate-50 text-slate-400' : ''
      }`}
    >
      {/* The name block is the edit target: it is the biggest thing on the row
          and it is what a cashier points at when the customer changes their
          mind. The +/− buttons stay separate so quantity is never a mis-tap. */}
      <button
        type="button"
        onClick={onEdit}
        disabled={voided || fired}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <p className={`truncate font-medium ${voided ? 'line-through' : ''}`}>
          {line.nameSnapshot}
        </p>
        {/* Wraps rather than truncates: this is the line the cashier reads back
            to the customer, and "เส้นเล็ก · น้ำใส…" answers nothing. */}
        {summary ? <p className="text-sm text-slate-500">{summary}</p> : null}
        <p className="tnum text-sm text-slate-500">{formatSatang(line.unitPriceSatang)}</p>
        {line.note ? <p className="text-sm text-amber-700">* {line.note}</p> : null}
        {voided ? (
          <p className="text-sm font-semibold text-red-700">ยกเลิกแล้ว</p>
        ) : fired ? (
          <p className="text-sm text-emerald-700">ส่งครัวแล้ว</p>
        ) : null}
      </button>

      {voided ? null : fired ? (
        <button
          type="button"
          onClick={onVoid}
          disabled={!canVoid}
          className="btn h-11 bg-red-50 px-3 text-sm text-red-800 hover:bg-red-100
            disabled:opacity-40"
        >
          ยกเลิก
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={onDecrease}
            aria-label={`ลด ${line.nameSnapshot}`}
            className="btn h-11 w-11 bg-slate-100 text-xl disabled:opacity-40"
          >
            −
          </button>
          <span className="tnum w-8 text-center text-lg font-semibold">{line.qty}</span>
          <button
            type="button"
            onClick={onIncrease}
            aria-label={`เพิ่ม ${line.nameSnapshot}`}
            className="btn h-11 w-11 bg-slate-100 text-xl disabled:opacity-40"
          >
            +
          </button>
        </>
      )}

      {fired && !voided ? (
        <span className="tnum w-8 text-center text-lg font-semibold">{line.qty}</span>
      ) : null}

      <span className={`tnum w-20 text-right font-semibold ${voided ? 'line-through' : ''}`}>
        {formatSatang(line.lineTotalSatang)}
      </span>
    </div>
  );
}

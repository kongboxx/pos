/**
 * What the screens call. The only place that knows whether an answer came from
 * the network or from the device.
 *
 * The shape of every write is the same three steps, in this order:
 *
 *   1. work out the new bill locally and SAVE it   (the screen can redraw now)
 *   2. append the intent to the outbox             (it survives a reboot now)
 *   3. kick the sync loop                          (it reaches the server when it can)
 *
 * Steps 1 and 2 never wait on the network, which is the entire point: taking an
 * order is exactly as fast, and exactly as reliable, with the wifi off.
 *
 * Reads work the other way round — the server first, the device as the fallback
 * — except while a bill has unsent work, when the device is the only one that
 * knows the truth.
 */

import {
  billsOnTable,
  lineSignature,
  normalizeNote,
  sameNote,
  type MenuResponse,
  type OrderDto,
  type TableDto,
} from '@pos/shared';
import { api } from '../api-client.js';
import { loadLocalContext, loadMenu, loadTables, saveMenu, saveTables } from './catalog.js';
import { dropOrder, getOrder, localOpenOrders, putOrder, type StoredOrder } from './db.js';
import {
  applyMutation,
  LocalMutationError,
  type Mutation,
  type OrderChannel,
} from './mutations.js';
import { enqueue, unsentCount } from './outbox.js';
import { useSync } from './sync-store.js';

export type LocalResult<T> = { ok: true; value: T } | { ok: false; error: string };

const NO_CATALOG =
  'เครื่องนี้ยังไม่มีข้อมูลเมนู — ต้องต่อเน็ตเปิดโปรแกรมสักครั้งก่อนถึงจะใช้ตอนออฟไลน์ได้';

/* ------------------------------------------------------------------ */
/* writes                                                              */
/* ------------------------------------------------------------------ */

/** Opens a bill on this device. The id is ours (rule #6), so it is the same
 *  bill whenever the server finally hears about it. */
export async function openBill(input: {
  tableId: string | null;
  tableName: string | null;
  channel: OrderChannel;
}): Promise<LocalResult<string>> {
  const result = await runMutation({
    kind: 'createOrder',
    orderId: crypto.randomUUID(),
    tableId: input.tableId,
    channel: input.channel,
    tableName: input.tableName,
  });
  return result.ok ? { ok: true, value: result.value.id } : result;
}

/**
 * Writes are serialised.
 *
 * Each one is read-modify-write on the same stored bill, and a cashier ringing
 * up three bowls taps far faster than IndexedDB answers. Run in parallel, two
 * mutations both read the bill with one line and both write back two — one bowl
 * silently vanishes. A promise chain is enough: the work is milliseconds, and
 * the alternative (disabling the menu until the write lands) would make the
 * screen refuse taps during exactly the rush it exists for.
 */
let writes: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function runMutation(mutation: Mutation): Promise<LocalResult<OrderDto>> {
  return serialise(() => applyLocally(mutation));
}

/**
 * Tapping a menu button: add the line, or bump the one that is already exactly
 * this bowl.
 *
 * The decision is made HERE rather than on the screen, and inside the write
 * chain, so it reads the bill as it actually is at that instant. Deciding from
 * the React state instead would misfire on the third rapid tap — the component
 * has not re-rendered yet, so it still sees a bill with no lines and starts a
 * second row for the same bowl.
 */
export function addOrBumpLine(input: {
  orderId: string;
  menuItemId: string;
  modifierIds: string[];
  qty: number;
  note: string | null;
}): Promise<LocalResult<OrderDto>> {
  return serialise(async () => {
    const current = await getOrder(input.orderId);
    const signature = lineSignature(input.menuItemId, input.modifierIds);

    // The NOTE is part of what makes two bowls the same bowl.
    //
    // Two identical bowls where one says "เผ็ดน้อย" are two different things to
    // cook, and merging them would send the kitchen one instruction covering
    // both. Two that BOTH say "เผ็ดน้อย" are genuinely the same and stack, so
    // ringing up a table of four does not produce four rows to read back.
    const existing = current?.lines.find(
      (line) =>
        sameNote(line.note, input.note) &&
        !line.firedAt &&
        !line.voidedAt &&
        lineSignature(
          line.menuItemId,
          line.modifiers.map((modifier) => modifier.modifierId),
        ) === signature,
    );

    return applyLocally(
      existing
        ? {
            kind: 'updateLine',
            orderId: input.orderId,
            lineId: existing.id,
            qty: existing.qty + input.qty,
            note: existing.note,
          }
        : {
            kind: 'addLine',
            orderId: input.orderId,
            lineId: crypto.randomUUID(),
            menuItemId: input.menuItemId,
            qty: input.qty,
            modifierIds: input.modifierIds,
            note: normalizeNote(input.note),
          },
    );
  });
}

async function applyLocally(mutation: Mutation): Promise<LocalResult<OrderDto>> {
  const context = await loadLocalContext();
  if (!context) return { ok: false, error: NO_CATALOG };

  const current = (await getOrder(mutation.orderId)) ?? null;

  let next: OrderDto;
  try {
    next = applyMutation(current, mutation, context);
  } catch (error) {
    // A local rule said no (unknown menu item, unknown bill). Nothing is
    // queued, so nothing will surprise anyone later.
    return {
      ok: false,
      error: error instanceof LocalMutationError ? error.message : 'บันทึกลงเครื่องไม่สำเร็จ',
    };
  }

  await putOrder(next, true);
  await enqueue(mutation);
  void useSync.getState().flush();

  return { ok: true, value: next };
}

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * The bill to draw.
 *
 * While anything is queued for it, the DEVICE wins — the server's copy is
 * behind by definition, and adopting it would make lines the cashier just
 * added flicker out of the bill.
 */
export async function readOrder(orderId: string): Promise<StoredOrder | null> {
  const local = await getOrder(orderId);
  if ((await unsentCount(orderId)) > 0) return local ?? null;

  const fetched = await api.getOrder(orderId);
  if (fetched.ok) {
    await putOrder(fetched.data.order, false);
    return (await getOrder(orderId)) ?? null;
  }
  if (!fetched.offline && fetched.status === 404) {
    await dropOrder(orderId);
    return null;
  }
  return local ?? null;
}

/** Menu from the server when possible, from the device when not. */
export async function readMenu(): Promise<MenuResponse | null> {
  const fetched = await api.menu();
  if (fetched.ok) {
    await saveMenu(fetched.data);
    return fetched.data;
  }
  return loadMenu();
}

export async function readFloorPlan(): Promise<{ tables: TableDto[]; fromCache: boolean }> {
  const fetched = await api.tables();
  if (fetched.ok) await saveTables(fetched.data.tables);

  const base = fetched.ok ? fetched.data.tables : ((await loadTables()) ?? []);
  const local = await localOpenOrders();

  return { tables: mergeFloorPlan(base, local), fromCache: !fetched.ok };
}

/**
 * Draws bills this device opened onto the floor plan the server sent.
 *
 * Only UNSYNCED bills override the server. A bill this device knows about but
 * has already synced adds nothing — and worse, if another tablet has since
 * taken the money, our copy is simply stale and would show a table as busy
 * long after the customers left.
 */
export function mergeFloorPlan(
  tables: readonly TableDto[],
  localOrders: readonly StoredOrder[],
): TableDto[] {
  const unsyncedByTable = new Map<string, StoredOrder[]>();
  for (const order of localOrders) {
    if (!order.unsynced || order.tableId === null || order.status !== 'OPEN') continue;
    const list = unsyncedByTable.get(order.tableId) ?? [];
    list.push(order);
    unsyncedByTable.set(order.tableId, list);
  }

  return tables.map((table) => {
    const local = unsyncedByTable.get(table.id);
    if (!local || local.length === 0) return table;

    // APPENDED, not substituted. A table can carry more than one bill since
    // แยกบิล, so a bill this device opened offline sits ALONGSIDE whatever the
    // server already knows about — overwriting would hide a synced bill behind
    // an unsynced one and lose a real total off the floor plan.
    const known = billsOnTable(table);
    const seen = new Set(known.map((bill) => bill.id));
    const openOrders = [
      ...known,
      ...local
        .filter((order) => !seen.has(order.id))
        .map((order) => ({
          id: order.id,
          // Still null: no bill number exists until the server issues one.
          orderNo: order.orderNo,
          totalSatang: order.totalSatang,
          lineCount: order.lines.length,
          openedAt: order.openedAt,
        })),
    ];

    return { ...table, openOrder: openOrders[0] ?? null, openOrders };
  });
}

/** Takeaway bills opened on this device that the server has not seen yet —
 *  they have no table to sit on, so the floor plan lists them separately. */
export async function readUnsyncedTakeaway(): Promise<StoredOrder[]> {
  const orders = await localOpenOrders();
  return orders.filter((order) => order.unsynced && order.tableId === null);
}

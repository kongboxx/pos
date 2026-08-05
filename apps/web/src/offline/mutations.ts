/**
 * What the tablet did, and what a bill looks like afterwards.
 *
 * Two separate jobs live here on purpose:
 *
 *  1. A `Mutation` is an INTENT — "add this line to that bill" — not an HTTP
 *     request. It is durable, it is replayable, and it carries the ids the
 *     device already generated (rule #6), so replaying it after an outage
 *     produces the same rows rather than duplicates.
 *
 *  2. `applyMutation` answers "what does the bill look like now" WITHOUT the
 *     server. That is what makes an offline till usable: the cashier reads a
 *     running total to the customer whether or not the wifi is up.
 *
 * The dangerous part is that the local answer must match the one the server
 * will compute later. So this file does not do its own arithmetic — it calls
 * the exact same calculateLineTotal / calculateOrderTotal / selectedModifiersOf
 * the API calls. Any rule that lives in @pos/shared is imported, never
 * re-implemented; that is the only way the number on the screen and the number
 * that becomes money can be guaranteed to agree.
 */

import {
  calculateLineTotal,
  calculateOrderTotal,
  OrderLineSource,
  selectedModifiersOf,
  sumSatang,
  type MenuItemDto,
  type ModifierGroupDto,
  type OrderDto,
  type OrderLineDto,
  type OrderLineSnapshot,
  type VatConfig,
} from '@pos/shared';

export type OrderChannel = OrderDto['channel'];

export type Mutation =
  | {
      kind: 'createOrder';
      orderId: string;
      tableId: string | null;
      channel: OrderChannel;
      /** Local only — so an offline floor plan can label the bill. Stripped
       *  from the request body; the server knows the table's name already. */
      tableName: string | null;
    }
  | {
      kind: 'addLine';
      orderId: string;
      lineId: string;
      menuItemId: string;
      qty: number;
      modifierIds: string[];
      note: string | null;
    }
  | {
      kind: 'updateLine';
      orderId: string;
      lineId: string;
      qty: number;
      /** Present = replace the whole option set. Absent = leave it alone. */
      modifierIds?: string[];
      note: string | null;
    }
  | { kind: 'removeLine'; orderId: string; lineId: string }
  | { kind: 'cancelOrder'; orderId: string };

/** Everything the reducer needs that is not in the mutation itself. */
export interface LocalContext {
  branchId: string;
  vat: VatConfig;
  /** The trading day this device is in (rule #4), computed from branch config. */
  businessDate: string;
  itemsById: ReadonlyMap<string, MenuItemDto>;
  groupsById: ReadonlyMap<string, ModifierGroupDto>;
  /** Injectable so a test is not at the mercy of the clock or crypto. */
  now?: () => Date;
  newId?: () => string;
}

export class LocalMutationError extends Error {}

/* ------------------------------------------------------------------ */
/* the reducer                                                         */
/* ------------------------------------------------------------------ */

/**
 * The bill after this mutation. Pure: same inputs, same output, no I/O.
 *
 * `order` is null only for `createOrder`. Anything else against a bill this
 * device has never seen is a bug, not a recoverable state, so it throws.
 */
export function applyMutation(
  order: OrderDto | null,
  mutation: Mutation,
  context: LocalContext,
): OrderDto {
  if (mutation.kind === 'createOrder') {
    return retotal(openBill(mutation, context), context);
  }

  if (!order) {
    throw new LocalMutationError(`ไม่พบบิล ${mutation.orderId} บนเครื่องนี้`);
  }

  switch (mutation.kind) {
    case 'addLine':
      return retotal({ ...order, lines: [...order.lines, buildLine(mutation, context)] }, context);

    case 'updateLine': {
      requireEditable(order, mutation.lineId);
      const lines = order.lines.map((line) =>
        line.id === mutation.lineId ? editLine(line, mutation, context) : line,
      );
      return retotal({ ...order, lines }, context);
    }

    case 'removeLine':
      requireEditable(order, mutation.lineId);
      return retotal(
        { ...order, lines: order.lines.filter((line) => line.id !== mutation.lineId) },
        context,
      );

    case 'cancelOrder':
      return { ...order, status: 'CANCELLED' };
  }
}

/**
 * Refuses to touch a line the kitchen already owns (Step 5).
 *
 * The server refuses this too, and that is exactly why the check has to exist
 * here as well: without it the tablet would happily apply the edit locally,
 * show the cashier a changed bill, and only discover the refusal when the queue
 * drained — at which point a bill is sitting in the rejected list needing a
 * person, for something that should never have been offered.
 *
 * A line that is not on this bill is silently allowed through: `removeLine` on
 * an id that is already gone is the outcome the caller asked for.
 */
function requireEditable(order: OrderDto, lineId: string): void {
  const line = order.lines.find((candidate) => candidate.id === lineId);
  if (!line) return;
  if (line.voidedAt) throw new LocalMutationError('รายการนี้ถูกยกเลิกไปแล้ว');
  if (line.firedAt) {
    throw new LocalMutationError('รายการนี้ส่งครัวแล้ว ต้องให้ผู้จัดการอนุมัติถึงจะยกเลิกได้');
  }
}

function openBill(
  mutation: Extract<Mutation, { kind: 'createOrder' }>,
  context: LocalContext,
): OrderDto {
  const now = (context.now ?? (() => new Date()))();
  return {
    id: mutation.orderId,
    // NULL, and it stays null until the server hands one over.
    //
    // A running bill number is a document number: it must be unique per branch
    // per day, and an offline tablet cannot know what the other tablets have
    // already issued. Making one up here would produce two bills numbered
    // 260730-004 on the same day, which is exactly what rule #9 forbids.
    orderNo: null,
    branchId: context.branchId,
    tableId: mutation.tableId,
    tableName: mutation.tableName,
    channel: mutation.channel,
    status: 'OPEN',
    businessDate: context.businessDate,
    openedAt: now.toISOString(),
    paidAt: null,
    note: null,
    subtotalExVatSatang: 0,
    vatRateBpSnapshot: context.vat.enabled ? context.vat.rateBp : 0,
    vatAmountSatang: 0,
    totalSatang: 0,
    // Zero and it stays zero while the tablet is offline: a discount is signed
    // by a supervisor's PIN, and the PIN is checked against a hash that lives on
    // the server. Nothing here can grant one.
    discountSatang: 0,
    isVatInclusive: context.vat.priceIncludesVat,
    receiptNo: null,
    lines: [],
  };
}

function buildLine(
  mutation: Extract<Mutation, { kind: 'addLine' }>,
  context: LocalContext,
): OrderLineDto {
  const item = context.itemsById.get(mutation.menuItemId);
  if (!item) throw new LocalMutationError('เมนูนี้ไม่มีอยู่ในข้อมูลที่เครื่องเก็บไว้');

  const modifiers = resolveModifiers(item, mutation.modifierIds, context);
  const totals = calculateLineTotal({
    nameSnapshot: item.name,
    qty: mutation.qty,
    unitPriceSatang: item.priceSatang,
    unitCostSatang: 0,
    modifiers: modifiers.map((modifier) => ({
      nameSnapshot: modifier.nameSnapshot,
      priceDeltaSatang: modifier.priceDeltaSatang,
      costDeltaSatang: 0,
    })),
  });

  return {
    id: mutation.lineId,
    menuItemId: item.id,
    nameSnapshot: item.name,
    qty: mutation.qty,
    // Effective price, deltas already folded in — same as the server's DTO.
    unitPriceSatang: totals.effectiveUnitPriceSatang,
    // unitCostSatang is deliberately absent. The tablet is not sent cost (a
    // STAFF session never receives it at all), so it cannot compute one, and
    // inventing a 0 that looked real would put a fake margin in front of a
    // manager. The server snapshots the true cost when this line syncs.
    lineTotalSatang: totals.lineTotalSatang,
    note: mutation.note,
    firedAt: null,
    voidedAt: null,
    // A line a cashier typed on the tablet. QR lines never reach this path —
    // the customer's phone has no offline mode at all (see QrOrderPage) — so
    // there is nothing here that could be waiting for an approval.
    source: OrderLineSource.STAFF,
    approvedAt: null,
    modifiers,
  };
}

function editLine(
  line: OrderLineDto,
  mutation: Extract<Mutation, { kind: 'updateLine' }>,
  context: LocalContext,
): OrderLineDto {
  const item = context.itemsById.get(line.menuItemId);

  let modifiers = line.modifiers;
  if (mutation.modifierIds) {
    // Changing the options needs the menu; changing only the quantity does not.
    // An item that has since dropped out of the cached menu must still be
    // countable down to zero, so only this branch insists on finding it.
    if (!item) throw new LocalMutationError('เมนูนี้ไม่มีอยู่ในข้อมูลที่เครื่องเก็บไว้');
    modifiers = resolveModifiers(
      item,
      mutation.modifierIds,
      context,
      line.modifiers.map((modifier) => modifier.id),
    );
  }

  // Rebuilt from the BASE price, not from the line's current effective price:
  // adding the deltas to a number that already contains yesterday's deltas
  // would compound them every time the sheet is reopened.
  const basePrice = item
    ? item.priceSatang
    : line.unitPriceSatang - sumSatang(line.modifiers.map((m) => m.priceDeltaSatang));

  const totals = calculateLineTotal({
    nameSnapshot: line.nameSnapshot,
    qty: mutation.qty,
    unitPriceSatang: basePrice,
    unitCostSatang: 0,
    modifiers: modifiers.map((modifier) => ({
      nameSnapshot: modifier.nameSnapshot,
      priceDeltaSatang: modifier.priceDeltaSatang,
      costDeltaSatang: 0,
    })),
  });

  return {
    ...line,
    qty: mutation.qty,
    note: mutation.note,
    unitPriceSatang: totals.effectiveUnitPriceSatang,
    lineTotalSatang: totals.lineTotalSatang,
    modifiers,
  };
}

/**
 * The chosen options as they will be stored — in GROUP order, not tap order,
 * by borrowing the same selectedModifiersOf the API uses (Step 3).
 *
 * `reuseIds` keeps the snapshot-row ids stable when a line is edited, so React
 * does not tear down and rebuild every row for a quantity change.
 */
function resolveModifiers(
  item: MenuItemDto,
  modifierIds: readonly string[],
  context: LocalContext,
  reuseIds: readonly string[] = [],
): OrderLineDto['modifiers'] {
  const groups = item.groupIds
    .map((id) => context.groupsById.get(id))
    .filter((group): group is ModifierGroupDto => group !== undefined);

  const newId = context.newId ?? (() => crypto.randomUUID());
  return selectedModifiersOf(groups, modifierIds).map((modifier, index) => ({
    id: reuseIds[index] ?? newId(),
    modifierId: modifier.id,
    nameSnapshot: modifier.name,
    priceDeltaSatang: modifier.priceDeltaSatang,
  }));
}

/* ------------------------------------------------------------------ */
/* totals                                                              */
/* ------------------------------------------------------------------ */

/**
 * Recomputes the bill's totals from its lines — the same thing the API does
 * after every write, with the same function.
 *
 * THE TRAP: a line DTO's `unitPriceSatang` already has the option deltas folded
 * into it, and its `modifiers` still list those deltas. Handing both to
 * calculateLineTotal would add them a second time and every customised bowl
 * would ring up too high. So the snapshot below passes the effective price and
 * NO modifiers, which is arithmetically the same line.
 */
function retotal(order: OrderDto, context: LocalContext): OrderDto {
  const snapshots: OrderLineSnapshot[] = order.lines.map((line) => ({
    nameSnapshot: line.nameSnapshot,
    qty: line.qty,
    unitPriceSatang: line.unitPriceSatang,
    unitCostSatang: 0,
    voidedAt: line.voidedAt ? new Date(line.voidedAt) : null,
  }));

  // A discount the server already granted travels with the mirrored bill and
  // must survive every local edit, or adding one bowl offline would silently
  // put the customer's ฿20 back on. `?? 0` covers a bill cached by a tablet
  // that has been offline since before the column existed.
  const totals = calculateOrderTotal(snapshots, context.vat, order.discountSatang ?? 0);

  return {
    ...order,
    subtotalExVatSatang: totals.subtotalExVatSatang,
    vatAmountSatang: totals.vatAmountSatang,
    vatRateBpSnapshot: totals.vatRateBpSnapshot,
    isVatInclusive: totals.isVatInclusive,
    totalSatang: totals.totalSatang,
    discountSatang: totals.discountSatang,
  };
}

/* ------------------------------------------------------------------ */
/* wire format                                                         */
/* ------------------------------------------------------------------ */

export interface MutationRequest {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * The HTTP call a mutation becomes.
 *
 * Kept apart from the mutation itself so the queue stores INTENT rather than a
 * frozen URL: when a route changes, yesterday's queued bills still replay.
 */
export function toRequest(mutation: Mutation): MutationRequest {
  switch (mutation.kind) {
    case 'createOrder':
      return {
        method: 'POST',
        path: '/orders',
        body: {
          id: mutation.orderId,
          ...(mutation.tableId ? { tableId: mutation.tableId } : {}),
          channel: mutation.channel,
        },
      };

    case 'addLine':
      return {
        method: 'POST',
        path: `/orders/${mutation.orderId}/lines`,
        body: {
          id: mutation.lineId,
          menuItemId: mutation.menuItemId,
          qty: mutation.qty,
          modifierIds: mutation.modifierIds,
          note: mutation.note,
        },
      };

    case 'updateLine':
      return {
        method: 'PATCH',
        path: `/orders/${mutation.orderId}/lines/${mutation.lineId}`,
        body: {
          qty: mutation.qty,
          note: mutation.note,
          ...(mutation.modifierIds ? { modifierIds: mutation.modifierIds } : {}),
        },
      };

    case 'removeLine':
      return {
        method: 'DELETE',
        path: `/orders/${mutation.orderId}/lines/${mutation.lineId}`,
      };

    case 'cancelOrder':
      return { method: 'POST', path: `/orders/${mutation.orderId}/cancel`, body: {} };
  }
}

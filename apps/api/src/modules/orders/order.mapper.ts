/**
 * Database rows -> API DTOs.
 *
 * One job worth calling out: STRIPPING COST.
 *
 * A STAFF role must never see cost or profit. If the cost were simply hidden
 * by the UI it would still be sitting in the JSON, one devtools tab away, and
 * a cashier would know the margin on every bowl by the end of the first week.
 * So the field is removed here, on the server, based on the session's role.
 */

import type { Order, OrderLine, OrderLineModifier } from '@prisma/client';
import {
  calculateLineTotal,
  isAwaitingApproval,
  toBusinessDate,
  type OrderDto,
  type OrderLineDto,
  type OrderLineSnapshot,
} from '@pos/shared';

export type OrderLineWithModifiers = OrderLine & { modifiers: OrderLineModifier[] };
export type OrderWithLines = Order & {
  lines: OrderLineWithModifiers[];
  table?: { name: string } | null;
};

/** The shape @pos/shared's money functions expect. Kept in one place so the
 *  totals the API stores and the totals the receipt prints cannot drift. */
export function toSnapshot(line: OrderLineWithModifiers): OrderLineSnapshot {
  return {
    nameSnapshot: line.nameSnapshot,
    qty: line.qty,
    unitPriceSatang: line.unitPriceSatang,
    unitCostSatang: line.unitCostSatang,
    voidedAt: line.voidedAt,
    // A QR request nobody has said yes to yet is not part of the bill (Step 7).
    awaitingApproval: isAwaitingApproval(line),
    modifiers: line.modifiers.map((modifier) => ({
      nameSnapshot: modifier.nameSnapshot,
      priceDeltaSatang: modifier.priceDeltaSatang,
      costDeltaSatang: modifier.costDeltaSatang,
    })),
  };
}

export function toOrderLineDto(line: OrderLineWithModifiers, includeCost: boolean): OrderLineDto {
  const totals = calculateLineTotal(toSnapshot(line));
  return {
    id: line.id,
    menuItemId: line.menuItemId,
    nameSnapshot: line.nameSnapshot,
    qty: line.qty,
    unitPriceSatang: totals.effectiveUnitPriceSatang,
    ...(includeCost ? { unitCostSatang: totals.effectiveUnitCostSatang } : {}),
    lineTotalSatang: totals.lineTotalSatang,
    note: line.note,
    firedAt: line.firedAt?.toISOString() ?? null,
    voidedAt: line.voidedAt?.toISOString() ?? null,
    source: line.source,
    approvedAt: line.approvedAt?.toISOString() ?? null,
    modifiers: line.modifiers.map((modifier) => ({
      id: modifier.id,
      modifierId: modifier.modifierId,
      nameSnapshot: modifier.nameSnapshot,
      priceDeltaSatang: modifier.priceDeltaSatang,
    })),
  };
}

export function toOrderDto(order: OrderWithLines, includeCost: boolean): OrderDto {
  return {
    id: order.id,
    orderNo: order.orderNo,
    branchId: order.branchId,
    tableId: order.tableId,
    tableName: order.table?.name ?? null,
    channel: order.channel,
    status: order.status,
    // The column is a DATE; toISOString would drag a timezone back in.
    businessDate: formatDateColumn(order.businessDate),
    openedAt: order.openedAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    note: order.note,

    subtotalExVatSatang: order.subtotalExVatSatang,
    vatRateBpSnapshot: order.vatRateBpSnapshot,
    vatAmountSatang: order.vatAmountSatang,
    totalSatang: order.totalSatang,
    discountSatang: order.discountSatang,
    ...(includeCost ? { costSatang: order.costSatang } : {}),
    isVatInclusive: order.isVatInclusive,
    receiptNo: order.receiptNo,

    lines: order.lines
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((line) => toOrderLineDto(line, includeCost)),
  };
}

/**
 * Renders a Postgres DATE column back to `YYYY-MM-DD`.
 *
 * Prisma hands a `@db.Date` back as a Date at UTC midnight, so reading it with
 * getFullYear() in Bangkok returns the PREVIOUS day. The UTC getters are the
 * correct readers for this column, not a formatting preference.
 */
export function formatDateColumn(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` -> the Date Prisma stores in a `@db.Date` column. */
export function toDateColumn(businessDate: string): Date {
  return new Date(`${businessDate}T00:00:00.000Z`);
}

/** Convenience so callers do not each re-derive the branch's trading day. */
export function branchBusinessDate(
  branch: { timezone: string; dayCutoffHour: number },
  now = new Date(),
): string {
  return toBusinessDate(now, {
    timezone: branch.timezone,
    dayCutoffHour: branch.dayCutoffHour,
  });
}

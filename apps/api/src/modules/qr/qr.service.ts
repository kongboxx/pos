/**
 * What a customer's phone is allowed to do (Step 7).
 *
 * This is the only service in the codebase reached WITHOUT a session, so the
 * rules it works under are stricter than anywhere else:
 *
 *  - The branch comes from the TOKEN, never from anything the caller says.
 *    There is no branchId parameter to get wrong (rule #1).
 *  - Nothing it returns contains cost, staff names, other tables, or any bill
 *    but the one on the table that was scanned. "Not displayed" is not a
 *    protection on an endpoint anyone can call with curl.
 *  - Everything it writes lands as a REQUEST — `source = QR`, `approvedAt =
 *    null` — which keeps it out of the total and out of reach of the kitchen
 *    until a member of staff says yes.
 *
 * The prices come from the menu at the moment the line is created, snapshotted
 * onto it by the same code the till uses (rule #7). A phone that has had the
 * page open since lunchtime cannot order at lunchtime's prices: it sends ids,
 * and the server prices them.
 */

import type { Branch, DiningTable, PrismaClient } from '@prisma/client';
import {
  calculateLineTotal,
  formatModifierSummary,
  isAwaitingApproval,
  OrderStatus,
  type AddOrderLineRequest,
  type QrBillDto,
  type QrLineStatus,
  type QrSubmitRequest,
  type QrTableResponse,
} from '@pos/shared';
import { conflict, notFound } from '../../http-error.js';
import { loadMenuResponse } from '../menu/menu.query.js';
import { toSnapshot, type OrderWithLines } from '../orders/order.mapper.js';
import type { OrderService } from '../orders/order.service.js';

export interface ScannedTable {
  branch: Branch;
  table: DiningTable;
}

export class QrService {
  constructor(
    private readonly db: PrismaClient,
    private readonly orders: OrderService,
  ) {}

  /**
   * Resolves a sticker to a table.
   *
   * A token that does not exist, a table that was retired, and a branch that
   * was closed all produce the SAME 404. Distinguishing them would turn this
   * endpoint into a way to learn how many tables a shop has by trying tokens.
   */
  async resolve(token: string): Promise<ScannedTable> {
    const table = await this.db.diningTable.findFirst({
      where: { qrToken: token, isActive: true },
      include: { branch: true },
    });
    if (!table || !table.branch.isActive) {
      throw notFound('QR_TABLE_NOT_FOUND', 'คิวอาร์นี้ใช้ไม่ได้แล้ว กรุณาเรียกพนักงาน');
    }
    const { branch, ...rest } = table;
    return { branch, table: rest };
  }

  /** Everything the page needs on first load: shop, table, menu, bill. */
  async tableView(scanned: ScannedTable): Promise<QrTableResponse> {
    const [menu, bill] = await Promise.all([
      // Never with cost. See the file header.
      loadMenuResponse(this.db, scanned.branch.id, false),
      this.bill(scanned),
    ]);

    return {
      shopName: scanned.branch.name,
      tableName: scanned.table.name,
      orderingEnabled: scanned.branch.qrOrderingEnabled,
      menu,
      bill,
    };
  }

  /** The open bill on this table, as the customer is allowed to see it. */
  async bill(scanned: ScannedTable): Promise<QrBillDto> {
    const order = await this.db.order.findFirst({
      where: {
        branchId: scanned.branch.id,
        tableId: scanned.table.id,
        status: OrderStatus.OPEN,
      },
      include: {
        lines: { include: { modifiers: { orderBy: { sortOrder: 'asc' } } } },
      },
    });

    return toQrBill(order);
  }

  /**
   * Takes what the customer sent.
   *
   * Opens the bill if the table has none — see OrderService.ensureOpenTableOrder
   * for why the order id is generated on the server here and nowhere else.
   */
  async submit(
    scanned: ScannedTable,
    input: QrSubmitRequest,
  ): Promise<{ orderId: string; bill: QrBillDto; accepted: number }> {
    if (!scanned.branch.qrOrderingEnabled) {
      throw conflict('QR_ORDERING_DISABLED', 'ตอนนี้ร้านปิดรับออร์เดอร์ผ่าน QR กรุณาเรียกพนักงาน');
    }

    const order = await this.orders.ensureOpenTableOrder(scanned.branch, scanned.table.id);
    const lines: AddOrderLineRequest[] = input.lines.map((line) => ({
      id: line.id,
      menuItemId: line.menuItemId,
      qty: line.qty,
      note: line.note ?? null,
      ...(line.modifierIds ? { modifierIds: line.modifierIds } : {}),
    }));

    try {
      const result = await this.orders.addQrLines(scanned.branch, order.id, lines);
      return {
        orderId: order.id,
        bill: toQrBill(result.order),
        accepted: result.accepted,
      };
    } catch (error) {
      // The bill was committed before the lines were. A refusal here — most
      // often a phone ordering a dish that sold out while its page sat open —
      // would otherwise leave an empty bill holding the table, opened by
      // somebody who never spoke to a member of staff.
      await this.orders.discardEmptyQrOrder(scanned.branch, order.id);
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ */

/**
 * The bill in the customer's words.
 *
 * Voided lines are left out entirely. A line a member of staff cancelled is a
 * conversation that already happened at the table — reprinting it on the phone
 * as "ยกเลิกแล้ว" would raise it again with nobody there to answer.
 */
function toQrBill(order: OrderWithLines | null): QrBillDto {
  if (!order) {
    return { orderId: null, orderNo: null, lines: [], confirmedTotalSatang: 0, pendingCount: 0 };
  }

  const visible = order.lines
    .filter((line) => !line.voidedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  let pendingCount = 0;

  const lines = visible.map((line) => {
    const { lineTotalSatang } = calculateLineTotal(toSnapshot(line));
    const status: QrLineStatus = isAwaitingApproval(line)
      ? 'PENDING'
      : line.firedAt
        ? 'COOKING'
        : 'CONFIRMED';

    if (status === 'PENDING') pendingCount += 1;

    const summary = formatModifierSummary(
      line.modifiers.map((modifier) => modifier.nameSnapshot),
    ).trim();

    return {
      id: line.id,
      name: line.nameSnapshot,
      qty: line.qty,
      optionsSummary: summary || null,
      note: line.note,
      lineTotalSatang,
      status,
    };
  });

  return {
    orderId: order.id,
    orderNo: order.orderNo,
    lines,
    // The bill's OWN cached total, not a sum of the rows above: that figure is
    // the one VAT was applied to once, and it is what the customer will
    // actually be asked for at the counter. Re-adding the lines here would be a
    // second way to compute the same number, and second ways drift.
    confirmedTotalSatang: order.totalSatang,
    pendingCount,
  };
}

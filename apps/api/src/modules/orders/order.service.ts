/**
 * Bills.
 *
 * A bill is long-lived (rule #10): it opens when the first plate is ordered and
 * stays OPEN until it is paid or cancelled. It is never a shopping cart that
 * exists only while a screen is open.
 *
 * Three things here are load-bearing and easy to get wrong later:
 *
 *  1. Every write recomputes the totals from the LINES and stores the result.
 *     The stored total is a cache of a pure function, never something a client
 *     sends. A tablet cannot tell the server what a bill costs.
 *
 *  2. Prices and costs are SNAPSHOT onto the line at the moment it is added
 *     (rule #7). Editing a menu price tonight must not move this afternoon's
 *     takings.
 *
 *  3. Creating an order and adding a line are IDEMPOTENT on the client-supplied
 *     id. Shop wifi drops requests; a cashier who taps "เพิ่ม" twice because
 *     nothing happened must not end up with two bowls on the bill.
 */

// Prisma is imported as a VALUE, not `import type`: Prisma.JsonNull is a real
// runtime sentinel, and it is the only way to write SQL NULL into a Json
// column (leaving the field out means "don't change it").
import { Prisma } from '@prisma/client';
import type { Branch, PrismaClient } from '@prisma/client';
import {
  BILL_MOVE_ACTIONS,
  calculateChange,
  calculateLineTotal,
  calculateOrderTotal,
  can,
  canMergeBills,
  CHANNEL_LABEL,
  DEFAULT_STATION,
  DocType,
  OrderChannel,
  OrderLineSource,
  OrderStatus,
  Permission,
  PaymentMethod,
  PrintJobType,
  TicketStatus,
  WIDTH_80MM,
  buildBillCheck,
  buildSalesReceipt,
  describeDiscount,
  describeMerge,
  describeSplit,
  describeTableMove,
  formatModifierSummary,
  formatSatang,
  isAwaitingApproval,
  planSplit,
  resolveDiscount,
  type AddOrderLineRequest,
  type ApproveQrLinesRequest,
  type ClearDiscountRequest,
  type CreateOrderRequest,
  type DiscountRequest,
  type FireOrderRequest,
  type MergeBillsRequest,
  type MergeCandidate,
  type MoveTableRequest,
  type OrderDto,
  type PayOrderRequest,
  type PendingApprovalOrderDto,
  type RejectQrLinesRequest,
  type Role,
  type SplitBillRequest,
  type TableBillDto,
  type TableDto,
  vatConfigForDate,
  type VatConfig,
  type VoidLineRequest,
} from '@pos/shared';
import { badRequest, conflict, notFound } from '../../http-error.js';
import { DISCOUNT_APPROVAL, verifyApproval, VOID_APPROVAL } from '../auth/approval.service.js';
import { allocateDocNumber } from '../docs/doc-sequence.service.js';
import { settleTicketsForLines } from '../kitchen/ticket.settle.js';
import {
  loadGroupsForMenuItem,
  resolveModifierSnapshots,
  type ModifierSnapshot,
} from '../menu/modifier.service.js';
import type { PrintService } from '../print/print.service.js';
import {
  branchBusinessDate,
  formatDateColumn,
  toDateColumn,
  toOrderDto,
  toSnapshot,
  type OrderWithLines,
} from './order.mapper.js';

/** Who is doing this. Comes from the JWT, never from the request body. */
export interface Actor {
  staffId: string;
  role: Role;
  fullName: string;
}

export const ORDER_INCLUDE = {
  // Ordered explicitly: the printed and on-screen option order is the group
  // order that was frozen onto the line, not whatever Postgres returns.
  lines: { include: { modifiers: { orderBy: { sortOrder: 'asc' } } } },
  table: { select: { name: true } },
} satisfies Prisma.OrderInclude;

export class OrderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly print: PrintService,
  ) {}

  /* ------------------------------------------------------------------ */
  /* reads                                                               */
  /* ------------------------------------------------------------------ */

  async getOrder(branch: Branch, orderId: string, actor: Actor): Promise<OrderDto> {
    const order = await this.db.order.findFirst({
      where: { id: orderId, branchId: branch.id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw notFound('ORDER_NOT_FOUND', 'ไม่พบบิลนี้');
    return toOrderDto(order, canSeeCost(actor));
  }

  /** Every bill still open today — the "บิลค้าง" list on the floor plan. */
  async listOpen(branch: Branch, actor: Actor): Promise<OrderDto[]> {
    const orders = await this.db.order.findMany({
      where: { branchId: branch.id, status: OrderStatus.OPEN },
      include: ORDER_INCLUDE,
      orderBy: { openedAt: 'asc' },
    });
    return orders.map((order) => toOrderDto(order, canSeeCost(actor)));
  }

  /**
   * The floor plan: every active table with the bills sitting on it.
   *
   * One query per concern rather than a join, because a table with no bill is
   * the common case and an outer join would make the empty tables the
   * complicated path.
   *
   * A table can carry MORE THAN ONE bill since แยกบิล. `openOrder` is kept as
   * the oldest of them so a tablet cached from before that change still draws a
   * busy table as busy instead of as free.
   */
  async listTables(branch: Branch): Promise<TableDto[]> {
    const [tables, openOrders, waiting] = await Promise.all([
      this.db.diningTable.findMany({
        where: { branchId: branch.id, isActive: true },
        orderBy: [{ zone: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.order.findMany({
        where: { branchId: branch.id, status: OrderStatus.OPEN, tableId: { not: null } },
        // Oldest first: openOrders[0] is the bill the table started with, and
        // that is the one the legacy `openOrder` field has to be.
        orderBy: { openedAt: 'asc' },
        select: {
          id: true,
          orderNo: true,
          tableId: true,
          totalSatang: true,
          openedAt: true,
          _count: { select: { lines: true } },
        },
      }),
      // QR requests nobody has answered yet (Step 7). Counted here rather than
      // fetched by the approvals screen alone, because the floor plan is the
      // screen the shop actually stands in front of — a badge on the table is
      // what turns "someone is waiting" into "table A3 is waiting".
      this.db.orderLine.groupBy({
        by: ['orderId'],
        where: {
          branchId: branch.id,
          source: OrderLineSource.QR,
          approvedAt: null,
          voidedAt: null,
          order: { status: OrderStatus.OPEN },
        },
        _count: { _all: true },
      }),
    ]);

    const byTable = new Map<string, TableBillDto[]>();
    for (const order of openOrders) {
      const bills = byTable.get(order.tableId as string) ?? [];
      bills.push({
        id: order.id,
        orderNo: order.orderNo,
        totalSatang: order.totalSatang,
        lineCount: order._count.lines,
        openedAt: order.openedAt.toISOString(),
      });
      byTable.set(order.tableId as string, bills);
    }
    const pendingByOrder = new Map(waiting.map((row) => [row.orderId, row._count._all]));

    return tables.map((table) => {
      const bills = byTable.get(table.id) ?? [];
      return {
        id: table.id,
        name: table.name,
        zone: table.zone,
        seats: table.seats,
        openOrder: bills[0] ?? null,
        openOrders: bills,
        // Summed over every bill on the table: the badge answers "is anyone at
        // this table waiting", and which of their bills it landed on is not
        // something the person walking over needs to know.
        pendingApprovalCount: bills.reduce(
          (total, bill) => total + (pendingByOrder.get(bill.id) ?? 0),
          0,
        ),
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* writes                                                              */
  /* ------------------------------------------------------------------ */

  async createOrder(branch: Branch, actor: Actor, input: CreateOrderRequest): Promise<OrderDto> {
    // Idempotency: the id came from the tablet, so a retried request is the
    // SAME bill, not a second one.
    const existing = await this.db.order.findUnique({
      where: { id: input.id },
      include: ORDER_INCLUDE,
    });
    if (existing) {
      if (existing.branchId !== branch.id) {
        throw conflict('ORDER_ID_TAKEN', 'รหัสบิลนี้ถูกใช้ในสาขาอื่นแล้ว');
      }
      return toOrderDto(existing, canSeeCost(actor));
    }

    const isDineIn = input.channel === OrderChannel.DINE_IN;
    if (isDineIn && !input.tableId) {
      throw badRequest('TABLE_REQUIRED', 'บิลทานที่ร้านต้องระบุโต๊ะ');
    }
    if (!isDineIn && input.tableId) {
      throw badRequest('TABLE_NOT_ALLOWED', 'บิลกลับบ้าน/เดลิเวอรีไม่ต้องระบุโต๊ะ');
    }

    const businessDate = branchBusinessDate(branch);

    // The retry lives OUT HERE, around the whole transaction, and never inside
    // it: a unique violation ABORTS the Postgres transaction, so every
    // statement after it fails with 25P02 ("current transaction is aborted").
    // An inner retry loop turns a recoverable clash into a 500 — which is
    // exactly what the first version of this did.
    const order = await this.withOrderNoRetry(() =>
      this.openOrderTransaction(branch, input, businessDate),
    );

    return toOrderDto(order, canSeeCost(actor));
  }

  private async openOrderTransaction(
    branch: Branch,
    input: CreateOrderRequest,
    businessDate: string,
  ): Promise<OrderWithLines> {
    return this.db.$transaction(async (tx) => {
      // Serialises "what is the next bill number for this branch today".
      //
      // Counting rows and inserting count+1 is a read-then-write race: two
      // tablets both read N and both try N+1. A retry alone does not close it,
      // it only narrows it — under real contention the retries collide too.
      // This advisory lock is held until the transaction commits, so the
      // second tablet waits a few milliseconds and then counts the first one.
      //
      // Taken as the FIRST statement so every "open a bill" transaction
      // acquires its locks in the same order and none can deadlock with
      // another over the table-session rows below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-no:${branch.id}:${businessDate}`}))`;

      let sessionId: string | null = null;

      if (input.tableId) {
        const table = await tx.diningTable.findFirst({
          where: { id: input.tableId, branchId: branch.id, isActive: true },
        });
        if (!table) throw notFound('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้ หรือโต๊ะถูกปิดใช้งาน');

        const occupied = await tx.order.findFirst({
          where: { branchId: branch.id, tableId: table.id, status: OrderStatus.OPEN },
          select: { id: true, orderNo: true },
        });
        if (occupied) {
          throw conflict(
            'TABLE_OCCUPIED',
            `โต๊ะ ${table.name} มีบิลค้างอยู่แล้ว (${occupied.orderNo ?? occupied.id.slice(0, 8)})`,
          );
        }

        // One sitting per table, joining however many bills it takes. It closes
        // when the last of them is paid (see closeSessionIfEmpty).
        sessionId = await this.sittingAt(tx, branch.id, table.id);
      }

      return this.createWithOrderNo(tx, {
        id: input.id,
        branchId: branch.id,
        tableId: input.tableId ?? null,
        sessionId,
        channel: input.channel,
        businessDate,
        note: input.note ?? null,
        vat: vatConfigOf(branch, businessDate),
      });
    });
  }

  /** Reruns the whole transaction when the running number was taken. */
  private async withOrderNoRetry<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 0; tries < 5; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!isOrderNoCollision(error)) throw error;
      }
    }
    throw conflict('ORDER_NO_EXHAUSTED', 'ออกเลขบิลไม่สำเร็จ กรุณาลองอีกครั้ง');
  }

  async addLine(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: AddOrderLineRequest,
  ): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      await this.createLine(tx, branch, current.id, input, OrderLineSource.STAFF);
      return this.recalculate(tx, branch, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /**
   * Puts ONE line on a bill, snapshotting everything rule #7 asks for.
   *
   * Shared by the till and by the customer's phone (Step 7) so there is exactly
   * one answer to "what does a bill line look like". The two callers differ in
   * a single argument — `source` — and everything that follows from it (whether
   * it counts towards the total, whether it may be fired) is derived from that
   * one field rather than written twice.
   *
   * Returns false when the id was already on this bill: that is the idempotency
   * contract, and it is what makes a retried "เพิ่ม" on flaky wifi, or a
   * double-tapped send on a phone, not a second bowl.
   */
  private async createLine(
    tx: Prisma.TransactionClient,
    branch: Branch,
    orderId: string,
    input: AddOrderLineRequest,
    source: OrderLineSource,
  ): Promise<boolean> {
    const duplicate = await tx.orderLine.findUnique({
      where: { id: input.id },
      select: { id: true, orderId: true },
    });
    if (duplicate) {
      if (duplicate.orderId !== orderId) {
        throw conflict('LINE_ID_TAKEN', 'รหัสรายการนี้ถูกใช้กับบิลอื่นแล้ว');
      }
      return false;
    }

    const menuItem = await tx.menuItem.findFirst({
      where: { id: input.menuItemId, branchId: branch.id },
    });
    // isActive is checked as well as isAvailable: a dish the shop stopped
    // selling is not on the till at all, and must not be reachable from a
    // customer's phone holding a page it loaded an hour ago.
    if (!menuItem || !menuItem.isActive) throw notFound('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
    if (!menuItem.isAvailable) {
      throw conflict('MENU_ITEM_UNAVAILABLE', `"${menuItem.name}" หมดแล้ว`);
    }

    // The server decides what a legal bowl is, not the sheet that asked.
    // Omitting modifierIds asks for the group defaults ("the usual").
    const groups = await loadGroupsForMenuItem(tx, branch.id, menuItem.id);
    const modifiers = resolveModifierSnapshots(groups, input.modifierIds);

    const lastSortOrder = await tx.orderLine.aggregate({
      where: { orderId },
      _max: { sortOrder: true },
    });

    await tx.orderLine.create({
      data: {
        id: input.id,
        branchId: branch.id,
        orderId,
        menuItemId: menuItem.id,
        // Rule #7: the name, the price and the cost as they are RIGHT NOW.
        nameSnapshot: menuItem.name,
        qty: input.qty,
        unitPriceSatang: menuItem.priceSatang,
        unitCostSatang: menuItem.costSatang,
        note: input.note ?? null,
        source,
        sortOrder: (lastSortOrder._max.sortOrder ?? 0) + 1,
        // Snapshotted too, and for the same reason: renaming "พิเศษ" or
        // repricing it tonight must not move this afternoon's takings.
        modifiers: {
          create: modifiers.map((modifier) => ({ branchId: branch.id, ...modifier })),
        },
      },
    });

    return true;
  }

  /**
   * Changes quantity, note and — when `modifierIds` is present — the whole set
   * of options on a line that has NOT been fired.
   *
   * "ลืมบอกว่าไม่ผัก" is the most common correction at a noodle counter and it
   * almost always happens in the ten seconds before the ticket goes to the
   * kitchen. Replacing the set wholesale rather than patching it keeps one
   * validation path: whatever comes back must be a legal bowl on its own.
   */
  async updateLine(
    branch: Branch,
    actor: Actor,
    orderId: string,
    lineId: string,
    input: { qty: number; note: string | null; modifierIds?: readonly string[] },
  ): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      const line = await this.loadEditableLine(tx, current.id, lineId);

      let replacement: ModifierSnapshot[] | null = null;
      if (input.modifierIds) {
        const groups = await loadGroupsForMenuItem(tx, branch.id, line.menuItemId);
        replacement = resolveModifierSnapshots(groups, input.modifierIds);

        await tx.orderLineModifier.deleteMany({ where: { orderLineId: line.id } });
        await tx.orderLineModifier.createMany({
          data: replacement.map((modifier) => ({
            branchId: branch.id,
            orderLineId: line.id,
            ...modifier,
          })),
        });
      }

      await tx.orderLine.update({
        where: { id: line.id },
        data: { qty: input.qty, note: input.note },
      });
      await this.audit(tx, branch.id, actor, 'EDIT_ORDER_LINE', 'OrderLine', line.id, {
        before: { qty: line.qty, note: line.note, modifiers: modifierNames(line.modifiers) },
        after: {
          qty: input.qty,
          note: input.note,
          modifiers: replacement
            ? replacement.map((modifier) => modifier.nameSnapshot)
            : modifierNames(line.modifiers),
        },
      });

      return this.recalculate(tx, branch, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /**
   * Removes a line that has NOT been sent to the kitchen.
   *
   * A fired line is a different thing entirely: food was cooked, so it has to
   * be voided with a reason and a supervisor's PIN and stay on the bill as
   * evidence (rule #8) — see voidLine below. This path refuses anything that
   * has been fired and says so, which is the whole difference between an edit
   * and a loss.
   */
  async removeLine(
    branch: Branch,
    actor: Actor,
    orderId: string,
    lineId: string,
  ): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      const line = await this.loadEditableLine(tx, current.id, lineId);

      await tx.orderLineModifier.deleteMany({ where: { orderLineId: line.id } });
      await tx.orderLine.delete({ where: { id: line.id } });
      await this.audit(tx, branch.id, actor, 'REMOVE_ORDER_LINE', 'OrderLine', line.id, {
        before: {
          nameSnapshot: line.nameSnapshot,
          qty: line.qty,
          unitPriceSatang: line.unitPriceSatang,
          modifiers: modifierNames(line.modifiers),
        },
        after: null,
      });

      return this.recalculate(tx, branch, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /* ------------------------------------------------------------------ */
  /* customer QR orders (Step 7)                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The bill for a table, opening one if the table is empty.
   *
   * A customer who sits down and scans the sticker has not been served by
   * anyone yet, so there may be no bill to add to. Opening it here is what
   * makes the QR code worth having at all — if staff had to open the table
   * first, they would have walked over, and the walk is the thing being saved.
   *
   * NOTE THE ORDER ID IS GENERATED ON THE SERVER, which is the one place in
   * this system that departs from rule #6. The rule exists so an OFFLINE tablet
   * can open a bill before the server has heard of it. A customer's phone is
   * never offline-capable — it cannot even see the menu without the server — so
   * a client-generated id here would buy nothing and cost a collision path: two
   * phones at one table would each invent a bill and the second would be told
   * the table is occupied by a bill it cannot see. Line ids still come from the
   * phone, because those are what make a double-tapped send harmless.
   */
  async ensureOpenTableOrder(branch: Branch, tableId: string): Promise<OrderWithLines> {
    const existing = await this.db.order.findFirst({
      where: { branchId: branch.id, tableId, status: OrderStatus.OPEN },
      include: ORDER_INCLUDE,
    });
    if (existing) return existing;

    const businessDate = branchBusinessDate(branch);
    const input: CreateOrderRequest = {
      id: crypto.randomUUID(),
      tableId,
      channel: OrderChannel.DINE_IN,
      note: null,
    };

    try {
      return await this.withOrderNoRetry(() =>
        this.openOrderTransaction(branch, input, businessDate),
      );
    } catch (error) {
      // Two phones at the same table pressing send at the same moment. The
      // advisory lock serialises them, so the loser is told the table is
      // occupied — by the bill the winner just opened, which is exactly the
      // bill it wanted. Re-read rather than fail.
      if (!isTableOccupied(error)) throw error;
      const opened = await this.db.order.findFirst({
        where: { branchId: branch.id, tableId, status: OrderStatus.OPEN },
        include: ORDER_INCLUDE,
      });
      if (!opened) throw error;
      return opened;
    }
  }

  /**
   * Adds what a customer sent, as requests rather than as sales.
   *
   * Every line lands with `source = QR` and `approvedAt = null`, which keeps it
   * out of the total, off the printed check, and out of reach of the kitchen
   * until a member of staff presses อนุมัติ.
   */
  async addQrLines(
    branch: Branch,
    orderId: string,
    lines: readonly AddOrderLineRequest[],
  ): Promise<{ order: OrderWithLines; accepted: number }> {
    return this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);

      let accepted = 0;
      for (const line of lines) {
        const created = await this.createLine(tx, branch, current.id, line, OrderLineSource.QR);
        if (created) accepted += 1;
      }

      // Recalculated even though a pending line changes no total, because the
      // bill may also hold staff lines and this is the one place that keeps the
      // cached figures honest.
      return { order: await this.recalculate(tx, branch, current.id), accepted };
    });
  }

  /**
   * Closes a bill that was opened for a QR order which then failed.
   *
   * `ensureOpenTableOrder` commits before the lines are added, so a submission
   * that is refused halfway — the customer's phone has had the page open since
   * lunchtime and taps a dish that went "หมดแล้ว" ten minutes ago — would leave
   * an empty bill sitting on the table. On the floor plan that table then goes
   * amber for a bill nobody opened and nobody will close: the person who caused
   * it never spoke to a member of staff, and the staff have no idea what it is.
   *
   * Guarded by "still has no lines at all", so it can never touch a bill that a
   * cashier had already started on the same table.
   */
  async discardEmptyQrOrder(branch: Branch, orderId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, branchId: branch.id, status: OrderStatus.OPEN },
        select: { id: true, sessionId: true, _count: { select: { lines: true } } },
      });
      if (!order || order._count.lines > 0) return;

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED },
      });
      // staffId is null on purpose: nobody did this. Attributing it to whoever
      // happens to be logged in would put a cashier's name on an event they
      // were not present for.
      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          action: 'CANCEL_ORDER',
          entityType: 'Order',
          entityId: order.id,
          before: { status: OrderStatus.OPEN },
          after: { status: OrderStatus.CANCELLED, reason: 'ออร์เดอร์ QR ส่งไม่สำเร็จ' },
        },
      });
      await this.closeSessionIfEmpty(tx, branch.id, order.sessionId, order.id);
    });
  }

  /** Every QR request still waiting, oldest table first. */
  async listPendingApproval(branch: Branch): Promise<PendingApprovalOrderDto[]> {
    const lines = await this.db.orderLine.findMany({
      where: {
        branchId: branch.id,
        source: OrderLineSource.QR,
        approvedAt: null,
        voidedAt: null,
        order: { status: OrderStatus.OPEN },
      },
      include: {
        modifiers: { orderBy: { sortOrder: 'asc' } },
        order: {
          select: { id: true, orderNo: true, tableId: true, table: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const byOrder = new Map<string, PendingApprovalOrderDto>();
    for (const line of lines) {
      const { lineTotalSatang } = calculateLineTotal(toSnapshot(line));
      const summary = formatModifierSummary(modifierNames(line.modifiers)).trim();

      const group = byOrder.get(line.order.id) ?? {
        orderId: line.order.id,
        orderNo: line.order.orderNo,
        tableId: line.order.tableId,
        tableName: line.order.table?.name ?? null,
        lines: [],
        // The first line wins because the query is ordered oldest first, and
        // this is what the queue sorts and colours by.
        waitingSince: line.createdAt.toISOString(),
      };

      group.lines.push({
        id: line.id,
        name: line.nameSnapshot,
        qty: line.qty,
        optionsSummary: summary || null,
        note: line.note,
        lineTotalSatang,
        submittedAt: line.createdAt.toISOString(),
      });
      byOrder.set(line.order.id, group);
    }

    return [...byOrder.values()].sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  }

  /**
   * Lets a customer's request through, and — unless told otherwise — straight
   * on to the kitchen.
   *
   * Approving without firing would leave the line looking exactly like a staff
   * line somebody forgot to send, on a screen nobody is looking at, while the
   * customer's phone says "ยืนยันแล้ว". One press, both effects.
   */
  async approveLines(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: ApproveQrLinesRequest,
  ): Promise<{ order: OrderDto; stations: string[] }> {
    const approved = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      const requested = new Set(input.lineIds);
      const targets = current.lines.filter(
        (line) => requested.has(line.id) && !line.voidedAt && isAwaitingApproval(line),
      );

      if (targets.length === 0) {
        throw conflict('NOTHING_TO_APPROVE', 'รายการเหล่านี้ถูกยืนยันหรือถูกปฏิเสธไปแล้ว');
      }

      const ids = targets.map((line) => line.id);
      await tx.orderLine.updateMany({
        // `approvedAt: null` in the filter makes a double-tap harmless at the
        // row level, the same way firing is guarded.
        where: { id: { in: ids }, approvedAt: null },
        data: { approvedAt: new Date() },
      });

      await this.audit(tx, branch.id, actor, 'APPROVE_QR_LINES', 'Order', current.id, {
        before: null,
        after: {
          lines: targets.map((line) => ({
            id: line.id,
            name: line.nameSnapshot,
            qty: line.qty,
          })),
        },
      });

      // The totals move here: lines that were requests a moment ago are sales.
      await this.recalculate(tx, branch, current.id);
      return ids;
    });

    if (!input.fire) {
      return { order: await this.getOrder(branch, orderId, actor), stations: [] };
    }
    // Fired in a second transaction. If this half fails, the lines are approved
    // but unsent — which shows up on the bill as an ordinary "ส่งครัว" waiting
    // to be pressed, rather than as anything that needs explaining.
    return this.fireLines(branch, actor, orderId, { lineIds: approved });
  }

  /**
   * Turns a customer's request down.
   *
   * The line is DELETED, not voided. Nothing was cooked and nothing was sold,
   * so there is no loss to account for — a VoidLog row here would put "ของหมด"
   * into the report the owner reads to find out what was thrown away, which is
   * a different question. The audit log keeps who refused what, which is what
   * answers "is this QR code generating junk".
   */
  async rejectLines(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: RejectQrLinesRequest,
  ): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      const requested = new Set(input.lineIds);
      const targets = current.lines.filter(
        (line) => requested.has(line.id) && !line.voidedAt && isAwaitingApproval(line),
      );

      if (targets.length === 0) {
        throw conflict('NOTHING_TO_REJECT', 'รายการเหล่านี้ถูกยืนยันหรือถูกปฏิเสธไปแล้ว');
      }

      const ids = targets.map((line) => line.id);
      await tx.orderLineModifier.deleteMany({ where: { orderLineId: { in: ids } } });
      await tx.orderLine.deleteMany({ where: { id: { in: ids } } });

      await this.audit(tx, branch.id, actor, 'REJECT_QR_LINES', 'Order', current.id, {
        before: {
          lines: targets.map((line) => ({
            id: line.id,
            name: line.nameSnapshot,
            qty: line.qty,
            modifiers: modifierNames(line.modifiers),
          })),
        },
        after: { reason: input.reason ?? null },
      });

      const remaining = await this.recalculate(tx, branch, current.id);

      // A bill that exists ONLY because of a request that was just refused must
      // not sit on the table looking occupied. Nobody opened it and nobody is
      // going to close it — the customer never spoke to a member of staff.
      if (remaining.lines.length === 0) {
        await tx.order.update({
          where: { id: current.id },
          data: { status: OrderStatus.CANCELLED },
        });
        await this.audit(tx, branch.id, actor, 'CANCEL_ORDER', 'Order', current.id, {
          before: { status: current.status },
          after: { status: OrderStatus.CANCELLED, reason: 'ปฏิเสธออร์เดอร์ QR ทั้งบิล' },
        });
        await this.closeSessionIfEmpty(tx, branch.id, current.sessionId, current.id);
      }

      return this.reload(tx, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /* ------------------------------------------------------------------ */
  /* the kitchen (Step 5)                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Sends everything not yet fired to the kitchen.
   *
   * WHY THIS IS AN EXPLICIT BUTTON and not automatic on every tap: the ten
   * seconds between "ก๋วยเตี๋ยวหมู" and "อ๋อ ไม่ผักด้วย" are the ten seconds in
   * which almost every correction happens. Firing each line as it lands would
   * turn that ordinary correction into a void with a manager's PIN, several
   * times a service. One extra tap per table buys that back.
   *
   * ONE TICKET PER STATION, not per bill: the noodle counter and the drinks
   * fridge are different people standing in different places, and a ticket
   * neither of them owns entirely is a ticket both of them ignore. A second
   * round ordered later is a new ticket on purpose — that is how a kitchen
   * reads "this just came in" as distinct from "this has been sitting here".
   */
  async fireLines(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: FireOrderRequest,
  ): Promise<{ order: OrderDto; stations: string[] }> {
    const result = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);

      const requested = input.lineIds ? new Set(input.lineIds) : null;
      const candidates = current.lines
        // A QR request nobody has approved is NOT fireable, even when the
        // cashier presses "ส่งครัว" for the whole bill. Without this line the
        // approval queue would be decoration: anything a customer typed would
        // reach the kitchen on the next press of the button everyone presses.
        .filter((line) => !line.voidedAt && !line.firedAt && !isAwaitingApproval(line))
        .filter((line) => !requested || requested.has(line.id))
        .sort((a, b) => a.sortOrder - b.sortOrder);

      if (candidates.length === 0) {
        throw conflict('NOTHING_TO_FIRE', 'ไม่มีรายการใหม่ที่จะส่งครัว — ส่งไปหมดแล้ว');
      }

      // The station comes from the MENU ITEM at fire time, not from a snapshot
      // on the line: moving ผัดไทย from the noodle counter to the wok station
      // should change where tonight's orders land, and it is not a figure that
      // any report reads afterwards (which is what rule #7 is protecting).
      const menuItems = await tx.menuItem.findMany({
        where: { branchId: branch.id, id: { in: candidates.map((line) => line.menuItemId) } },
        select: { id: true, station: true },
      });
      const stationOf = new Map(
        menuItems.map((item) => [item.id, item.station ?? DEFAULT_STATION]),
      );

      const byStation = new Map<string, typeof candidates>();
      for (const line of candidates) {
        const station = stationOf.get(line.menuItemId) ?? DEFAULT_STATION;
        const group = byStation.get(station);
        if (group) group.push(line);
        else byStation.set(station, [line]);
      }

      // One timestamp for the whole fire, so every line of one press sorts
      // together on the board no matter how long the inserts took.
      const firedAt = new Date();

      for (const [station, lines] of byStation) {
        await tx.kitchenTicket.create({
          data: {
            branchId: branch.id,
            orderId: current.id,
            // Snapshot: the slip still reads "A1" if the bill is moved later.
            tableName: current.table?.name ?? null,
            station,
            firedAt,
            lines: {
              create: lines.map((line) => ({
                branchId: branch.id,
                orderLineId: line.id,
                // Denormalised so the kitchen screen renders from one row and
                // keeps reading correctly even if the bill is edited around it.
                nameSnapshot: line.nameSnapshot,
                qty: line.qty,
                modifiersSnapshot:
                  formatModifierSummary(modifierNames(line.modifiers)).trim() || null,
                note: line.note,
              })),
            },
          },
        });
      }

      await tx.orderLine.updateMany({
        // `firedAt: null` in the filter makes a double-tap on "ส่งครัว" harmless
        // at the row level as well as at the candidate level.
        where: { id: { in: candidates.map((line) => line.id) }, firedAt: null },
        data: { firedAt },
      });

      await this.audit(tx, branch.id, actor, 'FIRE_ORDER', 'Order', current.id, {
        before: null,
        after: {
          stations: [...byStation.keys()],
          lines: candidates.map((line) => ({
            id: line.id,
            name: line.nameSnapshot,
            qty: line.qty,
          })),
        },
      });

      return { order: await this.reload(tx, current.id), stations: [...byStation.keys()] };
    });

    return { order: toOrderDto(result.order, canSeeCost(actor)), stations: result.stations };
  }

  /**
   * Takes a line off the bill with a reason and a supervisor's PIN (rule #8).
   *
   * The line is NOT deleted. It stays with `voidedAt` set, excluded from every
   * total and printed nowhere, because the evidence is the point: at the end of
   * the month the owner has to be able to ask what was thrown away and who
   * signed for it, and a deleted row answers nothing.
   *
   * This works on unfired lines too, even though those can simply be removed.
   * The difference is recorded rather than enforced: `wasFired` is what
   * separates "changed their mind before we started" from real food in the bin.
   */
  async voidLine(
    branch: Branch,
    actor: Actor,
    orderId: string,
    lineId: string,
    input: VoidLineRequest,
  ): Promise<OrderDto> {
    // Deliberately before the transaction: bcrypt takes ~100ms and a Postgres
    // transaction held open for that long, on every void, during a rush, is how
    // a till starts feeling slow for reasons nobody can find later.
    const approver = await verifyApproval(this.db, {
      branchId: branch.id,
      requestedByStaffId: actor.staffId,
      approverStaffId: input.approverStaffId,
      approverPin: input.approverPin,
      permission: VOID_APPROVAL,
      what: 'ยกเลิกรายการ',
    });

    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      const line = await tx.orderLine.findFirst({
        where: { id: lineId, orderId: current.id },
        include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!line) throw notFound('ORDER_LINE_NOT_FOUND', 'ไม่พบรายการนี้ในบิล');
      if (line.voidedAt) throw conflict('LINE_ALREADY_VOIDED', 'รายการนี้ถูกยกเลิกไปแล้ว');

      const voidedAt = new Date();
      // The money that just left the bill, computed the same way the bill
      // computes it — so the void report and the takings cannot disagree.
      const { lineTotalSatang } = calculateLineTotal(toSnapshot(line));

      await tx.orderLine.update({ where: { id: line.id }, data: { voidedAt } });

      await tx.voidLog.create({
        data: {
          branchId: branch.id,
          orderId: current.id,
          orderLineId: line.id,
          nameSnapshot: line.nameSnapshot,
          qty: line.qty,
          amountSatang: lineTotalSatang,
          reason: input.reason,
          note: input.note ?? null,
          requestedByStaffId: actor.staffId,
          approvedByStaffId: approver.staffId,
          // True means the kitchen had it: a real loss, not a correction.
          wasFired: line.firedAt !== null,
        },
      });

      await this.audit(tx, branch.id, actor, 'VOID_LINE', 'OrderLine', line.id, {
        before: {
          nameSnapshot: line.nameSnapshot,
          qty: line.qty,
          amountSatang: lineTotalSatang,
          modifiers: modifierNames(line.modifiers),
          wasFired: line.firedAt !== null,
        },
        after: { voidedAt: voidedAt.toISOString(), approvedBy: approver.fullName },
      });

      // The cook has to be told to stop, and a ticket with nothing left on it
      // must leave the board instead of sitting there going red.
      await settleTicketsForLines(tx, branch.id, [line.id]);

      return this.recalculate(tx, branch, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /**
   * Takes money off a bill.
   *
   * The only way money leaves a bill without food leaving the kitchen, which is
   * why it is signed exactly like a void (rule #8): a supervisor's PIN, a reason
   * off a fixed list, and a row in the audit log naming both people.
   *
   * SETTING A DISCOUNT REPLACES ANY EARLIER ONE — it does not stack. Two taps on
   * the button meaning "฿40 off" instead of "฿20 off" is the reading nobody has
   * to be told, and stacking would make a double-tap during a rush cost real
   * money. The log keeps both events, so an accumulation that WAS intended is
   * still visible afterwards.
   *
   * ONLINE ONLY, and not by omission: the PIN is checked against a bcrypt hash
   * that the tablet does not have and must never hold. A discount agreed while
   * the wifi is down is agreed on paper and typed in when it comes back.
   */
  async setDiscount(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: DiscountRequest,
  ): Promise<OrderDto> {
    // Outside the transaction, for the same reason as voidLine: bcrypt is slow.
    const approver = await verifyApproval(this.db, {
      branchId: branch.id,
      requestedByStaffId: actor.staffId,
      approverStaffId: input.approverStaffId,
      approverPin: input.approverPin,
      permission: DISCOUNT_APPROVAL,
      what: 'ส่วนลด',
    });

    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);

      // The gross the percentage is worked out against, and the ceiling an
      // amount is measured against — computed here rather than taken from the
      // cached column so a stale total cannot widen a discount.
      const { grossSatang } = calculateOrderTotal(
        current.lines.map(toSnapshot),
        vatConfigOf(branch, formatDateColumn(current.businessDate)),
      );
      if (grossSatang === 0) {
        throw conflict('ORDER_EMPTY', 'บิลยังไม่มีรายการ — ลดราคาไม่ได้');
      }

      const requested = resolveDiscount(input, grossSatang);
      if (requested > grossSatang) {
        throw badRequest(
          'DISCOUNT_TOO_LARGE',
          `ส่วนลด ${formatSatang(requested)} บาท มากกว่ายอดบิล ${formatSatang(grossSatang)} บาท`,
        );
      }

      await tx.order.update({ where: { id: current.id }, data: { discountSatang: requested } });

      await this.audit(tx, branch.id, actor, 'SET_DISCOUNT', 'Order', current.id, {
        before: { discountSatang: current.discountSatang, grossSatang },
        after: {
          discountSatang: requested,
          // What was TYPED, kept alongside what it became. A percentage that is
          // only stored as satang cannot be read back as "10%" next month.
          mode: input.mode,
          value: input.value,
          reason: input.reason,
          note: input.note,
          describe: describeDiscount(input),
          approvedBy: approver.fullName,
        },
      });

      return this.recalculate(tx, branch, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /**
   * Puts the money back.
   *
   * Needs the same PIN as giving it: removing a discount raises what the
   * customer pays, and a bill that quietly got dearer between the quote and the
   * till is the version of this that ends in an argument.
   */
  async clearDiscount(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: ClearDiscountRequest,
  ): Promise<OrderDto> {
    const approver = await verifyApproval(this.db, {
      branchId: branch.id,
      requestedByStaffId: actor.staffId,
      approverStaffId: input.approverStaffId,
      approverPin: input.approverPin,
      permission: DISCOUNT_APPROVAL,
      what: 'ส่วนลด',
    });

    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      if (current.discountSatang === 0) {
        throw conflict('NO_DISCOUNT', 'บิลนี้ไม่มีส่วนลดอยู่แล้ว');
      }

      await tx.order.update({ where: { id: current.id }, data: { discountSatang: 0 } });

      await this.audit(tx, branch.id, actor, 'CLEAR_DISCOUNT', 'Order', current.id, {
        before: { discountSatang: current.discountSatang },
        after: { discountSatang: 0, approvedBy: approver.fullName },
      });

      return this.recalculate(tx, branch, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /* ------------------------------------------------------------------ */
  /* moving bills around: ย้ายโต๊ะ / รวมบิล / แยกบิล                        */
  /* ------------------------------------------------------------------ */

  /**
   * ย้ายโต๊ะ — the same bill, a different table.
   *
   * The target table may already have bills on it. That used to be impossible
   * and is not any more: since แยกบิล a table carries however many bills the
   * people sitting at it want, which is what TableSession has modelled since
   * Step 0. Two groups pushing their tables together and still paying
   * separately is a real thing, and forbidding it here would force the shop to
   * merge bills that are not the same bill.
   *
   * What DOES follow the bill is the kitchen. A ticket still being cooked is an
   * instruction to carry food to a table, so its table name is rewritten. A
   * ticket already DONE is left alone: that food was carried to the old table,
   * and rewriting it would make the record lie about where it went.
   */
  async moveTable(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: MoveTableRequest,
  ): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      if (current.channel !== OrderChannel.DINE_IN) {
        throw conflict('NOT_DINE_IN', 'บิลกลับบ้าน/เดลิเวอรี ไม่มีโต๊ะให้ย้าย');
      }

      const target = await tx.diningTable.findFirst({
        where: { id: input.tableId, branchId: branch.id, isActive: true },
        select: { id: true, name: true },
      });
      if (!target) throw notFound('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้ หรือโต๊ะถูกปิดใช้งาน');
      if (target.id === current.tableId) {
        throw badRequest('SAME_TABLE', `บิลนี้อยู่ที่โต๊ะ ${target.name} อยู่แล้ว`);
      }

      const fromTable = current.table?.name ?? null;
      const sessionId = await this.sittingAt(tx, branch.id, target.id);

      await tx.order.update({
        where: { id: current.id },
        data: { tableId: target.id, sessionId },
      });

      // Only what is still coming out of the kitchen.
      await tx.kitchenTicket.updateMany({
        where: {
          orderId: current.id,
          status: { in: [TicketStatus.PENDING, TicketStatus.IN_PROGRESS] },
        },
        data: { tableName: target.name },
      });

      await this.audit(tx, branch.id, actor, BILL_MOVE_ACTIONS.MOVE_TABLE, 'Order', current.id, {
        before: { tableId: current.tableId, tableName: fromTable },
        after: {
          tableId: target.id,
          tableName: target.name,
          describe: describeTableMove(fromTable, target.name),
        },
      });

      // The table it left may now be empty. Excluding this bill is belt and
      // braces — it has already moved to the other sitting.
      await this.closeSessionIfEmpty(tx, branch.id, current.sessionId, current.id);

      return this.reload(tx, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /**
   * รวมบิล — everything on `fromOrderId` moves onto `orderId`, and the emptied
   * bill is cancelled.
   *
   * VOIDED LINES DO NOT COME ALONG. A void is the record of something that
   * happened on that bill (rule #8) and its VoidLog points at it; dragging it
   * onto a bill where the argument never happened would put a stranger's
   * cancelled bowl in front of this customer. So the cancelled bill keeps its
   * voids, and that is the whole reason it is CANCELLED rather than deleted.
   *
   * Lines a customer's phone sent and nobody has answered yet DO come along —
   * left behind on a cancelled bill they would drop off the approvals screen
   * silently, and a request that vanishes is worse than one that is refused.
   */
  async mergeBills(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: MergeBillsRequest,
  ): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const target = await this.loadOpenOrder(tx, branch.id, orderId);
      const source = await this.loadOpenOrder(tx, branch.id, input.fromOrderId);

      const check = canMergeBills(toMergeCandidate(target), toMergeCandidate(source));
      if (!check.ok) {
        // SAME_BILL is the client sending nonsense; the rest are states of the
        // world that were true when the cashier pressed the button.
        throw check.refusal === 'SAME_BILL'
          ? badRequest(check.refusal, check.message)
          : conflict(check.refusal, check.message);
      }

      const moving = source.lines.filter((line) => line.voidedAt === null);
      const base = target.lines.reduce((max, line) => Math.max(max, line.sortOrder), -1) + 1;

      // One at a time so each line keeps its position relative to the others.
      // updateMany cannot write a different sortOrder per row.
      for (const [index, line] of moving.entries()) {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { orderId: target.id, sortOrder: base + index },
        });
      }

      // The board must stop naming a bill that is about to be cancelled.
      await tx.kitchenTicket.updateMany({
        where: { orderId: source.id },
        data: {
          orderId: target.id,
          ...(target.table ? { tableName: target.table.name } : {}),
        },
      });

      // The bill-level note is a remark about the table, not about a dish, so
      // it only survives if the target has nothing of its own to say. The
      // original is kept in the audit row either way.
      if (!target.note && source.note) {
        await tx.order.update({ where: { id: target.id }, data: { note: source.note } });
      }

      await tx.order.update({
        where: { id: source.id },
        data: { status: OrderStatus.CANCELLED },
      });

      const sourceLabel = source.orderNo ?? source.id.slice(0, 8);
      const targetLabel = target.orderNo ?? target.id.slice(0, 8);
      const describe = describeMerge(sourceLabel, targetLabel, moving.length);

      // Two rows, because there are two bills and both have to explain
      // themselves. Looking up the cancelled one has to say where its food went.
      await this.audit(tx, branch.id, actor, BILL_MOVE_ACTIONS.MERGE, 'Order', target.id, {
        before: { lineCount: target.lines.length, note: target.note },
        after: { mergedFrom: source.id, mergedFromOrderNo: source.orderNo, describe },
      });
      await this.audit(tx, branch.id, actor, BILL_MOVE_ACTIONS.MERGE, 'Order', source.id, {
        before: { status: source.status, lineCount: source.lines.length },
        after: { status: OrderStatus.CANCELLED, mergedInto: target.id, describe },
      });

      await this.closeSessionIfEmpty(tx, branch.id, source.sessionId, source.id);
      // The source is now empty of live lines, so its own totals must stop
      // claiming a figure it no longer holds.
      await this.recalculate(tx, branch, source.id);

      return this.recalculate(tx, branch, target.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /**
   * แยกบิล — the chosen lines move onto a new bill AT THE SAME TABLE.
   *
   * The new bill joins the same TableSession: it is the same visit, being paid
   * for by more than one person. It also inherits the ORIGINAL BILL'S BUSINESS
   * DATE rather than today's — splitting a bill at 00:30 that was opened at
   * 23:00 must not push half the table's food into tomorrow's takings (rule #4).
   *
   * KITCHEN TICKETS STAY WHERE THEY WERE FIRED, on purpose. A ticket records a
   * kitchen event — this food was ordered, from this table, at this time — and
   * one ticket can hold lines that are now on both bills. Splitting who pays
   * re-cooks nothing, and the ticket's table name is still right because the
   * new bill is at the same table. Settling works off line ids, so a ticket
   * whose lines have gone to two bills still closes correctly.
   */
  async splitBill(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: SplitBillRequest,
  ): Promise<{ order: OrderDto; newOrder: OrderDto }> {
    // Rule #6: the id came from the tablet, so a retried request is the SAME
    // split, not a second one. Checked before the transaction so a retry costs
    // a read rather than an advisory lock.
    const already = await this.db.order.findUnique({
      where: { id: input.newOrderId },
      include: ORDER_INCLUDE,
    });
    if (already) {
      if (already.branchId !== branch.id) {
        throw conflict('ORDER_ID_TAKEN', 'รหัสบิลนี้ถูกใช้ในสาขาอื่นแล้ว');
      }
      const source = await this.db.order.findFirstOrThrow({
        where: { id: orderId, branchId: branch.id },
        include: ORDER_INCLUDE,
      });
      return {
        order: toOrderDto(source, canSeeCost(actor)),
        newOrder: toOrderDto(already, canSeeCost(actor)),
      };
    }

    const result = await this.withOrderNoRetry(async () =>
      this.db.$transaction(async (tx) => {
        const current = await this.loadOpenOrder(tx, branch.id, orderId);
        const businessDate = formatDateColumn(current.businessDate);

        // Same lock, same reason, same position as opening a bill: this
        // transaction is about to hand out a running number for the day.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-no:${branch.id}:${businessDate}`}))`;

        // Validated against the DTO the tablet was looking at, using the exact
        // function the dialog used to enable its button.
        const check = planSplit(toOrderDto(current, true), input.lineIds);
        if (!check.ok) {
          throw check.refusal === 'WOULD_EMPTY_BILL' || check.refusal === 'DISCOUNTED'
            ? conflict(check.refusal, check.message)
            : badRequest(check.refusal, check.message);
        }

        const created = await this.createWithOrderNo(tx, {
          id: input.newOrderId,
          branchId: branch.id,
          tableId: current.tableId,
          // The same sitting. Splitting the bill does not start a second visit.
          sessionId: current.sessionId,
          channel: current.channel,
          businessDate,
          note: null,
          vat: vatConfigOf(branch, businessDate),
        });

        for (const [index, line] of check.plan.moving.entries()) {
          await tx.orderLine.update({
            where: { id: line.id },
            data: { orderId: created.id, sortOrder: index },
          });
        }

        const describe = describeSplit(
          current.orderNo ?? current.id.slice(0, 8),
          check.plan.moving.length,
        );
        await this.audit(tx, branch.id, actor, BILL_MOVE_ACTIONS.SPLIT, 'Order', current.id, {
          before: { lineCount: current.lines.length },
          after: {
            splitTo: created.id,
            splitToOrderNo: created.orderNo,
            movedLineIds: check.plan.moving.map((line) => line.id),
            describe,
          },
        });
        await this.audit(tx, branch.id, actor, BILL_MOVE_ACTIONS.SPLIT, 'Order', created.id, {
          before: null,
          after: { splitFrom: current.id, splitFromOrderNo: current.orderNo, describe },
        });

        return {
          order: await this.recalculate(tx, branch, current.id),
          newOrder: await this.recalculate(tx, branch, created.id),
        };
      }),
    );

    return {
      order: toOrderDto(result.order, canSeeCost(actor)),
      newOrder: toOrderDto(result.newOrder, canSeeCost(actor)),
    };
  }

  /** The open sitting at a table, started if there is not one yet. */
  private async sittingAt(
    tx: Prisma.TransactionClient,
    branchId: string,
    tableId: string,
  ): Promise<string> {
    const open = await tx.tableSession.findFirst({
      where: { branchId, tableId, closedAt: null },
      select: { id: true },
    });
    if (open) return open.id;

    const created = await tx.tableSession.create({
      data: { branchId, tableId },
      select: { id: true },
    });
    return created.id;
  }

  /** Closes an empty bill so a table can be freed after a mis-tap. */
  async cancelOrder(branch: Branch, actor: Actor, orderId: string): Promise<OrderDto> {
    const order = await this.db.$transaction(async (tx) => {
      const current = await this.loadOpenOrder(tx, branch.id, orderId);
      const active = current.lines.filter((line) => !line.voidedAt);
      if (active.length > 0) {
        throw conflict('ORDER_NOT_EMPTY', 'ยกเลิกได้เฉพาะบิลที่ยังไม่มีรายการ — ลบรายการออกก่อน');
      }

      await tx.order.update({
        where: { id: current.id },
        data: { status: OrderStatus.CANCELLED },
      });
      await this.audit(tx, branch.id, actor, 'CANCEL_ORDER', 'Order', current.id, {
        before: { status: current.status },
        after: { status: OrderStatus.CANCELLED },
      });
      await this.closeSessionIfEmpty(tx, branch.id, current.sessionId, current.id);

      return this.reload(tx, current.id);
    });

    return toOrderDto(order, canSeeCost(actor));
  }

  /* ------------------------------------------------------------------ */
  /* printing & payment                                                  */
  /* ------------------------------------------------------------------ */

  /** ใบแจ้งยอด — no document number, no drawer, nothing is settled. */
  async printCheck(
    branch: Branch,
    actor: Actor,
    orderId: string,
    options: { width?: number; station?: string },
  ): Promise<{ jobId: string }> {
    const order = await this.db.order.findFirst({
      where: { id: orderId, branchId: branch.id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw notFound('ORDER_NOT_FOUND', 'ไม่พบบิลนี้');
    if (order.status !== OrderStatus.OPEN) {
      throw conflict('ORDER_NOT_OPEN', 'บิลนี้ปิดไปแล้ว');
    }
    if (sellableLines(order).length === 0) {
      throw conflict('ORDER_EMPTY', 'บิลยังไม่มีรายการ');
    }

    const totals = calculateOrderTotal(
      order.lines.map(toSnapshot),
      vatConfigOf(branch, formatDateColumn(order.businessDate)),
      order.discountSatang,
    );
    const document = buildBillCheck({
      shop: shopHeaderOf(branch),
      orderNo: order.orderNo,
      tableName: order.table?.name ?? null,
      channelLabel: CHANNEL_LABEL[order.channel],
      openedAt: order.openedAt,
      printedAt: new Date(),
      staffName: actor.fullName,
      lines: billLinesOf(order),
      totals,
      width: options.width ?? WIDTH_80MM,
    });

    const job = await this.print.enqueue({
      branchId: branch.id,
      station: options.station ?? 'counter',
      type: PrintJobType.RECEIPT,
      document,
      orderId: order.id,
    });
    return { jobId: job.id };
  }

  /**
   * Takes the money and closes the bill.
   *
   * Everything that must be true together — the receipt number, the payment
   * row, the PAID status, the freed table — happens in ONE transaction. The
   * print job is queued AFTERWARDS, on purpose: a printer that is out of paper
   * must not roll back a sale that already happened. The job is durable and
   * retries on its own (Step 1).
   */
  async pay(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: PayOrderRequest,
  ): Promise<{
    order: OrderDto;
    receiptNo: string;
    changeSatang: number;
    printJobId: string | null;
  }> {
    const result = await this.db.$transaction(async (tx) => {
      const order = await this.loadOpenOrder(tx, branch.id, orderId);

      // Checked BEFORE "is the bill empty", because a bill holding nothing but
      // unanswered QR requests is not empty to the customer sitting at it.
      //
      // This is the rail that stops the shop giving food away: the cashier is
      // about to take money for a total that leaves out a bowl the customer
      // believes they ordered, the bill then closes, and the request is
      // stranded on a bill nobody will open again.
      const waiting = order.lines.filter((line) => !line.voidedAt && isAwaitingApproval(line));
      if (waiting.length > 0) {
        throw conflict(
          'QR_APPROVAL_PENDING',
          `มี ${waiting.length} รายการจาก QR ที่ยังไม่ได้ตอบ — กดยืนยันหรือปฏิเสธก่อนรับเงิน`,
        );
      }

      const activeLines = sellableLines(order);
      if (activeLines.length === 0) {
        throw conflict('ORDER_EMPTY', 'บิลยังไม่มีรายการ — รับเงินไม่ได้');
      }

      // Recomputed here, never trusted from the request. The client's idea of
      // the total is a display; this is the one that becomes money.
      const totals = calculateOrderTotal(
        order.lines.map(toSnapshot),
        vatConfigOf(branch, formatDateColumn(order.businessDate)),
        order.discountSatang,
      );

      let receivedSatang: number | null = null;
      let changeSatang = 0;

      if (input.method === PaymentMethod.CASH) {
        receivedSatang = input.receivedSatang as number;
        const change = calculateChange(totals.totalSatang, receivedSatang);
        if (change === null) {
          throw badRequest(
            'INSUFFICIENT_CASH',
            `รับเงินมา ${formatSatang(receivedSatang)} บาท น้อยกว่ายอด ${formatSatang(totals.totalSatang)} บาท`,
          );
        }
        changeSatang = change;
      }

      const businessDate = formatDateColumn(order.businessDate);
      const receiptNo = await allocateDocNumber(
        tx,
        branch,
        DocType.RECEIPT,
        Number(businessDate.slice(0, 4)),
      );

      const paidAt = new Date();

      await tx.payment.create({
        data: {
          branchId: branch.id,
          orderId: order.id,
          method: input.method,
          amountSatang: totals.totalSatang,
          receivedSatang,
          changeSatang,
          referenceNo: input.referenceNo ?? null,
          paidAt,
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.PAID,
          paidAt,
          receiptNo,
          subtotalExVatSatang: totals.subtotalExVatSatang,
          vatAmountSatang: totals.vatAmountSatang,
          vatRateBpSnapshot: totals.vatRateBpSnapshot,
          isVatInclusive: totals.isVatInclusive,
          totalSatang: totals.totalSatang,
          costSatang: totals.costSatang,
          // Frozen with the rest of the bill: whatever the discount was worth
          // at the moment the money changed hands is what the receipt says.
          discountSatang: totals.discountSatang,
        },
      });

      await this.closeSessionIfEmpty(tx, branch.id, order.sessionId, order.id);

      const paid = await this.reload(tx, order.id);
      return { paid, totals, receiptNo, changeSatang, receivedSatang, paidAt };
    });

    const document = buildSalesReceipt({
      shop: shopHeaderOf(branch),
      receiptNo: result.receiptNo,
      orderNo: result.paid.orderNo,
      tableName: result.paid.table?.name ?? null,
      channelLabel: CHANNEL_LABEL[result.paid.channel],
      openedAt: result.paid.openedAt,
      printedAt: result.paidAt,
      paidAt: result.paidAt,
      staffName: actor.fullName,
      lines: billLinesOf(result.paid),
      totals: result.totals,
      payment: {
        method: input.method,
        amountSatang: result.totals.totalSatang,
        receivedSatang: result.receivedSatang,
        changeSatang: input.method === PaymentMethod.CASH ? result.changeSatang : null,
        referenceNo: input.referenceNo ?? null,
      },
      // Only cash opens the drawer. Banging it open on a transfer trains staff
      // to leave it open, which is how a till goes missing.
      openDrawer: input.method === PaymentMethod.CASH,
      width: input.width ?? WIDTH_80MM,
    });

    let printJobId: string | null = null;
    try {
      const job = await this.print.enqueue({
        branchId: branch.id,
        station: input.station ?? 'counter',
        type: PrintJobType.RECEIPT,
        document,
        orderId: result.paid.id,
      });
      printJobId = job.id;
    } catch {
      // The sale is already recorded. A failed queue insert must show as "the
      // receipt did not print", never as "the payment failed" — the customer
      // has handed over the money either way.
      printJobId = null;
    }

    return {
      order: toOrderDto(result.paid, canSeeCost(actor)),
      receiptNo: result.receiptNo,
      changeSatang: result.changeSatang,
      printJobId,
    };
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  private async loadOpenOrder(
    tx: Prisma.TransactionClient,
    branchId: string,
    orderId: string,
  ): Promise<OrderWithLines> {
    const order = await tx.order.findFirst({
      where: { id: orderId, branchId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw notFound('ORDER_NOT_FOUND', 'ไม่พบบิลนี้');
    if (order.status !== OrderStatus.OPEN) {
      throw conflict(
        'ORDER_NOT_OPEN',
        order.status === OrderStatus.PAID ? 'บิลนี้ชำระเงินแล้ว' : 'บิลนี้ถูกยกเลิกแล้ว',
      );
    }
    return order;
  }

  private async loadEditableLine(tx: Prisma.TransactionClient, orderId: string, lineId: string) {
    const line = await tx.orderLine.findFirst({
      where: { id: lineId, orderId },
      // The options come along so the audit trail can record what the bowl was
      // before it was changed, not just that it changed (rule #8).
      include: { modifiers: true },
    });
    if (!line) throw notFound('ORDER_LINE_NOT_FOUND', 'ไม่พบรายการนี้ในบิล');
    if (line.voidedAt) throw conflict('LINE_VOIDED', 'รายการนี้ถูกยกเลิกไปแล้ว');
    if (line.firedAt) {
      throw conflict(
        'LINE_ALREADY_FIRED',
        'รายการนี้ส่งครัวแล้ว ต้องยกเลิกโดยผู้จัดการพร้อมระบุเหตุผล',
      );
    }
    return line;
  }

  private async reload(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithLines> {
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
  }

  /**
   * Rewrites the cached totals from the lines. Called after every line change.
   *
   * The stored discount is an INPUT here, and the CLAMPED one is written back:
   * voiding the last bowl on a bill that had ฿20 off must not leave ฿20 sitting
   * in the column while the total says ฿0. What the bill carries and what the
   * screen shows are then always the same number — the amount that was actually
   * agreed lives in the audit log, which is where a disagreement gets settled.
   */
  private async recalculate(
    tx: Prisma.TransactionClient,
    branch: Branch,
    orderId: string,
  ): Promise<OrderWithLines> {
    const order = await this.reload(tx, orderId);
    const totals = calculateOrderTotal(
      order.lines.map(toSnapshot),
      vatConfigOf(branch, formatDateColumn(order.businessDate)),
      order.discountSatang,
    );

    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotalExVatSatang: totals.subtotalExVatSatang,
        vatAmountSatang: totals.vatAmountSatang,
        vatRateBpSnapshot: totals.vatRateBpSnapshot,
        isVatInclusive: totals.isVatInclusive,
        totalSatang: totals.totalSatang,
        costSatang: totals.costSatang,
        discountSatang: totals.discountSatang,
      },
    });

    return this.reload(tx, orderId);
  }

  /**
   * Inserts the bill with the next running number for the day.
   *
   * The number is `YYMMDD-NNN`, unique per branch because the date is in it —
   * `@@unique([branchId, orderNo])` is global, so a bare `042` would collide
   * with tomorrow's. Two cashiers can still race for the same NNN, so a unique
   * violation is retried (by the caller, outside this transaction) rather than
   * prevented; that is cheaper than locking the table on every new bill.
   */
  private async createWithOrderNo(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      branchId: string;
      tableId: string | null;
      sessionId: string | null;
      channel: OrderChannel;
      businessDate: string;
      note: string | null;
      vat: VatConfig;
    },
  ): Promise<OrderWithLines> {
    const prefix = input.businessDate.slice(2).replace(/-/g, '');
    const dateColumn = toDateColumn(input.businessDate);

    // The next number is HIGHEST + 1, not COUNT + 1.
    //
    // Counting looks equivalent and is not: it assumes no row is ever removed.
    // Remove one bill from the day — a data fix, a purge, a cleanup — and the
    // count drops below the numbers already handed out, so the next bill is
    // issued a number that exists. The retry cannot save it either, because
    // recounting produces the same answer every time; it just loops and fails.
    // Gaps are fine. Duplicates are not.
    const today = await tx.order.findMany({
      where: { branchId: input.branchId, businessDate: dateColumn },
      select: { orderNo: true },
    });
    const highest = today.reduce((max, row) => {
      const suffix = Number(row.orderNo?.split('-')[1] ?? Number.NaN);
      return Number.isInteger(suffix) && suffix > max ? suffix : max;
    }, 0);

    return tx.order.create({
      data: {
        id: input.id,
        branchId: input.branchId,
        tableId: input.tableId,
        sessionId: input.sessionId,
        orderNo: `${prefix}-${String(highest + 1).padStart(3, '0')}`,
        channel: input.channel,
        businessDate: dateColumn,
        note: input.note,
        // An empty bill still records which VAT regime it opened under.
        vatRateBpSnapshot: input.vat.enabled ? input.vat.rateBp : 0,
        isVatInclusive: input.vat.priceIncludesVat,
      },
      include: ORDER_INCLUDE,
    });
  }

  /** Frees the table once its last bill is closed. */
  private async closeSessionIfEmpty(
    tx: Prisma.TransactionClient,
    branchId: string,
    sessionId: string | null,
    excludeOrderId: string,
  ): Promise<void> {
    if (!sessionId) return;
    const stillOpen = await tx.order.count({
      where: {
        branchId,
        sessionId,
        status: OrderStatus.OPEN,
        id: { not: excludeOrderId },
      },
    });
    if (stillOpen === 0) {
      await tx.tableSession.updateMany({
        where: { id: sessionId, closedAt: null },
        data: { closedAt: new Date() },
      });
    }
  }

  /** Rule #8: who changed what, when, and what it looked like before. */
  private async audit(
    tx: Prisma.TransactionClient,
    branchId: string,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    change: { before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue | null },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        branchId,
        staffId: actor.staffId,
        action,
        entityType,
        entityId,
        before: change.before ?? Prisma.JsonNull,
        after: change.after ?? Prisma.JsonNull,
      },
    });
  }
}

/* ------------------------------------------------------------------ */

function canSeeCost(actor: Actor): boolean {
  return can(actor.role, Permission.VIEW_COST);
}

/**
 * A stored bill, narrowed to what canMergeBills asks about.
 *
 * Goes through toOrderDto so the check runs against the same shape the tablet
 * saw — a second, hand-rolled translation here is where the two sides would
 * quietly start disagreeing about what "voided" means.
 */
function toMergeCandidate(order: OrderWithLines): MergeCandidate {
  const dto = toOrderDto(order, true);
  return {
    id: dto.id,
    status: dto.status,
    businessDate: dto.businessDate,
    discountSatang: dto.discountSatang,
    lines: dto.lines,
  };
}

/**
 * The VAT settings that apply to a bill trading on `businessDate` (Step 10).
 *
 * Takes the date rather than reading the switch, because a bill is totalled
 * more than once: when a line is added, when the check is printed, when the
 * money is taken, and again by every report that sums the day. Reading the
 * switch's CURRENT position would make the day a shop registers for VAT
 * retroactive — every bill of the preceding weeks would re-total at 7% and
 * claim the shop collected tax it never remitted.
 */
export function vatConfigOf(branch: Branch, businessDate: string): VatConfig {
  return vatConfigForDate(
    {
      vatEnabled: branch.vatEnabled,
      vatRateBp: branch.vatRateBp,
      priceIncludesVat: branch.priceIncludesVat,
      vatEffectiveDate: branch.vatEffectiveDate ? formatDateColumn(branch.vatEffectiveDate) : null,
    },
    businessDate,
  );
}

export function shopHeaderOf(branch: Branch) {
  return {
    name: branch.name,
    address: branch.address,
    phone: branch.phone,
    taxId: branch.taxId,
    branchCode: branch.branchCode,
  };
}

/**
 * The lines that are actually being sold.
 *
 * Two exclusions with two different reasons: a voided line WAS sold and was
 * taken back, so it stays on the bill as evidence and off every document; an
 * unapproved QR line was never sold at all.
 */
function sellableLines(order: OrderWithLines): OrderWithLines['lines'] {
  return order.lines.filter((line) => !line.voidedAt && !isAwaitingApproval(line));
}

/** What goes on a printed check or receipt — see sellableLines above. */
export function billLinesOf(order: OrderWithLines) {
  return sellableLines(order)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((line) => {
      const snapshot = toSnapshot(line);
      // Same function the totals use, so a printed line and the printed total
      // can never disagree.
      const { lineTotalSatang } = calculateLineTotal(snapshot);
      const modifiers = snapshot.modifiers?.map((modifier) => modifier.nameSnapshot) ?? [];
      return {
        qty: line.qty,
        name: line.nameSnapshot,
        amountSatang: lineTotalSatang,
        ...(modifiers.length > 0 ? { modifiers } : {}),
        ...(line.note ? { note: line.note } : {}),
      };
    });
}

function modifierNames(modifiers: readonly { nameSnapshot: string }[]): string[] {
  return modifiers.map((modifier) => modifier.nameSnapshot);
}

/**
 * True only for a clash on the day's running number.
 *
 * Narrow on purpose: a P2002 on the order ID means a client reused a UUID, and
 * retrying that would loop five times and still fail. Only the running number
 * is worth another go.
 */
/** True for the "this table already has a bill" conflict, and only that one. */
function isTableOccupied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'TABLE_OCCUPIED'
  );
}

function isOrderNoCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('orderNo'));
}

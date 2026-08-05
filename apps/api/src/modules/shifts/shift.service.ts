/**
 * Opening the till, closing it, and counting what is in the drawer.
 *
 * A shift is a TIME WINDOW at one branch. Everything measured here is measured
 * by falling inside `openedAt .. closedAt`, which is why the service refuses to
 * open a second one while the first is still running: two overlapping windows
 * would count the same ฿50 note twice, and no arithmetic afterwards could pull
 * them apart.
 *
 * THE SHIFT DOES NOT GATE THE TILL. Selling with no shift open is allowed, and
 * that cash simply is not in any shift's expected figure — it shows up as a
 * surplus at the next count, which reads as "someone forgot to press เปิดกะ".
 * That is the truth, and it is a better failure than a locked till at 7am on a
 * morning when the person who knows the routine is off sick.
 *
 * WHY `paidAt` AND `createdAt` RATHER THAN `businessDate`: rule #4 puts sales
 * on the trading day they belong to, which is right for the P&L and wrong here.
 * The drawer does not care what day the shop calls it — it cares what physically
 * went in and out between the moment it was opened and the moment it was
 * counted. A shift that crosses the 04:00 cutoff is one drawer, one count.
 */

import type { Prisma, PrismaClient, Shift } from '@prisma/client';
import {
  cashVarianceSatang,
  expectedCashSatang,
  PaidBy,
  PaymentMethod,
  type CloseShiftRequest,
  type OpenShiftRequest,
  type ShiftDto,
} from '@pos/shared';
import { conflict, notFound } from '../../http-error.js';

/** Who is at the till, in the shape the routes already build. */
export interface Actor {
  staffId: string;
  fullName: string;
}

/** The live money figures for one window. */
interface WindowTotals {
  cashSalesSatang: number;
  transferSalesSatang: number;
  cashOutSatang: number;
  billCount: number;
}

export class ShiftService {
  constructor(private readonly db: PrismaClient) {}

  /** The open shift with its running figures, or null when the till is shut. */
  async current(branchId: string): Promise<ShiftDto | null> {
    const shift = await this.db.shift.findFirst({
      where: { branchId, closedAt: null },
      orderBy: { openedAt: 'desc' },
      include: { staff: { select: { fullName: true, nickname: true } } },
    });
    return shift ? this.toDto(shift, await this.totalsFor(shift)) : null;
  }

  async open(branchId: string, actor: Actor, input: OpenShiftRequest): Promise<ShiftDto> {
    const running = await this.db.shift.findFirst({ where: { branchId, closedAt: null } });
    if (running) {
      throw conflict('SHIFT_ALREADY_OPEN', 'กะนี้เปิดอยู่แล้ว — ปิดกะเดิมก่อนถึงจะเปิดใหม่ได้');
    }

    const shift = await this.db.shift.create({
      data: {
        branchId,
        staffId: actor.staffId,
        openingCashSatang: input.openingCashSatang,
        note: input.note ?? null,
      },
      include: { staff: { select: { fullName: true, nickname: true } } },
    });

    await this.audit(branchId, actor, 'OPEN_SHIFT', shift.id, {
      before: null,
      after: { openingCashSatang: input.openingCashSatang, note: input.note ?? null },
    });

    return this.toDto(shift, await this.totalsFor(shift));
  }

  /**
   * Counts the drawer and shuts the window.
   *
   * `closedAt` is stamped FIRST and the totals are then measured against that
   * exact instant, so a bill paid while the cashier was counting either falls
   * inside the window or does not — it cannot fall in the gap between reading
   * the money and writing the row.
   *
   * The expected figure is computed here and only here. The request carries the
   * count and nothing else about the money (see shift.ts); a client that could
   * name its own expected total could close every shift dead level.
   */
  async close(branchId: string, actor: Actor, input: CloseShiftRequest): Promise<ShiftDto> {
    const running = await this.db.shift.findFirst({
      where: { branchId, closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    if (!running) throw notFound('NO_OPEN_SHIFT', 'ยังไม่ได้เปิดกะ — ไม่มีอะไรให้ปิด');

    const closedAt = new Date();
    const totals = await this.totalsFor({ ...running, closedAt });

    const expected = expectedCashSatang({
      openingCashSatang: running.openingCashSatang,
      cashSalesSatang: totals.cashSalesSatang,
      cashOutSatang: totals.cashOutSatang,
    });
    const variance = cashVarianceSatang(input.countedCashSatang, expected);

    const closed = await this.db.shift.update({
      where: { id: running.id },
      data: {
        closedAt,
        countedCashSatang: input.countedCashSatang,
        expectedCashSatang: expected,
        varianceSatang: variance,
        // The closing note REPLACES the opening one rather than appending: the
        // opening note is "ตั้งเงินทอนไว้ 2000" and the closing note is why the
        // count came out odd, and the second is the one anyone ever reads back.
        ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
      },
      include: { staff: { select: { fullName: true, nickname: true } } },
    });

    await this.audit(branchId, actor, 'CLOSE_SHIFT', running.id, {
      before: { openingCashSatang: running.openingCashSatang },
      after: {
        countedCashSatang: input.countedCashSatang,
        expectedCashSatang: expected,
        varianceSatang: variance,
        cashSalesSatang: totals.cashSalesSatang,
        cashOutSatang: totals.cashOutSatang,
        note: input.note ?? null,
      },
    });

    return this.toDto(closed, totals);
  }

  /**
   * Recent shifts, newest first.
   *
   * Closed ones carry their frozen figures; the open one (if any) is re-measured
   * live, because "what has this till taken so far" is a fair question to ask
   * halfway through a day.
   */
  async list(branchId: string, limit: number): Promise<ShiftDto[]> {
    const shifts = await this.db.shift.findMany({
      where: { branchId },
      orderBy: { openedAt: 'desc' },
      take: limit,
      include: { staff: { select: { fullName: true, nickname: true } } },
    });

    return Promise.all(shifts.map(async (shift) => this.toDto(shift, await this.totalsFor(shift))));
  }

  /* ---------------- internals ---------------- */

  /**
   * What moved through the drawer between `openedAt` and `closedAt ?? now`.
   *
   * Cash out is an Expense marked `paidBy: CASH`, matched on `createdAt` rather
   * than its business `date`: the business date says which trading day the cost
   * belongs to, but the drawer was emptied at the moment somebody typed it in.
   * Recording Monday's market run on Tuesday afternoon takes Tuesday's cash,
   * because that is the cash that was physically handed over.
   */
  private async totalsFor(shift: {
    branchId: string;
    openedAt: Date;
    closedAt: Date | null;
  }): Promise<WindowTotals> {
    const window = { gte: shift.openedAt, lte: shift.closedAt ?? new Date() };

    const [payments, cashOut] = await Promise.all([
      this.db.payment.groupBy({
        by: ['method'],
        where: { branchId: shift.branchId, paidAt: window },
        _sum: { amountSatang: true },
        _count: { _all: true },
      }),
      this.db.expense.aggregate({
        where: { branchId: shift.branchId, paidBy: PaidBy.CASH, createdAt: window },
        _sum: { amountSatang: true },
      }),
    ]);

    const sumOf = (method: string): number =>
      payments.find((row) => row.method === method)?._sum.amountSatang ?? 0;

    return {
      cashSalesSatang: sumOf(PaymentMethod.CASH),
      transferSalesSatang: sumOf(PaymentMethod.PROMPTPAY),
      cashOutSatang: cashOut._sum.amountSatang ?? 0,
      billCount: payments.reduce((count, row) => count + row._count._all, 0),
    };
  }

  private toDto(
    shift: Shift & { staff?: { fullName: string; nickname: string | null } },
    totals: WindowTotals,
  ): ShiftDto {
    return {
      id: shift.id,
      branchId: shift.branchId,
      staffId: shift.staffId,
      staffName: shift.staff?.nickname ?? shift.staff?.fullName ?? '',
      openedAt: shift.openedAt.toISOString(),
      closedAt: shift.closedAt?.toISOString() ?? null,

      openingCashSatang: shift.openingCashSatang,
      cashSalesSatang: totals.cashSalesSatang,
      cashOutSatang: totals.cashOutSatang,
      transferSalesSatang: totals.transferSalesSatang,
      billCount: totals.billCount,

      // Null while the shift is open, and that is the feature: a screen showing
      // what the drawer SHOULD hold, next to the box for what it DOES hold, is a
      // screen that gets the expected number typed into it.
      countedCashSatang: shift.countedCashSatang,
      expectedCashSatang: shift.expectedCashSatang,
      varianceSatang: shift.varianceSatang,

      note: shift.note,
    };
  }

  private async audit(
    branchId: string,
    actor: Actor,
    action: string,
    entityId: string,
    change: { before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue | null },
  ): Promise<void> {
    await this.db.auditLog.create({
      data: {
        branchId,
        staffId: actor.staffId,
        action,
        entityType: 'Shift',
        entityId,
        before: change.before ?? undefined,
        after: change.after ?? undefined,
      },
    });
  }
}

/**
 * Reading the money back out (Step 8).
 *
 * THE RULE THIS FILE IS BUILT AROUND: the P&L is CASH BASIS and the recipe
 * figures are a PRICING TOOL, and the two are never added together. The long
 * version of why is at the top of report.ts in @pos/shared; the short version
 * is that "ค่าวัตถุดิบที่ซื้อ" and "ต้นทุนอาหารตามสูตร" are two ways of
 * counting the same money, and a report that subtracts both tells a profitable
 * shop it is losing money.
 *
 * Everything here reads PAID orders only. An OPEN bill is food on a table, not
 * takings — but the daily report still counts them on a separate line, because
 * a number asked for at 6pm that silently omits four full tables is a number
 * that gets argued with at the till.
 *
 * Everything is scoped by businessDate (rule #4), never by createdAt. That
 * includes the voids: a void belongs to the trading day of the BILL it was
 * taken off, so a 00:30 cancellation lands in the same night as the sale it
 * reverses instead of opening the next day with a loss.
 */

import type { Branch, OrderLine, OrderLineModifier, PrismaClient } from '@prisma/client';
import {
  breakEvenSalesSatang,
  calculateLineTotal,
  contributionMarginBp,
  ExpenseCategory,
  isFixedExpense,
  monthRange,
  OrderStatus,
  percentBp,
  daysInMonth as daysInMonthOf,
  expenseKindOf,
  type AllBranchesResponse,
  type BreakEven,
  type DailyReportResponse,
  type PnlResponse,
  type RecipeCoverage,
  type VoidReportResponse,
  type VoidReportRow,
} from '@pos/shared';
import { formatDateColumn, toDateColumn, toSnapshot } from '../orders/order.mapper.js';

/** A half-open `@db.Date` filter. Half-open so no call site has to know how long a month is. */
interface DateRange {
  gte: Date;
  lt: Date;
}

interface SalesTotals {
  paidOrderCount: number;
  grossSalesSatang: number;
  discountSatang: number;
  vatSatang: number;
  netSalesSatang: number;
  recipeCostSatang: number;
}

export class ReportService {
  constructor(private readonly db: PrismaClient) {}

  /* ---------------- the daily close ---------------- */

  async daily(branch: Branch, businessDate: string): Promise<DailyReportResponse> {
    const day: DateRange = {
      gte: toDateColumn(businessDate),
      lt: toDateColumn(nextDay(businessDate)),
    };

    const [sales, coverage, payments, expenses, open, cancelledOrderCount, voids, creditNotes] =
      await Promise.all([
        this.salesTotals(branch.id, day),
        this.recipeCoverage(branch.id, day),
        this.db.payment.groupBy({
          by: ['method'],
          where: { branchId: branch.id, order: { status: OrderStatus.PAID, businessDate: day } },
          _count: { _all: true },
          _sum: { amountSatang: true },
        }),
        this.expensesByCategory(branch.id, day),
        this.db.order.aggregate({
          where: { branchId: branch.id, status: OrderStatus.OPEN, businessDate: day },
          _count: { _all: true },
          _sum: { totalSatang: true },
        }),
        this.db.order.count({
          where: { branchId: branch.id, status: OrderStatus.CANCELLED, businessDate: day },
        }),
        this.voidRows(branch.id, day),
        // Dated by the credit note's OWN business date: a bill paid last month
        // and credited today is today's refund and last month's lost sale.
        this.db.creditNote.aggregate({
          where: { branchId: branch.id, businessDate: day },
          _count: { _all: true },
          _sum: { totalSatang: true },
        }),
      ]);

    const expenseTotalSatang = expenses.reduce((sum, row) => sum + row.amountSatang, 0);

    return {
      businessDate,
      paidOrderCount: sales.paidOrderCount,
      grossSalesSatang: sales.grossSalesSatang,
      discountSatang: sales.discountSatang,
      vatSatang: sales.vatSatang,
      netSalesSatang: sales.netSalesSatang,
      averageBillSatang:
        sales.paidOrderCount === 0
          ? null
          : Math.round(sales.grossSalesSatang / sales.paidOrderCount),

      payments: payments.map((row) => ({
        method: row.method,
        count: row._count._all,
        amountSatang: row._sum.amountSatang ?? 0,
      })),

      recipeCostSatang: sales.recipeCostSatang,
      recipeCostPercentBp: percentBp(sales.recipeCostSatang, sales.netSalesSatang),
      grossProfitSatang: sales.netSalesSatang - sales.recipeCostSatang,
      coverage,

      expenseTotalSatang,
      byCategory: expenses,

      openOrderCount: open._count._all,
      openOrderTotalSatang: open._sum.totalSatang ?? 0,
      cancelledOrderCount,

      creditNoteCount: creditNotes._count._all,
      creditNoteSatang: creditNotes._sum.totalSatang ?? 0,

      voidCount: voids.length,
      voidFiredCount: voids.filter((row) => row.wasFired).length,
      voidSalesValueSatang: voids.reduce((sum, row) => sum + row.salesValueSatang, 0),
      voidCostSatang: voids.reduce((sum, row) => sum + row.costSatang, 0),
    };
  }

  /* ---------------- the monthly P&L ---------------- */

  async pnl(branch: Branch, yearMonth: string): Promise<PnlResponse> {
    const { start, endExclusive } = monthRange(yearMonth);
    const month: DateRange = { gte: toDateColumn(start), lt: toDateColumn(endExclusive) };

    const [sales, coverage, expenses] = await Promise.all([
      this.salesTotals(branch.id, month),
      this.recipeCoverage(branch.id, month),
      this.expensesByCategory(branch.id, month),
    ]);

    const byCategory = expenses.map((row) => ({ ...row, kind: expenseKindOf(row.category) }));
    const expenseTotalSatang = byCategory.reduce((sum, row) => sum + row.amountSatang, 0);

    return {
      yearMonth,
      paidOrderCount: sales.paidOrderCount,
      grossSalesSatang: sales.grossSalesSatang,
      discountSatang: sales.discountSatang,
      vatSatang: sales.vatSatang,
      netSalesSatang: sales.netSalesSatang,

      expenseTotalSatang,
      byCategory,
      // THE number, and it is deliberately net sales minus what actually went
      // out of the till — not net sales minus the recipe cost minus the
      // expenses, which would charge the shop for its ingredients twice.
      netProfitSatang: sales.netSalesSatang - expenseTotalSatang,

      recipeCostSatang: sales.recipeCostSatang,
      recipeCostPercentBp: percentBp(sales.recipeCostSatang, sales.netSalesSatang),
      contributionSatang: sales.netSalesSatang - sales.recipeCostSatang,
      coverage,

      breakEven: buildBreakEven(branch, yearMonth, sales, byCategory),
    };
  }

  /* ---------------- what got thrown away ---------------- */

  async voids(branch: Branch, from: string, to: string): Promise<VoidReportResponse> {
    const range: DateRange = { gte: toDateColumn(from), lt: toDateColumn(nextDay(to)) };
    const rows = await this.voidRows(branch.id, range);

    const byReason = new Map<string, VoidReportResponse['byReason'][number]>();
    for (const row of rows) {
      const bucket = byReason.get(row.reason) ?? {
        reason: row.reason,
        count: 0,
        qty: 0,
        salesValueSatang: 0,
        costSatang: 0,
        firedCount: 0,
      };
      bucket.count += 1;
      bucket.qty += row.qty;
      bucket.salesValueSatang += row.salesValueSatang;
      bucket.costSatang += row.costSatang;
      if (row.wasFired) bucket.firedCount += 1;
      byReason.set(row.reason, bucket);
    }

    const fired = rows.filter((row) => row.wasFired);

    return {
      from,
      to,
      totalCount: rows.length,
      totalQty: rows.reduce((sum, row) => sum + row.qty, 0),
      salesValueSatang: rows.reduce((sum, row) => sum + row.salesValueSatang, 0),
      costSatang: rows.reduce((sum, row) => sum + row.costSatang, 0),
      firedCount: fired.length,
      // The only figure here that is money the shop genuinely lost: food that
      // was already being cooked when the line was killed.
      firedCostSatang: fired.reduce((sum, row) => sum + row.costSatang, 0),
      byReason: [...byReason.values()].sort((a, b) => b.costSatang - a.costSatang),
      rows,
    };
  }

  /* ---------------- shared queries ---------------- */

  /* ---------------- every branch at once (Step 10) ---------------- */

  /**
   * One line per branch for a single trading day.
   *
   * THE ONLY PLACE IN THE API THAT READS ACROSS BRANCHES, and it is read-only,
   * behind VIEW_ALL_BRANCHES (owner), and takes no branch id from the caller —
   * it lists every branch or none. Rule #1 protects a branch's data from
   * ANOTHER BRANCH'S SESSION; the person who owns both shops is not another
   * branch.
   *
   * The date is applied as each branch's OWN businessDate, which is the one
   * thing that makes this comparable at all: two shops in different timezones,
   * or with different cutoff hours, do not share a clock, but "2026-08-01" is
   * an unambiguous trading day at each of them (rule #4).
   */
  async allBranches(businessDate: string, currentBranchId: string): Promise<AllBranchesResponse> {
    const day: DateRange = {
      gte: toDateColumn(businessDate),
      lt: toDateColumn(nextDay(businessDate)),
    };

    const branches = await this.db.branch.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, branchCode: true },
    });

    const rows = await Promise.all(
      branches.map(async (branch) => {
        const [sales, open, credits] = await Promise.all([
          this.salesTotals(branch.id, day),
          this.db.order.aggregate({
            where: { branchId: branch.id, status: OrderStatus.OPEN, businessDate: day },
            _count: { _all: true },
            _sum: { totalSatang: true },
          }),
          this.db.creditNote.aggregate({
            where: { branchId: branch.id, businessDate: day },
            _count: { _all: true },
            _sum: { totalSatang: true },
          }),
        ]);

        return {
          branchId: branch.id,
          branchName: branch.name,
          branchCode: branch.branchCode,
          isCurrent: branch.id === currentBranchId,

          paidOrderCount: sales.paidOrderCount,
          netSalesSatang: sales.netSalesSatang,
          vatSatang: sales.vatSatang,
          averageBillSatang:
            sales.paidOrderCount === 0
              ? null
              : Math.round(sales.grossSalesSatang / sales.paidOrderCount),
          openOrderCount: open._count._all,
          openOrderTotalSatang: open._sum.totalSatang ?? 0,
          creditNoteCount: credits._count._all,
          creditNoteSatang: credits._sum.totalSatang ?? 0,
        };
      }),
    );

    return {
      businessDate,
      rows,
      totalPaidOrderCount: rows.reduce((sum, row) => sum + row.paidOrderCount, 0),
      totalNetSalesSatang: rows.reduce((sum, row) => sum + row.netSalesSatang, 0),
    };
  }

  private async salesTotals(branchId: string, range: DateRange): Promise<SalesTotals> {
    const totals = await this.db.order.aggregate({
      where: { branchId, status: OrderStatus.PAID, businessDate: range },
      _count: { _all: true },
      _sum: {
        totalSatang: true,
        costSatang: true,
        discountSatang: true,
        vatAmountSatang: true,
      },
    });

    const grossSalesSatang = totals._sum.totalSatang ?? 0;
    const vatSatang = totals._sum.vatAmountSatang ?? 0;

    return {
      paidOrderCount: totals._count._all,
      grossSalesSatang,
      discountSatang: totals._sum.discountSatang ?? 0,
      vatSatang,
      // VAT is collected on behalf of the Revenue Department. Leaving it in
      // sales would inflate every margin on the page by the VAT rate, and the
      // day the switch is turned on the shop would look 7% more profitable
      // for doing nothing.
      netSalesSatang: grossSalesSatang - vatSatang,
      recipeCostSatang: totals._sum.costSatang ?? 0,
    };
  }

  /**
   * How many sold lines have a recipe behind them.
   *
   * `unitCostSatang = 0` means nobody has entered a BOM for that dish — no
   * ingredient in the shop is free. It is counted rather than valued because
   * the point is a caveat, not a measurement.
   *
   * Only lines on PAID bills, and never a voided one. An unapproved QR line
   * cannot appear here at all: pay() refuses a bill that still has one.
   */
  private async recipeCoverage(branchId: string, range: DateRange): Promise<RecipeCoverage> {
    const where = {
      branchId,
      voidedAt: null,
      order: { status: OrderStatus.PAID, businessDate: range },
    };
    const [soldLineCount, linesWithoutRecipeCount] = await Promise.all([
      this.db.orderLine.count({ where }),
      this.db.orderLine.count({ where: { ...where, unitCostSatang: 0 } }),
    ]);
    return { soldLineCount, linesWithoutRecipeCount };
  }

  private async expensesByCategory(
    branchId: string,
    range: DateRange,
  ): Promise<{ category: string; amountSatang: number }[]> {
    const grouped = await this.db.expense.groupBy({
      by: ['category'],
      where: { branchId, date: range },
      _sum: { amountSatang: true },
    });
    return grouped
      .map((row) => ({ category: row.category, amountSatang: row._sum.amountSatang ?? 0 }))
      .sort((a, b) => b.amountSatang - a.amountSatang);
  }

  /**
   * The voided lines of a period, priced twice.
   *
   * `salesValueSatang` is revenue that did not happen; `costSatang` is what the
   * food in the bin cost. They are wildly different numbers and only the second
   * is a loss — which is why the cost is recomputed from the order line's own
   * snapshots rather than read off VoidLog.amountSatang, which is a price.
   */
  private async voidRows(branchId: string, range: DateRange): Promise<VoidReportRow[]> {
    const logs = await this.db.voidLog.findMany({
      where: { branchId, order: { businessDate: range } },
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { orderNo: true, businessDate: true } },
        orderLine: { include: { modifiers: true } },
        requestedBy: { select: { fullName: true, nickname: true } },
        approvedBy: { select: { fullName: true, nickname: true } },
      },
    });

    return logs.map((log) => ({
      id: log.id,
      createdAt: log.createdAt.toISOString(),
      businessDate: formatDateColumn(log.order.businessDate),
      orderNo: log.order.orderNo,
      nameSnapshot: log.nameSnapshot,
      qty: log.qty,
      salesValueSatang: log.amountSatang,
      costSatang: voidedCostSatang(log.orderLine, log.qty),
      reason: log.reason,
      note: log.note,
      wasFired: log.wasFired,
      requestedByName: log.requestedBy.nickname ?? log.requestedBy.fullName,
      approvedByName: log.approvedBy.nickname ?? log.approvedBy.fullName,
    }));
  }
}

/* ------------------------------------------------------------------ */

/**
 * Cost of the food that was thrown away.
 *
 * Uses the VOID's qty against the line's effective unit cost, not the line's
 * own qty: they are the same today because a void takes the whole line, and
 * relying on that would break silently the day a partial void is added.
 *
 * A missing order line (the column is nullable) yields 0 rather than an
 * estimate — an invented number in a waste report is worse than a blank.
 */
function voidedCostSatang(
  line: (OrderLine & { modifiers: OrderLineModifier[] }) | null,
  qty: number,
): number {
  if (!line) return 0;
  return calculateLineTotal(toSnapshot(line)).effectiveUnitCostSatang * qty;
}

/**
 * The break-even block.
 *
 * Fixed costs come from the FIXED expense categories only. วัตถุดิบ is left
 * out on purpose — the variable side of the calculation is already being
 * carried by the recipe cost, and counting purchases as well would push the
 * target up by the price of the ingredients twice over.
 */
function buildBreakEven(
  branch: Branch,
  yearMonth: string,
  sales: SalesTotals,
  byCategory: readonly { category: string; amountSatang: number }[],
): BreakEven {
  const fixedByCategory = byCategory
    .filter((row) => isFixedExpense(row.category))
    .map((row) => ({ category: row.category, amountSatang: row.amountSatang }));

  // Rent recorded as an expense wins. The branch setting is a FALLBACK for the
  // month nobody has typed it in yet — a break-even that quietly left out the
  // largest fixed cost in the shop is worse than no break-even at all, so when
  // it is used the response says so and the screen prints it.
  const hasRecordedRent = fixedByCategory.some((row) => row.category === ExpenseCategory.RENT);
  const rentFromSettings = !hasRecordedRent && branch.rentPerMonthSatang > 0;
  if (rentFromSettings) {
    fixedByCategory.push({
      category: ExpenseCategory.RENT,
      amountSatang: branch.rentPerMonthSatang,
    });
  }

  const fixedCostSatang = fixedByCategory.reduce((sum, row) => sum + row.amountSatang, 0);
  const marginBp = contributionMarginBp(sales.netSalesSatang, sales.recipeCostSatang);
  const breakEvenSales = breakEvenSalesSatang(fixedCostSatang, marginBp);
  const days = daysInMonthOf(yearMonth);

  return {
    fixedCostSatang,
    fixedByCategory: fixedByCategory.sort((a, b) => b.amountSatang - a.amountSatang),
    rentFromSettings,
    contributionMarginBp: marginBp,
    breakEvenSalesSatang: breakEvenSales,
    // Rounded up for the same reason the monthly target is: a daily target that
    // is met exactly every day of the month still lands short.
    breakEvenPerDaySatang: breakEvenSales === null ? null : Math.ceil(breakEvenSales / days),
    daysInMonth: days,
    surplusSatang: breakEvenSales === null ? null : sales.netSalesSatang - breakEvenSales,
  };
}

/** The next calendar day of a `YYYY-MM-DD`, for building a half-open range. */
function nextDay(businessDate: string): string {
  const date = toDateColumn(businessDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return formatDateColumn(date);
}

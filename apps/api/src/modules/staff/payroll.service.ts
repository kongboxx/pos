/**
 * The monthly payroll run (Step 9).
 *
 * A payroll has exactly two states and `paidAt` is the whole of the state
 * machine:
 *
 *   DRAFT (paidAt = null)   — a worksheet. Nothing is committed, nothing is
 *                             consumed, and every figure on it is RECOMPUTED
 *                             from live data each time it is read.
 *   PAID  (paidAt set)      — frozen. Every figure is the stored one, the
 *                             deductions it used are stamped as spent, and a
 *                             ค่าแรง expense exists for the exact total.
 *
 * WHY THE DRAFT COMPUTES NOTHING PERMANENT
 *
 * The tempting design is to total the deductions when the draft is created and
 * mark them as used. Then someone deletes the draft — and those deductions are
 * marked spent against a payroll that no longer exists. Nothing surfaces it:
 * they simply never appear again, and one employee is quietly overpaid every
 * month until somebody re-adds up a year of rows by hand.
 *
 * So consumption happens at exactly one moment, inside one transaction, at the
 * same instant the money is recorded as leaving the till.
 *
 * WHICH DEDUCTIONS A RUN PICKS UP
 *
 * Every UNSETTLED deduction dated on or before the end of the month, not only
 * the ones inside it. A lateness recorded in June after June's payroll was paid
 * would otherwise sit there forever: too old for July, and June is closed. The
 * stamp is what makes reaching backwards safe.
 */

import type { Prisma, PrismaClient, Staff, StaffDeduction } from '@prisma/client';
import {
  ExpenseCategory,
  daysInMonth,
  deductionExceedsPay,
  grossSatangFor,
  isOnPayrollForMonth,
  monthRange,
  netSatangFor,
  type PayrollLineDto,
  type PayrollPayRequest,
  type PayrollResponse,
  type PayslipDeduction,
} from '@pos/shared';
import { badRequest, conflict, notFound } from '../../http-error.js';
import { formatDateColumn, toDateColumn } from '../orders/order.mapper.js';

interface BranchScope {
  id: string;
}

/** A draft line joined to the person it pays and the deductions it would take. */
type LineWithStaff = Prisma.PayrollLineGetPayload<{ include: { staff: true } }>;

export class PayrollService {
  constructor(private readonly db: PrismaClient) {}

  /* ---------------------------------------------------------------- */
  /* reading                                                           */
  /* ---------------------------------------------------------------- */

  async snapshot(branch: BranchScope, yearMonth: string): Promise<PayrollResponse> {
    const payroll = await this.db.payroll.findUnique({
      where: { branchId_yearMonth: { branchId: branch.id, yearMonth } },
      include: { lines: { include: { staff: true } } },
    });

    const [manualWageSatang, staffWithoutWageCount] = await Promise.all([
      this.manualWagesIn(branch.id, yearMonth),
      this.db.staff.count({
        where: { branchId: branch.id, status: { not: 'LEFT' }, wageRateSatang: 0 },
      }),
    ]);

    if (!payroll) {
      return { yearMonth, payroll: null, manualWageSatang, staffWithoutWageCount };
    }

    const lines = payroll.paidAt
      ? await this.frozenLines(payroll.lines)
      : await this.draftLines(branch.id, yearMonth, payroll.lines);

    return {
      yearMonth,
      payroll: {
        id: payroll.id,
        paidAt: payroll.paidAt?.toISOString() ?? null,
        // A draft's stored total is stale by design — the figure that matters
        // is the one recomputed above, and it is what the pay button acts on.
        totalSatang: payroll.paidAt
          ? payroll.totalSatang
          : Math.max(
              0,
              lines.reduce((sum, line) => sum + line.netSatang, 0),
            ),
        expenseId: payroll.expenseId,
        lines,
      },
      manualWageSatang,
      staffWithoutWageCount,
    };
  }

  /**
   * A paid run, read back exactly as it was paid.
   *
   * Nothing here is recalculated. The staff record is joined only for the name
   * and position printed on the slip; the wage terms come from the snapshot
   * columns, so a raise handed out afterwards cannot rewrite history (rule #7).
   */
  private async frozenLines(lines: LineWithStaff[]): Promise<PayrollLineDto[]> {
    const settled = await this.db.staffDeduction.findMany({
      where: { payrollLineId: { in: lines.map((line) => line.id) } },
      orderBy: { date: 'asc' },
    });

    return lines
      .map((line) => ({
        ...this.baseLineDto(line, line.wageTypeSnapshot, line.wageRateSnapshot),
        daysWorked: line.daysWorked,
        grossSatang: line.grossSatang,
        bonusSatang: line.bonusSatang,
        deductSatang: line.deductSatang,
        netSatang: line.netSatang,
        deductions: settled.filter((row) => row.payrollLineId === line.id).map(toPayslipDeduction),
      }))
      .sort(byName);
  }

  /**
   * A draft, recomputed from live data on every read.
   *
   * Including the WAGE TERMS, which come from the staff record rather than from
   * the snapshot columns while the run is unpaid. The snapshot exists to stop a
   * later raise rewriting a slip that has been handed over; a draft has been
   * handed to nobody, and showing a rate that was superseded last week would
   * just be a wrong number waiting to be paid out.
   */
  private async draftLines(
    branchId: string,
    yearMonth: string,
    lines: LineWithStaff[],
  ): Promise<PayrollLineDto[]> {
    const pending = await this.pendingDeductions(
      branchId,
      yearMonth,
      lines.map((line) => line.staffId),
    );

    return lines
      .map((line) => {
        const mine = pending.filter((row) => row.staffId === line.staffId);
        const deductSatang = mine.reduce((sum, row) => sum + row.amountSatang, 0);
        const grossSatang = grossSatangFor(
          line.staff.wageType,
          line.staff.wageRateSatang,
          line.daysWorked,
        );

        return {
          ...this.baseLineDto(line, line.staff.wageType, line.staff.wageRateSatang),
          daysWorked: line.daysWorked,
          grossSatang,
          bonusSatang: line.bonusSatang,
          deductSatang,
          netSatang: netSatangFor(grossSatang, line.bonusSatang, deductSatang),
          deductions: mine.map(toPayslipDeduction),
        };
      })
      .sort(byName);
  }

  private baseLineDto(
    line: LineWithStaff,
    wageType: Staff['wageType'],
    wageRateSatang: number,
  ): Omit<
    PayrollLineDto,
    'daysWorked' | 'grossSatang' | 'bonusSatang' | 'deductSatang' | 'netSatang' | 'deductions'
  > {
    return {
      id: line.id,
      staffId: line.staffId,
      fullName: line.staff.fullName,
      nickname: line.staff.nickname,
      position: line.staff.position,
      wageTypeSnapshot: wageType,
      wageRateSnapshot: wageRateSatang,
      note: line.note,
    };
  }

  /** Unsettled deductions this run would consume: everything up to month end. */
  private pendingDeductions(
    branchId: string,
    yearMonth: string,
    staffIds: string[],
  ): Promise<StaffDeduction[]> {
    const { endExclusive } = monthRange(yearMonth);
    return this.db.staffDeduction.findMany({
      where: {
        branchId,
        staffId: { in: staffIds },
        payrollLineId: null,
        date: { lt: toDateColumn(endExclusive) },
      },
      orderBy: { date: 'asc' },
    });
  }

  /**
   * Wages typed in by hand as an expense in this month.
   *
   * Surfaced on the pay screen because paying a payroll writes its own ค่าแรง
   * row: if the same wages were also entered manually, the month is out by a
   * full payroll. Not blocked — it is usually a genuine advance to one person,
   * and only the owner can tell the difference.
   */
  private async manualWagesIn(branchId: string, yearMonth: string): Promise<number> {
    const { start, endExclusive } = monthRange(yearMonth);
    const total = await this.db.expense.aggregate({
      where: {
        branchId,
        category: ExpenseCategory.WAGE,
        isAutoGenerated: false,
        date: { gte: toDateColumn(start), lt: toDateColumn(endExclusive) },
      },
      _sum: { amountSatang: true },
    });
    return total._sum.amountSatang ?? 0;
  }

  /* ---------------------------------------------------------------- */
  /* building the draft                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Creates the month's draft, or re-syncs the roster of an existing one.
   *
   * Re-running it after hiring somebody adds their line and keeps every
   * daysWorked and bonus already typed — those are the only numbers on this
   * screen a human produced, and losing them to a button labelled "refresh"
   * would be the fastest way to make the screen untrusted.
   */
  async generate(branch: BranchScope, yearMonth: string, actingStaffId: string): Promise<void> {
    const existing = await this.db.payroll.findUnique({
      where: { branchId_yearMonth: { branchId: branch.id, yearMonth } },
      include: { lines: true },
    });
    if (existing?.paidAt) {
      throw conflict('PAYROLL_PAID', 'เดือนนี้จ่ายเงินเดือนไปแล้ว ถ้าจะแก้ ต้องยกเลิกการจ่ายก่อน');
    }

    // By dates, not by status — see isOnPayrollForMonth. Someone marked as
    // having left on the 20th still worked twenty days of this month.
    const staff = await this.db.staff.findMany({ where: { branchId: branch.id } });
    const eligible = staff.filter((person) =>
      isOnPayrollForMonth(
        {
          status: person.status,
          startDate: formatDateColumn(person.startDate),
          endDate: person.endDate ? formatDateColumn(person.endDate) : null,
        },
        yearMonth,
      ),
    );
    if (eligible.length === 0) {
      throw badRequest('NO_STAFF', `ไม่มีพนักงานที่ต้องจ่ายเงินเดือนในเดือน ${yearMonth}`);
    }

    await this.db.$transaction(async (tx) => {
      const payroll =
        existing ?? (await tx.payroll.create({ data: { branchId: branch.id, yearMonth } }));

      const keep = new Set(eligible.map((person) => person.id));
      const have = new Map((existing?.lines ?? []).map((line) => [line.staffId, line]));

      // Someone who left after the draft was made comes off it. Their line
      // holds nothing but zeros and a name that should not be on this month's
      // slip run at all.
      const drop = [...have.keys()].filter((staffId) => !keep.has(staffId));
      if (drop.length > 0) {
        await tx.payrollLine.deleteMany({
          where: { payrollId: payroll.id, staffId: { in: drop } },
        });
      }

      for (const person of eligible) {
        const line = have.get(person.id);
        const daysWorked = line?.daysWorked ?? defaultDaysWorked(person, yearMonth);
        const bonusSatang = line?.bonusSatang ?? 0;
        const grossSatang = grossSatangFor(person.wageType, person.wageRateSatang, daysWorked);

        // The snapshot columns are placeholders while the run is a draft —
        // `pay` writes the real ones. They are filled in anyway because the
        // columns are NOT NULL and a half-populated row is worse than a stale
        // one nothing reads.
        const data = {
          wageTypeSnapshot: person.wageType,
          wageRateSnapshot: person.wageRateSatang,
          daysWorked,
          grossSatang,
          bonusSatang,
          deductSatang: 0,
          netSatang: netSatangFor(grossSatang, bonusSatang, 0),
        };

        if (line) {
          await tx.payrollLine.update({ where: { id: line.id }, data });
        } else {
          await tx.payrollLine.create({
            data: { branchId: branch.id, payrollId: payroll.id, staffId: person.id, ...data },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actingStaffId,
          action: existing ? 'REFRESH_PAYROLL' : 'CREATE_PAYROLL',
          entityType: 'Payroll',
          entityId: payroll.id,
          after: { yearMonth, staffCount: eligible.length },
        },
      });
    });
  }

  /** The days a person typed into the screen; everything else stays theirs. */
  async updateLine(
    branch: BranchScope,
    lineId: string,
    input: { daysWorked: number; bonusSatang: number; note?: string | null },
    yearMonthGuard?: string,
  ): Promise<string> {
    const line = await this.db.payrollLine.findFirst({
      where: { id: lineId, branchId: branch.id },
      include: { payroll: true },
    });
    if (!line) throw notFound('PAYROLL_LINE_NOT_FOUND', 'ไม่พบรายการเงินเดือนนี้');
    if (line.payroll.paidAt) {
      throw conflict(
        'PAYROLL_PAID',
        'สลิปรอบนี้จ่ายไปแล้ว แก้ไม่ได้ — ถ้าตัวเลขผิด ต้องยกเลิกการจ่ายก่อน',
      );
    }
    if (yearMonthGuard && line.payroll.yearMonth !== yearMonthGuard) {
      throw badRequest('PAYROLL_MONTH_MISMATCH', 'รายการนี้ไม่ได้อยู่ในเดือนที่กำลังแก้');
    }

    const maxDays = daysInMonth(line.payroll.yearMonth);
    if (input.daysWorked > maxDays) {
      throw badRequest(
        'DAYS_EXCEED_MONTH',
        `เดือน ${line.payroll.yearMonth} มี ${maxDays} วัน ใส่ ${input.daysWorked} วันไม่ได้`,
      );
    }

    await this.db.payrollLine.update({
      where: { id: lineId },
      data: {
        daysWorked: input.daysWorked,
        bonusSatang: input.bonusSatang,
        note: input.note ?? null,
      },
    });

    return line.payroll.yearMonth;
  }

  /** Throws away an unpaid draft. Nothing was consumed, so nothing is undone. */
  async discard(branch: BranchScope, yearMonth: string, actingStaffId: string): Promise<void> {
    const payroll = await this.requirePayroll(branch.id, yearMonth);
    if (payroll.paidAt) {
      throw conflict('PAYROLL_PAID', 'รอบนี้จ่ายไปแล้ว ลบทิ้งไม่ได้ — ต้องยกเลิกการจ่ายก่อน');
    }

    await this.db.$transaction([
      this.db.payroll.delete({ where: { id: payroll.id } }),
      this.db.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actingStaffId,
          action: 'DISCARD_PAYROLL',
          entityType: 'Payroll',
          entityId: payroll.id,
          before: { yearMonth },
        },
      }),
    ]);
  }

  /* ---------------------------------------------------------------- */
  /* paying                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Hands out the money: freezes the figures, consumes the deductions and
   * records one ค่าแรง expense.
   *
   * All four happen in one transaction, behind an advisory lock on the branch
   * and month. Without the lock, two taps on a slow connection are two
   * transactions that both read `paidAt = null` under Postgres' default READ
   * COMMITTED and both write an expense — the shop's wage bill doubles and the
   * only clue is a payroll whose expense id points at one of two identical rows.
   */
  async pay(
    branch: BranchScope,
    yearMonth: string,
    input: PayrollPayRequest,
    actingStaffId: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${branch.id}:${yearMonth}`}))`;

      const payroll = await tx.payroll.findUnique({
        where: { branchId_yearMonth: { branchId: branch.id, yearMonth } },
        include: { lines: { include: { staff: true } } },
      });
      if (!payroll) throw notFound('PAYROLL_NOT_FOUND', 'ยังไม่ได้สร้างรอบเงินเดือนของเดือนนี้');
      if (payroll.paidAt) throw conflict('PAYROLL_PAID', 'รอบนี้จ่ายไปแล้ว');
      if (payroll.lines.length === 0) {
        throw badRequest('PAYROLL_EMPTY', 'รอบนี้ยังไม่มีพนักงานสักคน');
      }

      const { endExclusive } = monthRange(yearMonth);
      const pending = await tx.staffDeduction.findMany({
        where: {
          branchId: branch.id,
          staffId: { in: payroll.lines.map((line) => line.staffId) },
          payrollLineId: null,
          date: { lt: toDateColumn(endExclusive) },
        },
      });

      let totalSatang = 0;

      for (const line of payroll.lines) {
        const mine = pending.filter((row) => row.staffId === line.staffId);
        const deductSatang = mine.reduce((sum, row) => sum + row.amountSatang, 0);
        const grossSatang = grossSatangFor(
          line.staff.wageType,
          line.staff.wageRateSatang,
          line.daysWorked,
        );

        if (deductionExceedsPay(grossSatang, line.bonusSatang, deductSatang)) {
          // No carry-forward table exists in this Step, so the alternatives
          // would be a negative payslip or a balance quietly written off. The
          // owner shrinks the deduction and records the rest next month.
          throw conflict(
            'DEDUCTION_EXCEEDS_PAY',
            `${line.staff.nickname ?? line.staff.fullName} ถูกหักมากกว่าค่าแรงที่ได้ จ่ายไม่ได้ — ลดยอดหักลงก่อน แล้วค่อยหักส่วนที่เหลือเดือนหน้า`,
          );
        }

        const netSatang = netSatangFor(grossSatang, line.bonusSatang, deductSatang);
        totalSatang += netSatang;

        await tx.payrollLine.update({
          where: { id: line.id },
          data: {
            // Frozen HERE, from the live staff record, so the slip records the
            // terms in force on payday and no later edit can move them.
            wageTypeSnapshot: line.staff.wageType,
            wageRateSnapshot: line.staff.wageRateSatang,
            grossSatang,
            deductSatang,
            netSatang,
          },
        });

        if (mine.length > 0) {
          // The stamp. From this moment these rows can never be picked up by
          // another run, and deleting them is refused.
          await tx.staffDeduction.updateMany({
            where: { id: { in: mine.map((row) => row.id) } },
            data: { payrollLineId: line.id },
          });
        }
      }

      if (totalSatang <= 0) {
        throw badRequest('PAYROLL_ZERO', 'ยอดจ่ายรวมเป็น 0 — ตรวจค่าแรงและจำนวนวันทำงานก่อน');
      }

      // ONE expense row for the whole run, flagged so Step 8's screens refuse
      // to let anyone hand-edit it. Dated the day the money left the till, not
      // the month it was earned: the P&L is cash basis.
      const expense = await tx.expense.create({
        data: {
          branchId: branch.id,
          date: toDateColumn(input.paidDate),
          category: ExpenseCategory.WAGE,
          amountSatang: totalSatang,
          paidBy: input.paidBy,
          note: `เงินเดือนเดือน ${yearMonth}`,
          isAutoGenerated: true,
        },
      });

      await tx.payroll.update({
        where: { id: payroll.id },
        data: { paidAt: new Date(), totalSatang, expenseId: expense.id },
      });

      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actingStaffId,
          action: 'PAY_PAYROLL',
          entityType: 'Payroll',
          entityId: payroll.id,
          after: {
            yearMonth,
            paidDate: input.paidDate,
            totalSatang,
            staffCount: payroll.lines.length,
            expenseId: expense.id,
          },
        },
      });
    });
  }

  /**
   * Puts a paid run back to a draft.
   *
   * This exists because the alternative is worse. A payroll paid with one wrong
   * number and no way back is a payroll somebody fixes by opening the database,
   * and everything below this line — the stamps, the single expense row, the
   * audit trail — only holds if the supported path is the one people use.
   *
   * It reverses all three effects together: the expense row goes, the stamps
   * come off, the figures unfreeze. What it cannot reverse is a slip already
   * handed over, which is why it is audited by name.
   */
  async unpay(branch: BranchScope, yearMonth: string, actingStaffId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${branch.id}:${yearMonth}`}))`;

      const payroll = await tx.payroll.findUnique({
        where: { branchId_yearMonth: { branchId: branch.id, yearMonth } },
        include: { lines: { select: { id: true } } },
      });
      if (!payroll) throw notFound('PAYROLL_NOT_FOUND', 'ไม่พบรอบเงินเดือนของเดือนนี้');
      if (!payroll.paidAt) throw conflict('PAYROLL_NOT_PAID', 'รอบนี้ยังไม่ได้จ่าย');

      const before = { totalSatang: payroll.totalSatang, expenseId: payroll.expenseId };

      // Order matters: the payroll must let go of the expense before the
      // expense can be deleted, or the foreign key refuses.
      await tx.payroll.update({
        where: { id: payroll.id },
        data: { paidAt: null, totalSatang: 0, expenseId: null },
      });
      if (payroll.expenseId) {
        await tx.expense.delete({ where: { id: payroll.expenseId } });
      }
      await tx.staffDeduction.updateMany({
        where: { payrollLineId: { in: payroll.lines.map((line) => line.id) } },
        data: { payrollLineId: null },
      });

      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actingStaffId,
          action: 'UNPAY_PAYROLL',
          entityType: 'Payroll',
          entityId: payroll.id,
          before,
          reason: `ยกเลิกการจ่ายเงินเดือนเดือน ${yearMonth}`,
        },
      });
    });
  }

  private async requirePayroll(branchId: string, yearMonth: string) {
    const payroll = await this.db.payroll.findUnique({
      where: { branchId_yearMonth: { branchId, yearMonth } },
    });
    if (!payroll) throw notFound('PAYROLL_NOT_FOUND', 'ไม่พบรอบเงินเดือนของเดือนนี้');
    return payroll;
  }
}

/* ------------------------------------------------------------------ */

/**
 * What a new line starts at.
 *
 * Zero for a daily worker: their pay IS the day count, so a pre-filled 30 is a
 * number somebody has to notice is wrong before it is paid out. A monthly wage
 * does not move with the days, so the full month is the honest default there.
 */
function defaultDaysWorked(person: Staff, yearMonth: string): number {
  return person.wageType === 'MONTHLY' ? daysInMonth(yearMonth) : 0;
}

function toPayslipDeduction(row: StaffDeduction): PayslipDeduction {
  return {
    date: formatDateColumn(row.date),
    type: row.type,
    amountSatang: row.amountSatang,
    note: row.note,
  };
}

/** Stable order so the slips print in the same sequence every month. */
function byName(a: PayrollLineDto, b: PayrollLineDto): number {
  return a.fullName.localeCompare(b.fullName, 'th');
}

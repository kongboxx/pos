/**
 * `/api/expenses` — recording money going out (Step 8).
 *
 * Every write is audited. That is not ceremony: this is the one table in the
 * system a person types money straight into, with no bill, no customer and no
 * kitchen ticket to check it against. An expense that appears, changes value
 * and disappears again leaves no other trace, which is exactly the shape rule
 * #8 exists for.
 *
 * Two smaller decisions worth knowing:
 *
 *  - `date` is a BUSINESS date (rule #4). Paying the noodle supplier at 01:00
 *    belongs to the night the shop was open, not to the calendar day the clock
 *    had rolled over into, and the P&L would otherwise disagree with the sales
 *    it sits next to.
 *  - Every response carries the WHOLE month back, not the row that changed.
 *    Adding one expense moves the month total, the category subtotal and the
 *    break-even target on screen; answering with just the new row would leave
 *    all three showing the figures from before it was typed.
 */

import type { FastifyInstance } from 'fastify';
import {
  expenseListQuerySchema,
  expenseRequestSchema,
  monthRange,
  Permission,
  yearMonthOf,
  type ExpenseDto,
  type ExpenseListResponse,
  type ExpenseRequest,
} from '@pos/shared';
import { z } from 'zod';
import type { Expense } from '@prisma/client';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { conflict, notFound } from '../../http-error.js';
import { requirePermission } from '../auth/guards.js';
import { formatDateColumn, toDateColumn } from '../orders/order.mapper.js';

const expenseIdParams = z.object({ id: z.string().uuid() });

export function registerExpenseRoutes(app: FastifyInstance): void {
  const readExpenses = requirePermission(Permission.VIEW_REPORTS, 'ดูรายงาน');
  const writeExpenses = requirePermission(Permission.MANAGE_EXPENSE, 'บันทึกรายจ่าย');

  const monthSnapshot = async (
    branchId: string,
    yearMonth: string,
  ): Promise<ExpenseListResponse> => {
    const { start, endExclusive } = monthRange(yearMonth);
    const range = { gte: toDateColumn(start), lt: toDateColumn(endExclusive) };

    const [rows, grouped] = await Promise.all([
      prisma.expense.findMany({
        where: { branchId, date: range },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.expense.groupBy({
        by: ['category'],
        where: { branchId, date: range },
        _sum: { amountSatang: true },
      }),
    ]);

    const byCategory = grouped
      .map((row) => ({ category: row.category, amountSatang: row._sum.amountSatang ?? 0 }))
      .sort((a, b) => b.amountSatang - a.amountSatang);

    return {
      yearMonth,
      expenses: rows.map(toExpenseDto),
      totalSatang: byCategory.reduce((sum, row) => sum + row.amountSatang, 0),
      byCategory,
    };
  };

  app.get('/expenses', { preHandler: readExpenses }, async (request, reply) => {
    const { month } = expenseListQuerySchema.parse(request.query);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await monthSnapshot(branch.id, month));
  });

  app.post('/expenses', { preHandler: writeExpenses }, async (request, reply) => {
    const body = expenseRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const created = await prisma.expense.create({
      data: {
        branchId: branch.id,
        date: toDateColumn(body.date),
        category: body.category,
        amountSatang: body.amountSatang,
        note: body.note ?? null,
        paidBy: body.paidBy,
      },
    });

    await prisma.auditLog.create({
      data: {
        branchId: branch.id,
        staffId: request.user.staffId,
        action: 'CREATE_EXPENSE',
        entityType: 'Expense',
        entityId: created.id,
        after: auditShape(body),
      },
    });

    return reply.status(201).send(await monthSnapshot(branch.id, yearMonthOf(body.date)));
  });

  app.put('/expenses/:id', { preHandler: writeExpenses }, async (request, reply) => {
    const { id } = expenseIdParams.parse(request.params);
    const body = expenseRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireEditable(branch.id, id);

    await prisma.expense.update({
      where: { id },
      data: {
        date: toDateColumn(body.date),
        category: body.category,
        amountSatang: body.amountSatang,
        note: body.note ?? null,
        paidBy: body.paidBy,
      },
    });

    await prisma.auditLog.create({
      data: {
        branchId: branch.id,
        staffId: request.user.staffId,
        action: 'UPDATE_EXPENSE',
        entityType: 'Expense',
        entityId: id,
        before: auditShape({
          date: formatDateColumn(existing.date),
          category: existing.category,
          amountSatang: existing.amountSatang,
          note: existing.note,
          paidBy: existing.paidBy,
        }),
        after: auditShape(body),
      },
    });

    // The month of the row as it is NOW. Moving an expense from June to July
    // has to answer with July, or the screen the user is looking at reloads
    // the month the row just left.
    return reply.send(await monthSnapshot(branch.id, yearMonthOf(body.date)));
  });

  app.delete('/expenses/:id', { preHandler: writeExpenses }, async (request, reply) => {
    const { id } = expenseIdParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireEditable(branch.id, id);

    await prisma.expense.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        branchId: branch.id,
        staffId: request.user.staffId,
        action: 'DELETE_EXPENSE',
        entityType: 'Expense',
        entityId: id,
        before: auditShape({
          date: formatDateColumn(existing.date),
          category: existing.category,
          amountSatang: existing.amountSatang,
          note: existing.note,
          paidBy: existing.paidBy,
        }),
      },
    });

    return reply.send(await monthSnapshot(branch.id, yearMonthOf(formatDateColumn(existing.date))));
  });
}

/* ------------------------------------------------------------------ */

/**
 * Finds the row and refuses if a payroll run wrote it.
 *
 * Wages reach the P&L as an Expense created by paying a payroll (Step 9). Let
 * that row be edited by hand and the payslip and the accounts disagree with
 * nothing to say which one is right — so the answer points at the payroll
 * rather than just saying no.
 */
async function requireEditable(branchId: string, id: string): Promise<Expense> {
  const existing = await prisma.expense.findFirst({ where: { id, branchId } });
  if (!existing) throw notFound('EXPENSE_NOT_FOUND', 'ไม่พบรายจ่ายนี้');
  if (existing.isAutoGenerated) {
    throw conflict(
      'EXPENSE_AUTO_GENERATED',
      'รายการนี้ระบบสร้างจากการจ่ายเงินเดือน แก้ที่หน้าเงินเดือนแทน',
    );
  }
  return existing;
}

function toExpenseDto(row: Expense): ExpenseDto {
  return {
    id: row.id,
    date: formatDateColumn(row.date),
    category: row.category,
    amountSatang: row.amountSatang,
    note: row.note,
    paidBy: row.paidBy,
    isAutoGenerated: row.isAutoGenerated,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What an audit reader needs to see, without dragging Prisma types into Json. */
function auditShape(
  input: ExpenseRequest | Omit<ExpenseDto, 'id' | 'isAutoGenerated' | 'createdAt'>,
): {
  date: string;
  category: string;
  amountSatang: number;
  note: string | null;
  paidBy: string;
} {
  return {
    date: input.date,
    category: input.category,
    amountSatang: input.amountSatang,
    note: input.note ?? null,
    paidBy: input.paidBy,
  };
}

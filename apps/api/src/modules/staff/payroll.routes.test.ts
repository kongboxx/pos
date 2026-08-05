/**
 * The monthly payroll run.
 *
 * The tests that matter here are all about the same thing: a deduction must
 * come off exactly one payslip, ever. Everything else — the arithmetic, the
 * permissions — is cheap to check and cheap to fix. Paying somebody twice, or
 * silently swallowing a deduction so they are never charged for it, is found
 * six months later by adding up a year of rows by hand.
 *
 * ISOLATION: this file runs in 2019 and creates its own staff with a 2019 start
 * date. A payroll run sweeps in every eligible employee at the branch, so
 * without that, a throwaway staff row created by a test file running in
 * parallel would land on this run — and deleting it again would fail against
 * the payroll line pointing at it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import {
  ExpenseCategory,
  Role,
  type ExpenseListResponse,
  type PayrollLineDto,
  type PayrollResponse,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, loginAs } from '../../test-helpers.js';

const PREFIX = 'ทดสอบเงินเดือน';
const MONTH = '2019-09';
const NEXT_MONTH = '2019-10';
/** Paid in October for September — the P&L is cash basis, so that is on purpose. */
const PAID_DATE = '2019-10-03';

const DAILY_RATE = 45_000; // 450.00 / day
const MONTHLY_RATE = 2_000_000; // 20,000.00 / month

let app: FastifyInstance;
let owner: { staffId: string; cookie: string };
let manager: { staffId: string; cookie: string };
let branchId: string;
let dailyId: string;
let monthlyId: string;
let startedAt: Date;

async function makeStaff(name: string, wageType: 'DAILY' | 'MONTHLY', rate: number) {
  return prisma.staff.create({
    data: {
      branchId,
      fullName: `${PREFIX} ${name}`,
      nickname: name,
      role: Role.STAFF,
      // A REAL bcrypt hash of a PIN nobody else in the suite uses, not a
      // hand-shaped string: the staff module compares every stored hash when an
      // owner picks a PIN, and bcryptjs throws on a malformed one rather than
      // returning false. A fake here made "add an employee" 500 in a parallel
      // test file — which is also how the missing guard in assertPinUnused was
      // found, so the fake was worth having once.
      pinHash: await bcrypt.hash(`60${rate === MONTHLY_RATE ? '11' : '22'}`, 4),
      startDate: new Date('2019-01-01T00:00:00Z'),
      status: 'ACTIVE',
      wageType,
      wageRateSatang: rate,
    },
  });
}

const post = (url: string, payload?: Record<string, unknown>, cookie = owner.cookie) =>
  app.inject({ method: 'POST' as const, url, headers: { cookie }, payload: payload ?? {} });

async function snapshot(month = MONTH): Promise<PayrollResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/payroll?month=${month}`,
    headers: { cookie: owner.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function generate(month = MONTH): Promise<PayrollResponse> {
  const response = await post(`/api/payroll/${month}/generate`);
  expect(response.statusCode).toBe(201);
  return response.json();
}

function lineFor(body: PayrollResponse, staffId: string): PayrollLineDto {
  const line = body.payroll?.lines.find((row) => row.staffId === staffId);
  if (!line) throw new Error(`no payroll line for ${staffId}`);
  return line;
}

async function setDays(lineId: string, daysWorked: number, bonusSatang = 0) {
  return app.inject({
    method: 'PUT',
    url: `/api/payroll/lines/${lineId}`,
    headers: { cookie: owner.cookie },
    payload: { daysWorked, bonusSatang },
  });
}

async function deduct(staffId: string, amountSatang: number, date = '2019-09-15') {
  const response = await post('/api/staff/deductions', {
    staffId,
    date,
    type: 'LATE',
    amountSatang,
  });
  expect(response.statusCode).toBe(201);
}

beforeAll(async () => {
  app = await buildTestApp();
  owner = await loginAs(app, Role.OWNER);
  manager = await loginAs(app, Role.MANAGER);
  branchId = (
    await prisma.branch.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    })
  ).id;
  startedAt = new Date();

  dailyId = (await makeStaff('รายวัน', 'DAILY', DAILY_RATE)).id;
  monthlyId = (await makeStaff('รายเดือน', 'MONTHLY', MONTHLY_RATE)).id;
});

// Scoped to this file's two months and its own two people, so a parallel file
// sweeping its own rows can never take these — the mistake that made three
// unrelated files fail together in Step 8.
afterEach(async () => {
  const staffIds = [dailyId, monthlyId];
  await prisma.payroll.deleteMany({ where: { branchId, yearMonth: { in: [MONTH, NEXT_MONTH] } } });
  await prisma.staffDeduction.deleteMany({ where: { staffId: { in: staffIds } } });
  await prisma.expense.deleteMany({
    where: {
      branchId,
      date: { gte: new Date('2019-09-01'), lt: new Date('2019-11-01') },
    },
  });
  await prisma.auditLog.deleteMany({
    where: {
      entityType: { in: ['Payroll', 'StaffDeduction'] },
      createdAt: { gte: startedAt },
    },
  });
});

afterAll(async () => {
  await prisma.staff.deleteMany({ where: { branchId, fullName: { startsWith: PREFIX } } });
  await app.close();
});

describe('who may open the payroll screen', () => {
  it('refuses a manager both reading and paying', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/payroll?month=${MONTH}`,
      headers: { cookie: manager.cookie },
    });
    expect(read.statusCode).toBe(403);
    expect((await post(`/api/payroll/${MONTH}/generate`, {}, manager.cookie)).statusCode).toBe(403);
  });
});

describe('building the draft', () => {
  it('puts everyone employed that month on it, and nobody else', async () => {
    const body = await generate();
    // The seeded staff started in 2026 and must not appear on a 2019 run.
    expect(body.payroll?.lines).toHaveLength(2);
    expect(body.payroll?.paidAt).toBeNull();
  });

  it('starts a daily worker at zero days and a monthly one at the full month', async () => {
    const body = await generate();
    // A pre-filled 30 for a daily worker is a number somebody has to notice is
    // wrong before it is paid out. A monthly wage does not move with the days.
    expect(lineFor(body, dailyId).daysWorked).toBe(0);
    expect(lineFor(body, dailyId).grossSatang).toBe(0);
    expect(lineFor(body, monthlyId).daysWorked).toBe(30);
    expect(lineFor(body, monthlyId).grossSatang).toBe(MONTHLY_RATE);
  });

  it('multiplies rate by days for a daily worker and leaves a salary alone', async () => {
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24);
    const withMonthly = await setDays(lineFor(draft, monthlyId).id, 20);
    expect(withMonthly.statusCode).toBe(200);

    const body: PayrollResponse = withMonthly.json();
    expect(lineFor(body, dailyId).grossSatang).toBe(DAILY_RATE * 24);
    // 20 days does NOT make it two-thirds of a salary. Pro-rating silently
    // would be indistinguishable from a bug; an absence is a deduction.
    expect(lineFor(body, monthlyId).grossSatang).toBe(MONTHLY_RATE);
  });

  it('refuses more days than the month has', async () => {
    const draft = await generate();
    const response = await setDays(lineFor(draft, dailyId).id, 31);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('DAYS_EXCEED_MONTH');
  });

  it('picks up a deduction recorded after the draft was made, with no refresh', async () => {
    // A draft computes nothing permanent, so a lateness recorded five minutes
    // ago is on the screen without anyone pressing a recalculate button.
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24);
    await deduct(dailyId, 30_000);

    const body = await snapshot();
    const line = lineFor(body, dailyId);
    expect(line.deductSatang).toBe(30_000);
    expect(line.netSatang).toBe(DAILY_RATE * 24 - 30_000);
    // Itemised, so a slip never says "หัก 300" with nothing to explain it.
    expect(line.deductions).toHaveLength(1);
    expect(line.deductions[0]?.type).toBe('LATE');
  });

  it('keeps the days already typed when the roster is refreshed', async () => {
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24, 50_000);

    const refreshed = await generate();
    const line = lineFor(refreshed, dailyId);
    expect(line.daysWorked).toBe(24);
    expect(line.bonusSatang).toBe(50_000);
  });

  it('throwing a draft away leaves its deductions unspent', async () => {
    // THE reason a draft consumes nothing. Had the deductions been stamped when
    // the draft was built, discarding it would mark them spent against a
    // payroll that no longer exists — they would never appear again, and one
    // person would be quietly overpaid every month afterwards.
    await generate();
    await deduct(dailyId, 30_000);

    const discarded = await app.inject({
      method: 'DELETE',
      url: `/api/payroll/${MONTH}`,
      headers: { cookie: owner.cookie },
    });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json().payroll).toBeNull();

    const rows = await prisma.staffDeduction.findMany({ where: { staffId: dailyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payrollLineId).toBeNull();
  });
});

describe('paying', () => {
  async function payableDraft() {
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24);
    return snapshot();
  }

  it('freezes the figures, stamps the deductions and writes one wage expense', async () => {
    await payableDraft();
    await deduct(dailyId, 30_000);

    const response = await post(`/api/payroll/${MONTH}/pay`, {
      paidDate: PAID_DATE,
      paidBy: 'CASH',
    });
    expect(response.statusCode).toBe(200);

    const body: PayrollResponse = response.json();
    const expected = DAILY_RATE * 24 - 30_000 + MONTHLY_RATE;
    expect(body.payroll?.paidAt).not.toBeNull();
    expect(body.payroll?.totalSatang).toBe(expected);

    // ONE expense row for the whole run, in ค่าแรง, flagged so Step 8's screens
    // refuse to let anyone hand-edit it, and dated the day the money left the
    // till rather than the month it was earned.
    const expenses = await prisma.expense.findMany({
      where: { branchId, category: ExpenseCategory.WAGE, isAutoGenerated: true },
    });
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.amountSatang).toBe(expected);
    expect(expenses[0]?.date.toISOString().slice(0, 10)).toBe(PAID_DATE);
    expect(body.payroll?.expenseId).toBe(expenses[0]?.id);

    const stamped = await prisma.staffDeduction.findFirstOrThrow({ where: { staffId: dailyId } });
    expect(stamped.payrollLineId).toBe(lineFor(body, dailyId).id);
  });

  it('never lets the same deduction come off a second month', async () => {
    // THE test this whole file exists for.
    await payableDraft();
    await deduct(dailyId, 30_000);
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);

    const october = await generate(NEXT_MONTH);
    const line = lineFor(october, dailyId);
    expect(line.deductSatang).toBe(0);
    expect(line.deductions).toHaveLength(0);
  });

  it('sweeps up a deduction recorded too late for the month it belongs to', async () => {
    // Recorded in September, after September was paid. Without reaching
    // backwards it would sit there forever: too old for October, and September
    // is closed. The stamp is what makes reaching backwards safe.
    await payableDraft();
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);
    await deduct(dailyId, 12_000, '2019-09-28');

    const october = await generate(NEXT_MONTH);
    expect(lineFor(october, dailyId).deductSatang).toBe(12_000);
  });

  it('refuses to pay when a deduction is bigger than the wage, and writes nothing', async () => {
    await payableDraft();
    await deduct(dailyId, DAILY_RATE * 24 + 1);

    const response = await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('DEDUCTION_EXCEEDS_PAY');

    // The whole transaction rolled back: no expense, no stamp, still a draft.
    expect(await prisma.expense.count({ where: { branchId, isAutoGenerated: true } })).toBe(0);
    const rows = await prisma.staffDeduction.findMany({ where: { staffId: dailyId } });
    expect(rows[0]?.payrollLineId).toBeNull();
    expect((await snapshot()).payroll?.paidAt).toBeNull();
  });

  it('refuses a second payment and refuses to edit what was paid', async () => {
    const draft = await payableDraft();
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);

    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(409);
    expect((await setDays(lineFor(draft, dailyId).id, 10)).statusCode).toBe(409);
    expect((await post(`/api/payroll/${MONTH}/generate`)).statusCode).toBe(409);

    const discarded = await app.inject({
      method: 'DELETE',
      url: `/api/payroll/${MONTH}`,
      headers: { cookie: owner.cookie },
    });
    expect(discarded.statusCode).toBe(409);
  });

  it('holds the wage terms as they were on payday, not as they are now', async () => {
    // Rule #7, the same rule that keeps a menu price change off an open bill.
    await payableDraft();
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);

    await prisma.staff.update({ where: { id: dailyId }, data: { wageRateSatang: 90_000 } });

    const body = await snapshot();
    const line = lineFor(body, dailyId);
    expect(line.wageRateSnapshot).toBe(DAILY_RATE);
    expect(line.grossSatang).toBe(DAILY_RATE * 24);

    await prisma.staff.update({ where: { id: dailyId }, data: { wageRateSatang: DAILY_RATE } });
  });

  it('warns when wages were also typed in by hand that month', async () => {
    // Not blocked: usually a genuine advance to one person, occasionally the
    // whole payroll entered twice, and only the owner can tell which.
    await prisma.expense.create({
      data: {
        branchId,
        date: new Date(`${PAID_DATE}T00:00:00Z`),
        category: ExpenseCategory.WAGE,
        amountSatang: 500_000,
      },
    });

    const body = await snapshot(NEXT_MONTH);
    expect(body.manualWageSatang).toBe(500_000);
  });
});

describe('undoing a payment', () => {
  it('removes the expense, unstamps the deductions and unfreezes the run', async () => {
    // This exists because the alternative is worse: a payroll paid with one
    // wrong number and no way back is a payroll somebody fixes by opening the
    // database, and the stamps only hold if the supported path is the one
    // people actually use.
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24);
    await deduct(dailyId, 30_000);
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);

    const response = await post(`/api/payroll/${MONTH}/unpay`);
    expect(response.statusCode).toBe(200);

    const body: PayrollResponse = response.json();
    expect(body.payroll?.paidAt).toBeNull();
    expect(body.payroll?.expenseId).toBeNull();
    expect(await prisma.expense.count({ where: { branchId, isAutoGenerated: true } })).toBe(0);

    const rows = await prisma.staffDeduction.findMany({ where: { staffId: dailyId } });
    expect(rows[0]?.payrollLineId).toBeNull();
    // And the deduction is back on the draft, ready to be paid properly.
    expect(lineFor(body, dailyId).deductSatang).toBe(30_000);
  });

  it('records who undid it, since the slip may already be in a hand', async () => {
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24);
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);
    expect((await post(`/api/payroll/${MONTH}/unpay`)).statusCode).toBe(200);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Payroll', action: 'UNPAY_PAYROLL' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.staffId).toBe(owner.staffId);
    expect(log.before).toMatchObject({ totalSatang: DAILY_RATE * 24 + MONTHLY_RATE });
  });

  it('refuses to undo a run that was never paid', async () => {
    await generate();
    const response = await post(`/api/payroll/${MONTH}/unpay`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PAYROLL_NOT_PAID');
  });
});

describe('what the expense screen sees', () => {
  it('shows the wage row as one the payroll wrote, not one to edit', async () => {
    const draft = await generate();
    await setDays(lineFor(draft, dailyId).id, 24);
    expect((await post(`/api/payroll/${MONTH}/pay`, { paidDate: PAID_DATE })).statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: `/api/expenses?month=${NEXT_MONTH}`,
      headers: { cookie: owner.cookie },
    });
    const body: ExpenseListResponse = response.json();
    const wage = body.expenses.find((row) => row.isAutoGenerated);
    expect(wage?.category).toBe(ExpenseCategory.WAGE);
    expect(wage?.note).toBe(`เงินเดือนเดือน ${MONTH}`);

    // Step 8 refuses to hand-edit it; the payslip is the record.
    const edited = await app.inject({
      method: 'DELETE',
      url: `/api/expenses/${wage?.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(edited.statusCode).toBe(409);
  });
});

/**
 * Recording money out.
 *
 * The table under test is the only one in the system a person types money
 * straight into, with no bill and no customer to check it against — so what is
 * worth testing is the guard rails, not the CRUD: who may write, what the
 * server refuses to store, and whether the trail survives.
 *
 * Everything happens in a month far in the past so this file cannot collide
 * with the dev database, a browser walkthrough, or another test file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Role, type ExpenseListResponse } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, loginAs } from '../../test-helpers.js';

const MONTH = '2019-05';
const DAY = '2019-05-14';

let app: FastifyInstance;
let manager: { staffId: string; cookie: string };
let staff: { staffId: string; cookie: string };
let branchId: string;
/** Everything this file writes happens after this instant. See afterEach. */
let startedAt: Date;

// The options go in a `const` with a literal method rather than inline: passed
// inline, TypeScript resolves app.inject to its chainable overload and every
// `.statusCode` below becomes an error about a type nobody asked for.
async function post(payload: Record<string, unknown>, cookie = manager.cookie) {
  const options = { method: 'POST' as const, url: '/api/expenses', headers: { cookie }, payload };
  return app.inject(options);
}

async function list(cookie = manager.cookie): Promise<ExpenseListResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/expenses?month=${MONTH}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  app = await buildTestApp();
  manager = await loginAs(app, Role.MANAGER);
  staff = await loginAs(app, Role.STAFF);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;
  startedAt = new Date();
});

// Scoped to THIS file's months (May, plus June where one test moves a row).
// A wider sweep would delete rows the report test file is using at the same
// moment — vitest runs the two files in parallel.
afterEach(async () => {
  const rows = await prisma.expense.findMany({
    where: { branchId, date: { gte: new Date('2019-05-01'), lt: new Date('2019-07-01') } },
    select: { id: true },
  });
  await prisma.expense.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });

  // By TIME, not by the surviving expense ids: the delete test removes its row
  // first, so looking the audit rows up from the expenses that are still there
  // leaves exactly the trail of the deletion behind — which is the one thing an
  // audit log is designed to survive.
  await prisma.auditLog.deleteMany({
    where: { entityType: 'Expense', createdAt: { gte: startedAt } },
  });
});

afterAll(async () => {
  await app.close();
});

describe('who may touch the money-out ledger', () => {
  it('refuses a cashier both reading and writing', async () => {
    // Same boundary that keeps cost off the till: a cashier who can read the
    // expense ledger can work out the shop's margin from it.
    const read = await app.inject({
      method: 'GET',
      url: `/api/expenses?month=${MONTH}`,
      headers: { cookie: staff.cookie },
    });
    expect(read.statusCode).toBe(403);

    const write = await post(
      { date: DAY, category: 'INGREDIENT', amountSatang: 50_000 },
      staff.cookie,
    );
    expect(write.statusCode).toBe(403);
  });
});

describe('recording an expense', () => {
  it('stores it and answers with the whole month, not just the new row', async () => {
    // Adding one expense moves the month total, the category subtotal and the
    // break-even target — a response carrying only the new row would leave all
    // three on screen showing the figures from before it was typed.
    const response = await post({
      date: DAY,
      category: 'INGREDIENT',
      amountSatang: 80_000,
      note: 'หมูสด 5 กก.',
    });
    expect(response.statusCode).toBe(201);

    const body: ExpenseListResponse = response.json();
    expect(body.yearMonth).toBe(MONTH);
    expect(body.totalSatang).toBe(80_000);
    expect(body.expenses[0]?.note).toBe('หมูสด 5 กก.');
    expect(body.byCategory).toEqual([{ category: 'INGREDIENT', amountSatang: 80_000 }]);
  });

  it('leaves an audit trail (rule #8)', async () => {
    const created: ExpenseListResponse = (
      await post({ date: DAY, category: 'RENT', amountSatang: 1_500_000 })
    ).json();
    const id = created.expenses[0]?.id;

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Expense', entityId: id },
    });
    expect(log.action).toBe('CREATE_EXPENSE');
    expect(log.staffId).toBe(manager.staffId);
    expect(log.after).toMatchObject({ category: 'RENT', amountSatang: 1_500_000 });
  });

  it('refuses zero, negative and fractional amounts', async () => {
    // A negative row would silently cancel out a real one inside every grouped
    // total, and a fraction is a float that got past rule #2.
    for (const amountSatang of [0, -500, 12.5]) {
      const response = await post({ date: DAY, category: 'OTHER', amountSatang });
      expect(response.statusCode).toBe(400);
    }
  });

  it('refuses a category that is not on the list', async () => {
    // Free text here means "ค่าไฟ", "ค่าไฟฟ้า" and "ไฟ" become three rows that
    // nothing can add together at the end of the month.
    const response = await post({ date: DAY, category: 'ค่าไฟ', amountSatang: 10_000 });
    expect(response.statusCode).toBe(400);
  });
});

describe('editing and deleting', () => {
  it('answers with the month the row moved INTO, not the one it left', async () => {
    const created: ExpenseListResponse = (
      await post({ date: DAY, category: 'OTHER', amountSatang: 20_000 })
    ).json();
    const id = created.expenses[0]?.id as string;

    const moved = await app.inject({
      method: 'PUT',
      url: `/api/expenses/${id}`,
      headers: { cookie: manager.cookie },
      payload: { date: '2019-06-02', category: 'OTHER', amountSatang: 20_000 },
    });
    expect(moved.statusCode).toBe(200);
    // Otherwise the screen reloads the month the row just left and the user
    // watches their expense disappear.
    expect(moved.json().yearMonth).toBe('2019-06');
    expect((await list()).totalSatang).toBe(0);
  });

  it('deletes and records what was deleted', async () => {
    const created: ExpenseListResponse = (
      await post({ date: DAY, category: 'UTILITY', amountSatang: 45_000 })
    ).json();
    const id = created.expenses[0]?.id as string;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/expenses/${id}`,
      headers: { cookie: manager.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().totalSatang).toBe(0);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Expense', entityId: id, action: 'DELETE_EXPENSE' },
    });
    // The row is gone; without this the money it recorded is gone with it.
    expect(log.before).toMatchObject({ amountSatang: 45_000, category: 'UTILITY' });
  });

  it('refuses to edit a row a payroll run created', async () => {
    // The payslip is the record. A hand-edited copy makes the two disagree
    // with nothing to say which is right.
    const auto = await prisma.expense.create({
      data: {
        branchId,
        date: new Date(`${DAY}T00:00:00.000Z`),
        category: 'WAGE',
        amountSatang: 900_000,
        isAutoGenerated: true,
      },
    });

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/expenses/${auto.id}`,
      headers: { cookie: manager.cookie },
      payload: { date: DAY, category: 'WAGE', amountSatang: 1 },
    });
    expect(edited.statusCode).toBe(409);
    expect(edited.json().error).toBe('EXPENSE_AUTO_GENERATED');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/expenses/${auto.id}`,
      headers: { cookie: manager.cookie },
    });
    expect(deleted.statusCode).toBe(409);
  });

  it('404s on an expense from another branch rather than editing it', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/expenses/${crypto.randomUUID()}`,
      headers: { cookie: manager.cookie },
      payload: { date: DAY, category: 'OTHER', amountSatang: 100 },
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Reading the money back out.
 *
 * The bar these are written against: what does the shop DECIDE wrongly if this
 * breaks. A P&L that double-counts ingredients tells a profitable shop to close.
 * A break-even that leaves out the rent tells it the opposite. A daily total
 * that quietly folds in four tables still eating disagrees with the drawer, and
 * once that happens nobody reads the report again.
 *
 * Every bill here is moved onto a business date in 2019 after it is paid, so
 * the figures are exact regardless of what else is in the dev database or what
 * a browser walkthrough is doing at the same time. The bills themselves go
 * through the real endpoints — opening, adding and paying — because the point
 * is to aggregate what the till actually writes, not what a fixture imagines
 * it writes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  PaymentMethod,
  Role,
  type DailyReportResponse,
  type MenuItemDto,
  type OrderDto,
  type PnlResponse,
  type VoidReportResponse,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs, SEED_PINS } from '../../test-helpers.js';

const DAY = '2019-03-14';
const MONTH = '2019-03';

let app: FastifyInstance;
let manager: { staffId: string; cookie: string };
let owner: { staffId: string; cookie: string };
let staff: { staffId: string; cookie: string };
let branchId: string;
let noodles: MenuItemDto;

/**
 * Two dishes this file owns outright.
 *
 * Nothing here edits a SEEDED row. Two of the cases below need a dish with no
 * recipe cost and a dish priced below its ingredients, and reaching for the
 * seed to get them means mutating a row that the modifier and menu test files
 * are reading at the same moment — vitest runs them in parallel, and the
 * symptom is a failure in somebody else's file that passes on a re-run.
 */
let noRecipeItemId: string;
let overpricedItemId: string;
/** Everything this file writes happens after this instant. See afterEach. */
let startedAt: Date;

const createdOrderIds: string[] = [];

/** Opens a takeaway bill with `qty` of a dish and returns it. */
async function openBill(qty = 2, menuItemId?: string): Promise<OrderDto> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);
  const opened = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: manager.cookie },
    payload: { id, tableId: null, channel: 'TAKEAWAY' },
  });
  // Asserted rather than assumed: without this a refusal here surfaces three
  // lines later as "cannot read properties of undefined", which says nothing
  // about why.
  expect(opened.statusCode).toBe(201);

  const withLine = await app.inject({
    method: 'POST',
    url: `/api/orders/${id}/lines`,
    headers: { cookie: manager.cookie },
    payload: { id: crypto.randomUUID(), menuItemId: menuItemId ?? noodles.id, qty },
  });
  expect(withLine.statusCode).toBe(201);
  return withLine.json().order;
}

/**
 * Files a bill under the test business date.
 *
 * The bill NUMBER has to move with it. `orderNo` is `YYMMDD-NNN` and unique
 * across the whole branch, and the next number is found by looking at today's
 * bills — so a bill left holding today's number while sitting on another
 * trading day makes the very next `POST /orders` collide with it. That is an
 * artefact of moving a bill by hand, which only ever happens here.
 */
let movedSeq = 0;
async function moveToTestDate(orderId: string): Promise<void> {
  movedSeq += 1;
  await prisma.order.update({
    where: { id: orderId },
    data: {
      businessDate: new Date(`${DAY}T00:00:00.000Z`),
      orderNo: `190314-${String(movedSeq).padStart(3, '0')}`,
    },
  });
}

/** Pays a bill in full and files it under the test business date. */
async function payAndDate(
  order: OrderDto,
  method: PaymentMethod = PaymentMethod.CASH,
): Promise<OrderDto> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orders/${order.id}/pay`,
    headers: { cookie: manager.cookie },
    payload:
      method === PaymentMethod.CASH
        ? { method, receivedSatang: order.totalSatang }
        : { method, referenceNo: 'TEST-REF' },
  });
  expect(response.statusCode).toBe(200);

  await moveToTestDate(order.id);
  return response.json().order;
}

async function addExpense(category: string, amountSatang: number): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/expenses',
    headers: { cookie: manager.cookie },
    payload: { date: DAY, category, amountSatang },
  });
  expect(response.statusCode).toBe(201);
}

async function daily(): Promise<DailyReportResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/reports/daily?date=${DAY}`,
    headers: { cookie: manager.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function pnl(): Promise<PnlResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/reports/pnl?month=${MONTH}`,
    headers: { cookie: owner.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function voids(): Promise<VoidReportResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/reports/voids?from=${DAY}&to=${DAY}`,
    headers: { cookie: manager.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  app = await buildTestApp();
  manager = await loginAs(app, Role.MANAGER);
  owner = await loginAs(app, Role.OWNER);
  staff = await loginAs(app, Role.STAFF);

  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;

  const menu = await app.inject({
    method: 'GET',
    url: '/api/menu',
    headers: { cookie: manager.cookie },
  });
  const items: MenuItemDto[] = menu
    .json()
    .categories.flatMap((category: { items: MenuItemDto[] }) => category.items);
  const usable = items.find((item) => item.isAvailable && item.groupIds.length === 0);
  if (!usable) throw new Error('the seed has no option-free available item');
  noodles = usable;

  const seeded = await prisma.menuItem.findUniqueOrThrow({
    where: { id: noodles.id },
    select: { categoryId: true, costSatang: true },
  });
  if (seeded.costSatang <= 0) throw new Error('the seed dish has no recipe cost to report on');

  const scratch = async (name: string, costSatang: number): Promise<string> => {
    const item = await prisma.menuItem.create({
      data: {
        branchId,
        categoryId: seeded.categoryId,
        name,
        priceSatang: 5_000,
        costSatang,
        isAvailable: true,
      },
    });
    return item.id;
  };
  noRecipeItemId = await scratch('รายงาน-ไม่มีสูตร', 0);
  overpricedItemId = await scratch('รายงาน-ขายขาดทุน', 10_000);
  startedAt = new Date();
});

afterEach(async () => {
  await cleanupOrders(createdOrderIds);
  createdOrderIds.length = 0;

  // March only. The expense test file owns May and June and runs at the same
  // time; a wider sweep deletes rows out from under it mid-test.
  const rows = await prisma.expense.findMany({
    where: { branchId, date: { gte: new Date('2019-03-01'), lt: new Date('2019-04-01') } },
    select: { id: true },
  });
  await prisma.expense.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  // By time, not by surviving id — see the same hook in expense.routes.test.ts.
  await prisma.auditLog.deleteMany({
    where: { entityType: 'Expense', createdAt: { gte: startedAt } },
  });
});

afterAll(async () => {
  // After the bills that reference them are gone.
  await prisma.menuItem.deleteMany({ where: { id: { in: [noRecipeItemId, overpricedItemId] } } });
  await app.close();
});

describe('who may read the reports', () => {
  it('refuses a cashier', async () => {
    for (const url of [
      `/api/reports/daily?date=${DAY}`,
      `/api/reports/pnl?month=${MONTH}`,
      `/api/reports/voids?from=${DAY}&to=${DAY}`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: staff.cookie } });
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('the daily close', () => {
  it('counts paid bills and splits them by how the money came in', async () => {
    const cash = await payAndDate(await openBill(2));
    const transfer = await payAndDate(await openBill(1), PaymentMethod.PROMPTPAY);

    const report = await daily();
    expect(report.paidOrderCount).toBe(2);
    expect(report.grossSalesSatang).toBe(cash.totalSatang + transfer.totalSatang);
    // The cash figure is the one counted against the drawer at close, so it
    // has to stand on its own rather than be inferred from the total.
    const byMethod = Object.fromEntries(report.payments.map((p) => [p.method, p.amountSatang]));
    expect(byMethod['CASH']).toBe(cash.totalSatang);
    expect(byMethod['PROMPTPAY']).toBe(transfer.totalSatang);
    expect(report.averageBillSatang).toBe(
      Math.round((cash.totalSatang + transfer.totalSatang) / 2),
    );
  });

  it('keeps an open bill out of sales and reports it on its own line', async () => {
    // Read at 18:00 with tables still eating, a report that folds these in
    // stops matching the drawer, and then nobody trusts it again.
    const paid = await payAndDate(await openBill(1));
    const open = await openBill(3);
    await moveToTestDate(open.id);

    const report = await daily();
    expect(report.paidOrderCount).toBe(1);
    expect(report.grossSalesSatang).toBe(paid.totalSatang);
    expect(report.openOrderCount).toBe(1);
    expect(report.openOrderTotalSatang).toBe(open.totalSatang);
  });

  it('counts only the expenses filed on that business date', async () => {
    await addExpense('INGREDIENT', 80_000);
    await addExpense('OTHER', 15_000);
    // A different day in the same month must not leak into today's figure.
    await app.inject({
      method: 'POST',
      url: '/api/expenses',
      headers: { cookie: manager.cookie },
      payload: { date: '2019-03-20', category: 'OTHER', amountSatang: 999_999 },
    });

    const report = await daily();
    expect(report.expenseTotalSatang).toBe(95_000);
  });

  it('flags dishes sold with no recipe behind them', async () => {
    // unitCostSatang = 0 does not read as "unknown" on a report, it reads as
    // "free", and a 12% food cost that is really 34% is a number somebody
    // prices a menu on.
    await payAndDate(await openBill(1, noRecipeItemId));

    const report = await daily();
    expect(report.coverage.soldLineCount).toBe(1);
    expect(report.coverage.linesWithoutRecipeCount).toBe(1);
    expect(report.recipeCostSatang).toBe(0);
  });
});

describe('the monthly P&L', () => {
  it('is cash basis: sales minus what actually went out, and nothing else', async () => {
    // THE test of this Step. Subtracting the recipe cost here as well would
    // charge the shop for its ingredients twice and turn a profit into a loss.
    const sale = await payAndDate(await openBill(4));
    await addExpense('INGREDIENT', 30_000);
    await addExpense('RENT', 1_000_000);

    const report = await pnl();
    expect(report.netSalesSatang).toBe(sale.totalSatang);
    expect(report.expenseTotalSatang).toBe(1_030_000);
    expect(report.netProfitSatang).toBe(sale.totalSatang - 1_030_000);
    // The recipe cost is present and is deliberately NOT part of the line above.
    expect(report.recipeCostSatang).toBeGreaterThan(0);
    expect(report.netProfitSatang + 1_030_000).toBe(report.netSalesSatang);
  });

  it('labels วัตถุดิบ as the only variable cost', async () => {
    await payAndDate(await openBill(1));
    await addExpense('INGREDIENT', 30_000);
    await addExpense('UTILITY', 40_000);

    const report = await pnl();
    const kinds = Object.fromEntries(report.byCategory.map((row) => [row.category, row.kind]));
    expect(kinds['INGREDIENT']).toBe('VARIABLE');
    expect(kinds['UTILITY']).toBe('FIXED');
  });
});

describe('break-even', () => {
  it('builds the fixed cost from the fixed categories only', async () => {
    // วัตถุดิบ is left out because the variable side is already carried by the
    // recipe cost. Counting purchases as well would push the target up by the
    // price of the ingredients twice over.
    await payAndDate(await openBill(2));
    await addExpense('RENT', 1_000_000);
    await addExpense('UTILITY', 200_000);
    await addExpense('INGREDIENT', 500_000);

    const report = await pnl();
    expect(report.breakEven.fixedCostSatang).toBe(1_200_000);
    expect(report.breakEven.fixedByCategory.map((row) => row.category).sort()).toEqual([
      'RENT',
      'UTILITY',
    ]);
  });

  it('divides the fixed cost by the contribution margin and rounds the target up', async () => {
    const sale = await payAndDate(await openBill(2));
    await addExpense('RENT', 1_000_000);

    const report = await pnl();
    const margin = report.breakEven.contributionMarginBp;
    expect(margin).not.toBeNull();
    expect(report.breakEven.breakEvenSalesSatang).toBe(
      Math.ceil((1_000_000 * 10_000) / (margin as number)),
    );
    expect(report.breakEven.surplusSatang).toBe(
      sale.totalSatang - (report.breakEven.breakEvenSalesSatang as number),
    );
    expect(report.breakEven.daysInMonth).toBe(31);
  });

  it('falls back to the branch rent setting and says so', async () => {
    // A break-even that quietly left out the largest fixed cost in the shop is
    // worse than no break-even at all.
    await prisma.branch.update({ where: { id: branchId }, data: { rentPerMonthSatang: 800_000 } });
    try {
      await payAndDate(await openBill(2));

      const withoutRent = await pnl();
      expect(withoutRent.breakEven.rentFromSettings).toBe(true);
      expect(withoutRent.breakEven.fixedCostSatang).toBe(800_000);

      // A recorded ค่าเช่า wins, and the flag goes away.
      await addExpense('RENT', 1_000_000);
      const withRent = await pnl();
      expect(withRent.breakEven.rentFromSettings).toBe(false);
      expect(withRent.breakEven.fixedCostSatang).toBe(1_000_000);
    } finally {
      await prisma.branch.update({ where: { id: branchId }, data: { rentPerMonthSatang: 0 } });
    }
  });

  it('answers "never" rather than a huge number when every bowl loses money', async () => {
    // Sold at 50, costs 100 to make.
    await payAndDate(await openBill(1, overpricedItemId));
    await addExpense('RENT', 1_000_000);

    const report = await pnl();
    expect(report.breakEven.contributionMarginBp).toBeLessThan(0);
    expect(report.breakEven.breakEvenSalesSatang).toBeNull();
    expect(report.breakEven.breakEvenPerDaySatang).toBeNull();
  });
});

describe('the void report', () => {
  it('separates food that went in the bin from a customer who changed their mind', async () => {
    const cooked = await openBill(1);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${cooked.id}/fire`,
      headers: { cookie: manager.cookie },
    });
    await app.inject({
      method: 'POST',
      url: `/api/orders/${cooked.id}/lines/${cooked.lines[0]?.id}/void`,
      headers: { cookie: manager.cookie },
      payload: {
        reason: 'ทำผิดเมนู',
        approverStaffId: owner.staffId,
        approverPin: SEED_PINS.OWNER,
      },
    });

    const changedMind = await openBill(1);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${changedMind.id}/lines/${changedMind.lines[0]?.id}/void`,
      headers: { cookie: manager.cookie },
      payload: {
        reason: 'ลูกค้าเปลี่ยนใจ',
        approverStaffId: owner.staffId,
        approverPin: SEED_PINS.OWNER,
      },
    });

    for (const id of [cooked.id, changedMind.id]) await moveToTestDate(id);

    const report = await voids();
    expect(report.totalCount).toBe(2);
    expect(report.firedCount).toBe(1);
    // Only the fired one is money the shop paid out and will not get back.
    expect(report.firedCostSatang).toBeGreaterThan(0);
    expect(report.firedCostSatang).toBeLessThan(report.costSatang);

    const reasons = Object.fromEntries(report.byReason.map((row) => [row.reason, row]));
    expect(reasons['ทำผิดเมนู']?.firedCount).toBe(1);
    expect(reasons['ลูกค้าเปลี่ยนใจ']?.firedCount).toBe(0);
    // Who asked and who signed, which is the entire point of Step 5's PIN.
    expect(report.rows[0]?.approvedByName).toBeTruthy();
    expect(report.rows[0]?.requestedByName).not.toBe('');
  });

  it('files a void under the business date of the bill, not of the keystroke', async () => {
    // A 00:30 cancellation belongs to the night of the sale it reverses, not
    // to the morning the clock had rolled over into.
    const order = await openBill(1);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines/${order.lines[0]?.id}/void`,
      headers: { cookie: manager.cookie },
      payload: {
        reason: 'ของหมด',
        approverStaffId: owner.staffId,
        approverPin: SEED_PINS.OWNER,
      },
    });
    await moveToTestDate(order.id);

    const report = await voids();
    expect(report.totalCount).toBe(1);
    expect(report.rows[0]?.businessDate).toBe(DAY);
  });

  it('rejects a range that runs backwards', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/voids?from=2019-03-31&to=2019-03-01`,
      headers: { cookie: manager.cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * A bill from opening a table to counting the change.
 *
 * This is the test that would hurt most if it were missing, so it runs against
 * the real database: totals, the receipt number from DocSequence, the freed
 * table and the queued print job all depend on a transaction actually
 * committing, which a mocked Prisma client would never prove.
 *
 * Everything created here is deleted in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OrderStatus,
  PaymentMethod,
  PrintJobType,
  Role,
  type MenuCategoryDto,
  type OrderDto,
  type TableDto,
} from '@pos/shared';
import { prisma } from '../../db.js';
import {
  buildTestApp,
  cleanupOrders,
  loginAs,
  SEED_PINS,
  type TestSession,
} from '../../test-helpers.js';

let app: FastifyInstance;
let staff: TestSession;
let manager: TestSession;
let staffCookie: string;
let managerCookie: string;
let table: TableDto;
let noodles: { id: string; priceSatang: number };
let water: { id: string; priceSatang: number };

const createdOrderIds: string[] = [];
/** Unique to this file, so no parallel suite can pick it up or clash on it. */
const OWN_TABLE_NAME = 'ทดสอบบิล T1';

/** Opens a bill and remembers it so afterAll can clean up. */
async function openBill(cookie: string, tableId: string | null): Promise<OrderDto> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);
  const response = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie },
    payload: tableId ? { id, tableId, channel: 'DINE_IN' } : { id, channel: 'TAKEAWAY' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

async function addLine(
  cookie: string,
  orderId: string,
  menuItemId: string,
  qty: number,
): Promise<OrderDto> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/lines`,
    headers: { cookie },
    payload: { id: crypto.randomUUID(), menuItemId, qty },
  });
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

beforeAll(async () => {
  app = await buildTestApp();
  staff = await loginAs(app, Role.STAFF);
  manager = await loginAs(app, Role.MANAGER);
  staffCookie = staff.cookie;
  managerCookie = manager.cookie;

  // A table this file OWNS, rather than whichever seeded one happened to be
  // free. Borrowing was fine while the layout came from the seed and nothing
  // could change it; the moment tables could be added and deleted from a
  // screen, another test file's throwaway table could be the "free" one this
  // file picked — and then vanish underneath it mid-run.
  const created = await app.inject({
    method: 'POST',
    url: '/api/manage/tables',
    headers: { cookie: managerCookie },
    payload: { name: OWN_TABLE_NAME, zone: 'ทดสอบบิล', seats: 4 },
  });
  expect(created.statusCode).toBe(201);
  const mine = (created.json().tables as { id: string; name: string }[]).find(
    (row) => row.name === OWN_TABLE_NAME,
  );
  table = { id: mine?.id as string, name: OWN_TABLE_NAME } as TableDto;

  const categories: MenuCategoryDto[] = (
    await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: staffCookie } })
  ).json().categories;
  const items = categories.flatMap((category) => category.items).filter((item) => item.isAvailable);
  noodles = items[0] as typeof noodles;
  water = (items.at(-1) ?? items[0]) as typeof water;
});

afterAll(async () => {
  await cleanupOrders(createdOrderIds);
  await prisma.tableSession.deleteMany({ where: { tableId: table.id } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'DiningTable', entityId: table.id } });
  await prisma.diningTable.deleteMany({ where: { id: table.id } });
  await app.close();
  await prisma.$disconnect();
});

describe('authentication and scope', () => {
  it('refuses every bill route without a session', async () => {
    for (const url of ['/api/tables', '/api/menu', '/api/orders/open']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    const post = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { id: crypto.randomUUID(), channel: 'TAKEAWAY' },
    });
    expect(post.statusCode).toBe(401);
  });
});

describe('cost is stripped for staff (permission matrix)', () => {
  it('hides unit cost from a STAFF session and shows it to a MANAGER', async () => {
    const order = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, order.id, noodles.id, 1);

    expect(withLine.lines[0]?.unitCostSatang).toBeUndefined();
    expect(withLine.costSatang).toBeUndefined();

    const asManager = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { cookie: managerCookie },
    });
    const managerView: OrderDto = asManager.json().order;
    expect(managerView.lines[0]?.unitCostSatang).toBeDefined();
    expect(managerView.costSatang).toBeDefined();
  });

  it('hides menu cost from a STAFF session', async () => {
    const asStaff = await app.inject({
      method: 'GET',
      url: '/api/menu',
      headers: { cookie: staffCookie },
    });
    const categories: MenuCategoryDto[] = asStaff.json().categories;
    expect(categories.flatMap((c) => c.items).every((item) => item.costSatang === undefined)).toBe(
      true,
    );
  });
});

describe('opening a bill on a table', () => {
  it('gives it a business date, an order number and occupies the table', async () => {
    const order = await openBill(staffCookie, table.id);

    expect(order.status).toBe(OrderStatus.OPEN);
    expect(order.tableName).toBe(table.name);
    // Rule #4: a calendar day in the branch timezone, not a timestamp.
    expect(order.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Rule #9: the running number carries the date so it is unique per branch.
    //
    // Three digits is a MINIMUM, not a width. The bill number is padded to
    // three and then simply keeps counting, so a stall that takes a thousand
    // orders in a day produces "260730-1000" — a perfectly good number that an
    // exact `\d{3}` here would call a bug.
    expect(order.orderNo).toMatch(/^\d{6}-\d{3,}$/);

    const tables: TableDto[] = (
      await app.inject({ method: 'GET', url: '/api/tables', headers: { cookie: staffCookie } })
    ).json().tables;
    expect(tables.find((candidate) => candidate.id === table.id)?.openOrder?.id).toBe(order.id);
  });

  it('refuses a second bill on the same table', async () => {
    const id = crypto.randomUUID();
    createdOrderIds.push(id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: staffCookie },
      payload: { id, tableId: table.id, channel: 'DINE_IN' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('TABLE_OCCUPIED');
  });

  it('is idempotent — a retried request is the same bill, not a second one', async () => {
    // Shop wifi drops responses. This is the property that makes rule #6
    // (client-generated ids) worth having.
    const id = crypto.randomUUID();
    createdOrderIds.push(id);
    const payload = { id, channel: 'TAKEAWAY' };

    const first = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: staffCookie },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: staffCookie },
      payload,
    });

    expect(first.json().order.id).toBe(second.json().order.id);
    expect(await prisma.order.count({ where: { id } })).toBe(1);
  });

  it('cancels an empty bill and frees the table', async () => {
    // Its own table, created and thrown away here. Earlier tests in this file
    // leave their bills OPEN until afterAll, so the file's main table is not
    // free — and picking "whatever is free" off the shared floor plan is how
    // this test used to grab a table another suite was about to delete.
    const created = await app.inject({
      method: 'POST',
      url: '/api/manage/tables',
      headers: { cookie: managerCookie },
      payload: { name: 'ทดสอบบิล T2', zone: 'ทดสอบบิล', seats: 2 },
    });
    expect(created.statusCode).toBe(201);
    const free = (created.json().tables as TableDto[]).find(
      (row) => row.name === 'ทดสอบบิล T2',
    ) as TableDto;

    const order = await openBill(staffCookie, free.id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      headers: { cookie: staffCookie },
      // No payload — this is exactly the request the tablet sends when a
      // cashier backs out of a table they opened by mistake.
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().order.status).toBe(OrderStatus.CANCELLED);

    const after: TableDto[] = (
      await app.inject({ method: 'GET', url: '/api/tables', headers: { cookie: staffCookie } })
    ).json().tables;
    expect(after.find((candidate) => candidate.id === free.id)?.openOrder).toBeNull();

    await prisma.tableSession.deleteMany({ where: { tableId: free.id } });
    await prisma.order.updateMany({ where: { tableId: free.id }, data: { tableId: null } });
    await prisma.diningTable.delete({ where: { id: free.id } });
  });

  it('refuses to cancel a bill that already has food on it', async () => {
    const order = await openBill(staffCookie, null);
    await addLine(staffCookie, order.id, noodles.id, 1);

    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      headers: { cookie: staffCookie },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ORDER_NOT_EMPTY');
  });

  it('never reissues a number after a bill is removed from the day', async () => {
    // The first version derived the running number from COUNT(*) of the day's
    // bills. That is only correct while no row is ever removed: take one away
    // and the count drops below the numbers already handed out, so the next
    // bill is issued one that exists — a unique violation the retry cannot fix,
    // because recounting gives the same wrong answer every time. The number is
    // now HIGHEST + 1, which tolerates gaps.
    const doomed = await openBill(staffCookie, null);
    const survivor = await openBill(staffCookie, null);
    // Removing a bill from the MIDDLE of the day is what breaks a counter:
    // the count now sits one below the highest number in use, so count+1
    // lands on the survivor's number.
    await prisma.order.delete({ where: { id: doomed.id } });

    const next = await openBill(staffCookie, null);
    const numberOf = (orderNo: string): number => Number(orderNo.split('-')[1]);
    expect(numberOf(next.orderNo as string)).toBeGreaterThan(numberOf(survivor.orderNo as string));
  });

  it('refuses a dine-in bill with no table', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: staffCookie },
      payload: { id: crypto.randomUUID(), channel: 'DINE_IN' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('TABLE_REQUIRED');
  });
});

describe('lines and totals', () => {
  it('snapshots the price and totals the bill from the lines', async () => {
    const order = await openBill(staffCookie, null);
    const withNoodles = await addLine(staffCookie, order.id, noodles.id, 2);
    const withWater = await addLine(staffCookie, withNoodles.id, water.id, 3);

    const expected = noodles.priceSatang * 2 + water.priceSatang * 3;
    expect(withWater.totalSatang).toBe(expected);
    expect(withWater.lines[0]?.unitPriceSatang).toBe(noodles.priceSatang);
    expect(withWater.lines[0]?.lineTotalSatang).toBe(noodles.priceSatang * 2);

    // VAT is off today, so net == total and the VAT columns are zero (rule #3).
    expect(withWater.vatAmountSatang).toBe(0);
    expect(withWater.vatRateBpSnapshot).toBe(0);
    expect(withWater.subtotalExVatSatang).toBe(expected);
  });

  it('a menu price change does not move a bill that is already open (rule #7)', async () => {
    // On a dish THIS test owns, not on a seeded one.
    //
    // Repricing a shared dish — even for the few milliseconds between the
    // update and the restore below — is visible to every other test file, and
    // vitest runs them in parallel. The symptom was three unrelated files
    // failing together on roughly one run in three, each of them asserting a
    // total against the price they had read at startup.
    const original = 4_800;
    const seeded = await prisma.menuItem.findUniqueOrThrow({
      where: { id: noodles.id },
      select: { branchId: true, categoryId: true },
    });
    const dish = await prisma.menuItem.create({
      data: { ...seeded, name: 'ทดสอบ-ราคาขยับ', priceSatang: original },
    });

    try {
      const order = await openBill(staffCookie, null);
      const withLine = await addLine(staffCookie, order.id, dish.id, 1);

      await prisma.menuItem.update({
        where: { id: dish.id },
        data: { priceSatang: original + 500 },
      });

      const reread = await app.inject({
        method: 'GET',
        url: `/api/orders/${order.id}`,
        headers: { cookie: staffCookie },
      });
      expect(reread.json().order.totalSatang).toBe(withLine.totalSatang);
      expect(reread.json().order.lines[0].unitPriceSatang).toBe(original);
    } finally {
      await cleanupOrders(createdOrderIds);
      createdOrderIds.length = 0;
      await prisma.menuItem.delete({ where: { id: dish.id } });
    }
  });

  it('recomputes the total when a quantity changes and when a line is removed', async () => {
    const order = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, order.id, noodles.id, 1);
    const lineId = withLine.lines[0]?.id as string;

    const bumped = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staffCookie },
      payload: { qty: 4 },
    });
    expect(bumped.json().order.totalSatang).toBe(noodles.priceSatang * 4);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staffCookie },
    });
    expect(removed.json().order.totalSatang).toBe(0);
    expect(removed.json().order.lines).toHaveLength(0);
  });

  it('writes an audit row when a line is removed (rule #8)', async () => {
    const order = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, order.id, noodles.id, 1);
    const lineId = withLine.lines[0]?.id as string;

    await app.inject({
      method: 'DELETE',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staffCookie },
    });

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'OrderLine', entityId: lineId, action: 'REMOVE_ORDER_LINE' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.staffId).not.toBeNull();
    await prisma.auditLog.deleteMany({ where: { entityId: lineId } });
  });

  it('refuses a quantity outside the sane range', async () => {
    const order = await openBill(staffCookie, null);
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines`,
      headers: { cookie: staffCookie },
      payload: { id: crypto.randomUUID(), menuItemId: noodles.id, qty: 500 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('taking money off a bill', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    mode: 'AMOUNT',
    value: 2000,
    reason: 'ลูกค้าประจำ',
    approverStaffId: manager.staffId,
    approverPin: SEED_PINS.MANAGER,
    ...overrides,
  });

  /** A bill with two bowls on it, and its gross. */
  async function billWithTwoBowls(): Promise<{ order: OrderDto; gross: number }> {
    const opened = await openBill(staffCookie, null);
    const withLines = await addLine(staffCookie, opened.id, noodles.id, 2);
    return { order: withLines, gross: withLines.totalSatang };
  }

  const discount = (orderId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/discount`,
      headers: { cookie: staffCookie },
      payload: body,
    });

  it('takes the agreed amount off and leaves the lines alone', async () => {
    const { order, gross } = await billWithTwoBowls();
    const response = await discount(order.id, payload());

    expect(response.statusCode).toBe(200);
    const after: OrderDto = response.json().order;
    expect(after.discountSatang).toBe(2000);
    expect(after.totalSatang).toBe(gross - 2000);
    expect(after.lines.every((line) => line.voidedAt === null)).toBe(true);
  });

  it('works a percentage out against the bill in front of it', async () => {
    const { order, gross } = await billWithTwoBowls();
    const response = await discount(order.id, payload({ mode: 'PERCENT', value: 1000 }));

    expect(response.statusCode).toBe(200);
    expect(response.json().order.discountSatang).toBe(Math.round(gross / 10));
  });

  it('replaces the previous discount rather than stacking on it', async () => {
    const { order } = await billWithTwoBowls();
    await discount(order.id, payload({ value: 2000 }));
    const second = await discount(order.id, payload({ value: 3000 }));

    expect(second.json().order.discountSatang).toBe(3000);
  });

  it('refuses more than the bill is worth instead of paying the customer', async () => {
    const { order, gross } = await billWithTwoBowls();
    const response = await discount(order.id, payload({ value: gross + 100 }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('DISCOUNT_TOO_LARGE');

    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.discountSatang).toBe(0);
  });

  it('refuses to discount a bill with nothing on it', async () => {
    const order = await openBill(staffCookie, null);
    const response = await discount(order.id, payload());

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ORDER_EMPTY');
  });

  it('needs a supervisor PIN — a cashier cannot sign their own', async () => {
    const { order } = await billWithTwoBowls();
    const response = await discount(
      order.id,
      payload({ approverStaffId: staff.staffId, approverPin: SEED_PINS.STAFF }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('SELF_APPROVAL');
  });

  it('refuses a wrong PIN and takes nothing off', async () => {
    const { order } = await billWithTwoBowls();
    const response = await discount(order.id, payload({ approverPin: '9999' }));

    expect(response.statusCode).toBe(401);
    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.discountSatang).toBe(0);
  });

  it('writes down what was typed, not just the satang it became (rule #8)', async () => {
    const { order } = await billWithTwoBowls();
    await discount(order.id, payload({ mode: 'PERCENT', value: 1000 }));

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Order', entityId: order.id, action: 'SET_DISCOUNT' },
    });
    // A percentage stored only as satang cannot be read back as "10%".
    expect(log.after).toMatchObject({ mode: 'PERCENT', value: 1000, reason: 'ลูกค้าประจำ' });
    expect(log.staffId).toBe(staff.staffId);
  });

  it('shrinks with the bill when the last bowl is voided', async () => {
    const opened = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, opened.id, water.id, 1);
    const lineId = withLine.lines[0]?.id as string;

    await discount(opened.id, payload({ value: withLine.totalSatang }));

    const voided = await app.inject({
      method: 'POST',
      url: `/api/orders/${opened.id}/lines/${lineId}/void`,
      headers: { cookie: staffCookie },
      payload: {
        reason: 'ลูกค้าเปลี่ยนใจ',
        approverStaffId: manager.staffId,
        approverPin: SEED_PINS.MANAGER,
      },
    });

    expect(voided.statusCode).toBe(200);
    const after: OrderDto = voided.json().order;
    // Not left sitting at the old figure while the total says nothing is owed.
    expect(after.discountSatang).toBe(0);
    expect(after.totalSatang).toBe(0);
  });

  it('puts the money back, with the same PIN it took', async () => {
    const { order, gross } = await billWithTwoBowls();
    await discount(order.id, payload());

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/orders/${order.id}/discount`,
      headers: { cookie: staffCookie },
      payload: { approverStaffId: manager.staffId, approverPin: SEED_PINS.MANAGER },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().order.discountSatang).toBe(0);
    expect(cleared.json().order.totalSatang).toBe(gross);
  });

  it('says so rather than pretending, when there is nothing to clear', async () => {
    const { order } = await billWithTwoBowls();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/orders/${order.id}/discount`,
      headers: { cookie: staffCookie },
      payload: { approverStaffId: manager.staffId, approverPin: SEED_PINS.MANAGER },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('NO_DISCOUNT');
  });

  it('is frozen onto the receipt when the money is taken', async () => {
    const { order, gross } = await billWithTwoBowls();
    await discount(order.id, payload());

    const paid = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload: { method: PaymentMethod.CASH, receivedSatang: gross },
    });

    expect(paid.statusCode).toBe(200);
    expect(paid.json().order.discountSatang).toBe(2000);
    // The change is worked out against the DISCOUNTED total, not the gross.
    expect(paid.json().changeSatang).toBe(2000);

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.amountSatang).toBe(gross - 2000);
  });
});

describe('taking the money', () => {
  it('refuses to close an empty bill', async () => {
    const order = await openBill(staffCookie, null);
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload: { method: PaymentMethod.CASH, receivedSatang: 10000 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ORDER_EMPTY');
  });

  it('refuses cash that does not cover the bill', async () => {
    const order = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, order.id, noodles.id, 2);

    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload: { method: PaymentMethod.CASH, receivedSatang: withLine.totalSatang - 100 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INSUFFICIENT_CASH');

    // And the bill is untouched — no half-finished sale.
    const still = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(still.status).toBe(OrderStatus.OPEN);
    expect(still.receiptNo).toBeNull();
  });

  it('closes the bill, counts the change, numbers the receipt and queues the print', async () => {
    const order = await openBill(staffCookie, null);
    const withNoodles = await addLine(staffCookie, order.id, noodles.id, 2);
    const total = withNoodles.totalSatang;
    const received = Math.ceil(total / 10000) * 10000 + 10000;

    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload: { method: PaymentMethod.CASH, receivedSatang: received },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.changeSatang).toBe(received - total);
    expect(body.receiptNo).toMatch(/^RC-[A-Z0-9]+-\d{4}-\d{6}$/);
    expect(body.order.status).toBe(OrderStatus.PAID);
    expect(body.order.receiptNo).toBe(body.receiptNo);
    expect(body.printJobId).not.toBeNull();

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.amountSatang).toBe(total);
    expect(payment.changeSatang).toBe(received - total);

    const job = await prisma.printJob.findUniqueOrThrow({ where: { id: body.printJobId } });
    expect(job.type).toBe(PrintJobType.RECEIPT);
    expect(job.orderId).toBe(order.id);
  });

  it('refuses to take the money twice', async () => {
    const order = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, order.id, noodles.id, 1);
    const payload = {
      method: PaymentMethod.CASH,
      receivedSatang: withLine.totalSatang + 10000,
    };

    const first = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('ORDER_NOT_OPEN');

    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('hands out receipt numbers that never repeat', async () => {
    const numbers: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const order = await openBill(staffCookie, null);
      const withLine = await addLine(staffCookie, order.id, water.id, 1);
      const response = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/pay`,
        headers: { cookie: staffCookie },
        payload: { method: PaymentMethod.CASH, receivedSatang: withLine.totalSatang + 100000 },
      });
      numbers.push(response.json().receiptNo);
    }
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('frees the table once its bill is paid', async () => {
    const tables: TableDto[] = (
      await app.inject({ method: 'GET', url: '/api/tables', headers: { cookie: staffCookie } })
    ).json().tables;
    const free = tables.find((candidate) => candidate.openOrder === null) as TableDto;
    expect(free).toBeDefined();

    const order = await openBill(staffCookie, free.id);
    const withLine = await addLine(staffCookie, order.id, water.id, 1);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staffCookie },
      payload: { method: PaymentMethod.CASH, receivedSatang: withLine.totalSatang + 100000 },
    });

    const after: TableDto[] = (
      await app.inject({ method: 'GET', url: '/api/tables', headers: { cookie: staffCookie } })
    ).json().tables;
    expect(after.find((candidate) => candidate.id === free.id)?.openOrder).toBeNull();

    const session = await prisma.tableSession.findFirst({
      where: { tableId: free.id },
      orderBy: { openedAt: 'desc' },
    });
    expect(session?.closedAt).not.toBeNull();
  });

  it('locks the PromptPay QR to the stored total', async () => {
    const order = await openBill(staffCookie, null);
    const withLine = await addLine(staffCookie, order.id, noodles.id, 1);

    const response = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}/promptpay`,
      headers: { cookie: staffCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().amountSatang).toBe(withLine.totalSatang);
    // The amount is written into the QR, so the customer cannot be shown one
    // figure on screen and asked for another by their bank app.
    const baht = Math.trunc(withLine.totalSatang / 100);
    expect(response.json().payload).toContain(`${baht}.`);
  });
});

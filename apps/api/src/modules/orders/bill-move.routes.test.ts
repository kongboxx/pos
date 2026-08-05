/**
 * ย้ายโต๊ะ / รวมบิล / แยกบิล against the real database.
 *
 * These are the three operations that move ROWS between bills, so the things
 * worth proving are the ones a mocked client could never show: that the money
 * on each side still adds up to the food on it, that a cancelled bill keeps its
 * evidence, that the floor plan tells the truth afterwards, and that the audit
 * log can explain what happened (rule #8).
 *
 * This file owns three tables of its own. It has to: it deliberately puts a
 * table into states the rest of the suite assumes are impossible — two bills at
 * once, a bill arriving from somewhere else — and borrowing a seeded table
 * would leak that into whichever file ran next.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OrderStatus, Role, type MenuCategoryDto, type OrderDto, type TableDto } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs, type TestSession } from '../../test-helpers.js';

let app: FastifyInstance;
let staff: TestSession;
let cookie: string;
let manager: string;
let tableA: { id: string; name: string };
let tableB: { id: string; name: string };
let tableC: { id: string; name: string };
let noodles: { id: string; priceSatang: number };
let water: { id: string; priceSatang: number };

const createdOrderIds: string[] = [];
const TABLE_NAMES = ['ทดสอบย้าย M1', 'ทดสอบย้าย M2', 'ทดสอบย้าย M3'];

async function makeTable(name: string): Promise<{ id: string; name: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/manage/tables',
    headers: { cookie: manager },
    payload: { name, zone: 'ทดสอบย้าย', seats: 4 },
  });
  expect(response.statusCode).toBe(201);
  const row = (response.json().tables as { id: string; name: string }[]).find(
    (table) => table.name === name,
  );
  return { id: row?.id as string, name };
}

async function openBill(tableId: string | null): Promise<OrderDto> {
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

async function addLine(orderId: string, menuItemId: string, qty = 1): Promise<OrderDto> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/lines`,
    headers: { cookie },
    payload: { id: crypto.randomUUID(), menuItemId, qty },
  });
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

/** A bill at `table` with one bowl of noodles and one bottle of water on it. */
async function billWithTwoLines(tableId: string | null): Promise<OrderDto> {
  const order = await openBill(tableId);
  await addLine(order.id, noodles.id);
  return addLine(order.id, water.id);
}

const move = (orderId: string, tableId: string) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/move-table`,
    headers: { cookie },
    payload: { tableId },
  });

const merge = (targetId: string, fromOrderId: string) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${targetId}/merge`,
    headers: { cookie },
    payload: { fromOrderId },
  });

function split(orderId: string, lineIds: string[]) {
  const newOrderId = crypto.randomUUID();
  createdOrderIds.push(newOrderId);
  return {
    newOrderId,
    response: app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/split`,
      headers: { cookie },
      payload: { newOrderId, lineIds },
    }),
  };
}

const floorPlan = async (): Promise<TableDto[]> =>
  (await app.inject({ method: 'GET', url: '/api/tables', headers: { cookie } })).json().tables;

const cardFor = async (tableId: string): Promise<TableDto> =>
  (await floorPlan()).find((table) => table.id === tableId) as TableDto;

beforeAll(async () => {
  app = await buildTestApp();
  staff = await loginAs(app, Role.STAFF);
  cookie = staff.cookie;
  manager = (await loginAs(app, Role.MANAGER)).cookie;

  [tableA, tableB, tableC] = (await Promise.all(TABLE_NAMES.map(makeTable))) as [
    typeof tableA,
    typeof tableB,
    typeof tableC,
  ];

  const categories: MenuCategoryDto[] = (
    await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie } })
  ).json().categories;
  const items = categories
    .flatMap((category) => category.items)
    .filter((item) => item.isAvailable && item.groupIds.length === 0);
  if (items.length < 2) throw new Error('the demo seed needs two option-free dishes');
  noodles = items[0] as typeof noodles;
  water = items[1] as typeof water;
});

// Every case starts from empty tables. A bill left open at M1 by one case is
// invisible to the next one's assertions right up until it is not.
afterEach(async () => {
  await cleanupOrders(createdOrderIds);
  createdOrderIds.length = 0;
});

afterAll(async () => {
  const ids = [tableA.id, tableB.id, tableC.id];
  await prisma.tableSession.deleteMany({ where: { tableId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'DiningTable', entityId: { in: ids } } });
  await prisma.diningTable.deleteMany({ where: { id: { in: ids } } });
  await app.close();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe('ย้ายโต๊ะ', () => {
  it('moves the bill, and the floor plan agrees from both ends', async () => {
    const bill = await billWithTwoLines(tableA.id);

    const response = await move(bill.id, tableB.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().order).toMatchObject({ tableId: tableB.id, tableName: tableB.name });

    expect((await cardFor(tableA.id)).openOrders).toEqual([]);
    expect((await cardFor(tableB.id)).openOrders?.[0]?.id).toBe(bill.id);
  });

  it('carries the food and the total across untouched (rule #7)', async () => {
    const before = await billWithTwoLines(tableA.id);
    const after = (await move(before.id, tableB.id)).json().order as OrderDto;

    // The whole point: a table move is a move, not a re-pricing.
    expect(after.totalSatang).toBe(before.totalSatang);
    expect(after.lines.map((line) => line.id)).toEqual(before.lines.map((line) => line.id));
  });

  it('joins the sitting already open at the new table', async () => {
    // Two bills that end up at one table belong to ONE visit, or the table
    // never frees itself when the last of them is paid.
    const first = await billWithTwoLines(tableB.id);
    const second = await billWithTwoLines(tableA.id);
    await move(second.id, tableB.id);

    const rows = await prisma.order.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { sessionId: true },
    });
    expect(rows[0]?.sessionId).toBe(rows[1]?.sessionId);
    expect(rows[0]?.sessionId).not.toBeNull();
  });

  it('lets a bill move onto a table that already has one', async () => {
    // Two groups pushing tables together and still paying separately. Merging
    // them would be a different, irreversible decision.
    await billWithTwoLines(tableB.id);
    const arriving = await billWithTwoLines(tableA.id);

    expect((await move(arriving.id, tableB.id)).statusCode).toBe(200);
    expect((await cardFor(tableB.id)).openOrders).toHaveLength(2);
  });

  it('repoints a ticket the kitchen is still cooking at the new table', async () => {
    const bill = await billWithTwoLines(tableA.id);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${bill.id}/fire`,
      headers: { cookie },
      payload: {},
    });

    await move(bill.id, tableB.id);

    const tickets = await prisma.kitchenTicket.findMany({
      where: { orderId: bill.id },
      select: { tableName: true },
    });
    expect(tickets.length).toBeGreaterThan(0);
    // The runner reads this to know where to carry the bowl.
    expect(tickets.every((ticket) => ticket.tableName === tableB.name)).toBe(true);
  });

  it('leaves a ticket that has already been served naming the old table', async () => {
    const bill = await billWithTwoLines(tableA.id);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${bill.id}/fire`,
      headers: { cookie },
      payload: {},
    });
    await prisma.kitchenTicket.updateMany({
      where: { orderId: bill.id },
      data: { status: 'DONE', doneAt: new Date() },
    });

    await move(bill.id, tableB.id);

    const tickets = await prisma.kitchenTicket.findMany({
      where: { orderId: bill.id },
      select: { tableName: true },
    });
    // That food was carried to M1. Rewriting it would make the record lie.
    expect(tickets.every((ticket) => ticket.tableName === tableA.name)).toBe(true);
  });

  it('refuses to move a takeaway bill, which has no table to leave', async () => {
    const bill = await billWithTwoLines(null);
    const response = await move(bill.id, tableB.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('NOT_DINE_IN');
  });

  it('refuses a move to the table it is already on', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const response = await move(bill.id, tableA.id);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('SAME_TABLE');
  });

  it('refuses a table that does not exist', async () => {
    const bill = await billWithTwoLines(tableA.id);
    expect((await move(bill.id, crypto.randomUUID())).statusCode).toBe(404);
  });

  it('writes who moved it and where from (rule #8)', async () => {
    const bill = await billWithTwoLines(tableA.id);
    await move(bill.id, tableB.id);

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: bill.id, action: 'ORDER_MOVE_TABLE' },
    });
    expect(entry?.staffId).toBe(staff.staffId);
    expect(entry?.before).toMatchObject({ tableName: tableA.name });
    expect(entry?.after).toMatchObject({
      tableName: tableB.name,
      describe: `ย้ายจากโต๊ะ ${tableA.name} ไปโต๊ะ ${tableB.name}`,
    });
  });
});

/* ------------------------------------------------------------------ */

describe('รวมบิล', () => {
  it('pours one bill into the other and cancels the empty one', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);

    const response = await merge(target.id, source.id);
    expect(response.statusCode).toBe(200);

    const merged = response.json().order as OrderDto;
    expect(merged.lines).toHaveLength(4);
    // Nothing was re-priced on the way across.
    expect(merged.totalSatang).toBe(target.totalSatang + source.totalSatang);

    const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: source.id } });
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.totalSatang).toBe(0);
  });

  it('frees the table the absorbed bill was sitting at', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    await merge(target.id, source.id);

    expect((await cardFor(tableB.id)).openOrders).toEqual([]);
    expect((await cardFor(tableA.id)).openOrders).toHaveLength(1);
  });

  it('keeps the lines in a readable order rather than interleaving them', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    const merged = (await merge(target.id, source.id)).json().order as OrderDto;

    expect(merged.lines.slice(0, 2).map((line) => line.id)).toEqual(
      target.lines.map((line) => line.id),
    );
    expect(merged.lines.slice(2).map((line) => line.id)).toEqual(
      source.lines.map((line) => line.id),
    );
  });

  it('leaves a voided line on the bill it was voided on', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    // Voided BEFORE firing, so no approver PIN is involved — this test is about
    // where the row ends up, not about who may cancel one.
    await app.inject({
      method: 'DELETE',
      url: `/api/orders/${source.id}/lines/${source.lines[0]?.id}`,
      headers: { cookie },
    });

    await merge(target.id, source.id);

    // Removing an unfired line deletes it outright, so what is proved here is
    // the arithmetic: only what was still live came across.
    const merged = await prisma.order.findUniqueOrThrow({
      where: { id: target.id },
      include: { lines: true },
    });
    expect(merged.lines).toHaveLength(3);
  });

  it('refuses to merge a bill into itself', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const response = await merge(bill.id, bill.id);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('SAME_BILL');
  });

  it('refuses a bill with nothing on it — that is a cancel, not a merge', async () => {
    const target = await billWithTwoLines(tableA.id);
    const empty = await openBill(tableB.id);
    const response = await merge(target.id, empty.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('NOTHING_TO_MOVE');
  });

  it('refuses when either bill carries a discount', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    await prisma.order.update({ where: { id: source.id }, data: { discountSatang: 1000 } });

    const response = await merge(target.id, source.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('DISCOUNTED');
    expect(response.json().message).toContain('ยกเลิกส่วนลดก่อน');
  });

  it('refuses to merge bills from different trading days (rule #4)', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    await prisma.order.update({
      where: { id: source.id },
      data: { businessDate: new Date('2020-01-01') },
    });

    const response = await merge(target.id, source.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('DIFFERENT_DAY');
  });

  it('moves the kitchen ticket too, so the board stops naming a dead bill', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${source.id}/fire`,
      headers: { cookie },
      payload: {},
    });

    await merge(target.id, source.id);

    expect(await prisma.kitchenTicket.count({ where: { orderId: source.id } })).toBe(0);
    const moved = await prisma.kitchenTicket.findMany({
      where: { orderId: target.id },
      select: { tableName: true },
    });
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((ticket) => ticket.tableName === tableA.name)).toBe(true);
  });

  it('leaves an audit row on BOTH bills', async () => {
    const target = await billWithTwoLines(tableA.id);
    const source = await billWithTwoLines(tableB.id);
    await merge(target.id, source.id);

    // Looking up the cancelled bill has to answer "where did its food go".
    const onSource = await prisma.auditLog.findFirst({
      where: { entityId: source.id, action: 'ORDER_MERGE' },
    });
    expect(onSource?.after).toMatchObject({ mergedInto: target.id });

    const onTarget = await prisma.auditLog.findFirst({
      where: { entityId: target.id, action: 'ORDER_MERGE' },
    });
    expect(onTarget?.after).toMatchObject({ mergedFrom: source.id });
  });
});

/* ------------------------------------------------------------------ */

describe('แยกบิล', () => {
  it('moves the chosen lines onto a new bill at the same table', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const moving = bill.lines[1]?.id as string;

    const { newOrderId, response } = split(bill.id, [moving]);
    const body = (await response).json() as { order: OrderDto; newOrder: OrderDto };
    expect((await response).statusCode).toBe(201);

    expect(body.newOrder.id).toBe(newOrderId);
    expect(body.newOrder.lines.map((line) => line.id)).toEqual([moving]);
    expect(body.order.lines.map((line) => line.id)).toEqual([bill.lines[0]?.id]);
    expect(body.newOrder.tableId).toBe(tableA.id);
  });

  it('splits the money exactly, with nothing created or lost', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { response } = split(bill.id, [bill.lines[1]?.id as string]);
    const body = (await response).json() as { order: OrderDto; newOrder: OrderDto };

    expect(body.order.totalSatang + body.newOrder.totalSatang).toBe(bill.totalSatang);
    expect(body.newOrder.totalSatang).toBe(bill.lines[1]?.lineTotalSatang);
  });

  it('shows the table carrying both bills', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { newOrderId, response } = split(bill.id, [bill.lines[1]?.id as string]);
    await response;

    const card = await cardFor(tableA.id);
    expect(card.openOrders?.map((row) => row.id).sort()).toEqual([bill.id, newOrderId].sort());
    // The old single-bill field still points at the one the table started with,
    // for tablets cached from before splitting existed.
    expect(card.openOrder?.id).toBe(bill.id);
  });

  it('keeps both halves in the same sitting', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { newOrderId, response } = split(bill.id, [bill.lines[1]?.id as string]);
    await response;

    const rows = await prisma.order.findMany({
      where: { id: { in: [bill.id, newOrderId] } },
      select: { sessionId: true },
    });
    expect(rows[0]?.sessionId).toBe(rows[1]?.sessionId);
  });

  it('puts the new bill on the SAME trading day as the one it came from (rule #4)', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { newOrderId, response } = split(bill.id, [bill.lines[1]?.id as string]);
    await response;

    const rows = await prisma.order.findMany({
      where: { id: { in: [bill.id, newOrderId] } },
      select: { businessDate: true },
    });
    expect(rows[0]?.businessDate).toEqual(rows[1]?.businessDate);
  });

  it('gives the new bill its own number in the day’s series', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { response } = split(bill.id, [bill.lines[1]?.id as string]);
    const body = (await response).json() as { newOrder: OrderDto };

    expect(body.newOrder.orderNo).toMatch(/^\d{6}-\d{3}$/);
    expect(body.newOrder.orderNo).not.toBe(bill.orderNo);
  });

  it('is idempotent on the tablet’s id (rule #6)', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const lineId = bill.lines[1]?.id as string;
    const newOrderId = crypto.randomUUID();
    createdOrderIds.push(newOrderId);

    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/orders/${bill.id}/split`,
        headers: { cookie },
        payload: { newOrderId, lineIds: [lineId] },
      });

    expect((await send()).statusCode).toBe(201);
    // A retry after a dropped response must not cut the bill in three.
    const again = await send();
    expect(again.statusCode).toBe(201);
    expect((again.json() as { newOrder: OrderDto }).newOrder.lines).toHaveLength(1);
    expect(await prisma.order.count({ where: { sessionId: { not: null }, id: newOrderId } })).toBe(
      1,
    );
  });

  it('refuses to split every line off, which would leave an empty bill', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { response } = split(
      bill.id,
      bill.lines.map((line) => line.id),
    );
    const result = await response;
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe('WOULD_EMPTY_BILL');
  });

  it('refuses a line that belongs to a different bill', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const other = await billWithTwoLines(tableB.id);
    const { response } = split(bill.id, [other.lines[0]?.id as string]);

    const result = await response;
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toBe('LINE_NOT_ON_BILL');
  });

  it('refuses to split a bill that carries a discount', async () => {
    const bill = await billWithTwoLines(tableA.id);
    await prisma.order.update({ where: { id: bill.id }, data: { discountSatang: 1000 } });

    const { response } = split(bill.id, [bill.lines[1]?.id as string]);
    const result = await response;
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe('DISCOUNTED');
  });

  it('leaves the kitchen ticket on the bill it was fired from', async () => {
    // The ticket records a kitchen event. Who pays for the bowl afterwards
    // does not change where it was ordered, and one ticket can hold lines that
    // are now on two bills.
    const bill = await billWithTwoLines(tableA.id);
    await app.inject({
      method: 'POST',
      url: `/api/orders/${bill.id}/fire`,
      headers: { cookie },
      payload: {},
    });

    const { newOrderId, response } = split(bill.id, [bill.lines[1]?.id as string]);
    await response;

    expect(await prisma.kitchenTicket.count({ where: { orderId: newOrderId } })).toBe(0);
    expect(await prisma.kitchenTicket.count({ where: { orderId: bill.id } })).toBeGreaterThan(0);
  });

  it('writes an audit row on both halves', async () => {
    const bill = await billWithTwoLines(tableA.id);
    const { newOrderId, response } = split(bill.id, [bill.lines[1]?.id as string]);
    await response;

    const onOriginal = await prisma.auditLog.findFirst({
      where: { entityId: bill.id, action: 'ORDER_SPLIT' },
    });
    expect(onOriginal?.after).toMatchObject({ splitTo: newOrderId });

    const onNew = await prisma.auditLog.findFirst({
      where: { entityId: newOrderId, action: 'ORDER_SPLIT' },
    });
    expect(onNew?.after).toMatchObject({ splitFrom: bill.id });
  });

  it('can be paid separately afterwards, leaving the other half open', async () => {
    // The whole reason the feature exists.
    const bill = await billWithTwoLines(tableA.id);
    const { newOrderId, response } = split(bill.id, [bill.lines[1]?.id as string]);
    const body = (await response).json() as { newOrder: OrderDto };

    const paid = await app.inject({
      method: 'POST',
      url: `/api/orders/${newOrderId}/pay`,
      headers: { cookie },
      payload: {
        method: 'CASH',
        amountSatang: body.newOrder.totalSatang,
        receivedSatang: body.newOrder.totalSatang,
      },
    });
    expect(paid.statusCode).toBe(200);

    // One bill paid, one still on the table, and the table still occupied.
    const card = await cardFor(tableA.id);
    expect(card.openOrders?.map((row) => row.id)).toEqual([bill.id]);
  });
});

/* ------------------------------------------------------------------ */

describe('who may do it', () => {
  it('refuses all three without a session', async () => {
    const bill = await billWithTwoLines(tableC.id);
    for (const [url, payload] of [
      [`/api/orders/${bill.id}/move-table`, { tableId: tableA.id }],
      [`/api/orders/${bill.id}/merge`, { fromOrderId: crypto.randomUUID() }],
      [`/api/orders/${bill.id}/split`, { newOrderId: crypto.randomUUID(), lineIds: [] }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(401);
    }
  });
});

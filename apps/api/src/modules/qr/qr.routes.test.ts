/**
 * The customer's phone, end to end.
 *
 * Against the real database like every other route test, because the things
 * worth testing here are all transactions or constraints: a bill that opens
 * itself, a request that must not reach the kitchen, a total that must not move
 * until a human says so, and a payment that must be refused while someone is
 * still waiting.
 *
 * The bar these are written against is not "the code does what it says" — it is
 * "what does the shop lose if this breaks". Every case below is a way the shop
 * gives away food or takes money for the wrong amount.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  Role,
  type MenuItemDto,
  type OrderDto,
  type PendingApprovalResponse,
  type QrSubmitResponse,
  type QrTableResponse,
  type TableDto,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs } from '../../test-helpers.js';
import { resetQrRateLimits } from './qr.routes.js';

let app: FastifyInstance;
let staff: { staffId: string; cookie: string };
let manager: { staffId: string; cookie: string };
let noodles: MenuItemDto;
let table: { id: string; name: string; qrToken: string };

const createdOrderIds: string[] = [];

/** Everything the phone does goes through this: no cookie, ever. */
async function scan(token = table.qrToken): Promise<QrTableResponse> {
  const response = await app.inject({ method: 'GET', url: `/api/qr/${token}` });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function submit(
  lines: { menuItemId: string; qty?: number; id?: string }[],
  token = table.qrToken,
): Promise<{ statusCode: number; body: QrSubmitResponse & { message?: string } }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/qr/${token}/order`,
    payload: { lines: lines.map((line) => ({ id: line.id ?? crypto.randomUUID(), ...line })) },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

async function pending(): Promise<PendingApprovalResponse> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/orders/pending-approval',
    headers: { cookie: staff.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function openOrderOnTable(): Promise<OrderDto> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/orders/open',
    headers: { cookie: manager.cookie },
  });
  const orders: OrderDto[] = response.json().orders;
  const found = orders.find((order) => order.tableId === table.id);
  if (!found) throw new Error('no open bill on the test table');
  if (!createdOrderIds.includes(found.id)) createdOrderIds.push(found.id);
  return found;
}

beforeAll(async () => {
  app = await buildTestApp();
  staff = await loginAs(app, Role.STAFF);
  manager = await loginAs(app, Role.MANAGER);

  const menu = await app.inject({
    method: 'GET',
    url: '/api/menu',
    headers: { cookie: staff.cookie },
  });
  const items: MenuItemDto[] = menu
    .json()
    .categories.flatMap((c: { items: MenuItemDto[] }) => c.items);
  const available = items.find((item) => item.isAvailable && item.groupIds.length === 0);
  if (!available) throw new Error('the seed has no option-free available item');
  noodles = available;

  // The LAST table in the layout, so a walkthrough happening in a browser at
  // the same time (which always starts at A1) does not collide with this.
  const row = await prisma.diningTable.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { sortOrder: 'desc' },
    select: { id: true, name: true, qrToken: true },
  });
  table = row;
});

// One test file is a burst of orders at a single table in a few seconds, which
// is exactly the shape the rate limiter refuses. Cleared per case rather than
// raised, so the limit stays the one the shop actually runs with.
beforeEach(() => {
  resetQrRateLimits();
});

afterEach(async () => {
  await cleanupOrders(createdOrderIds);
  createdOrderIds.length = 0;
  await prisma.branch.updateMany({ data: { qrOrderingEnabled: true } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('scanning the sticker', () => {
  it('shows the shop, the table and the menu without a login', async () => {
    const view = await scan();
    expect(view.tableName).toBe(table.name);
    expect(view.orderingEnabled).toBe(true);
    expect(view.menu.categories.length).toBeGreaterThan(0);
    expect(view.bill.lines).toEqual([]);
  });

  it('never sends cost to a page anyone can open', async () => {
    const view = await scan();
    const items = view.menu.categories.flatMap((category) => category.items);
    // Not "the page does not show it" — the field must not be in the JSON at
    // all, or the shop's margins are one devtools tab away from every customer.
    expect(items.every((item) => item.costSatang === undefined)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('costSatang');
  });

  it('gives the same 404 for a bad token as for a retired table', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/qr/aaaaaaaaaaaaaaaa' });
    expect(response.statusCode).toBe(404);
    // Telling the two apart would make this endpoint a way to count a shop's
    // tables by trying tokens.
    expect(response.json().message).toContain('ใช้ไม่ได้แล้ว');
  });
});

describe('sending an order', () => {
  it('opens the bill itself when nobody has served the table yet', async () => {
    const result = await submit([{ menuItemId: noodles.id }]);
    expect(result.statusCode).toBe(201);
    expect(result.body.accepted).toBe(1);

    const order = await openOrderOnTable();
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]?.source).toBe('QR');
    expect(order.lines[0]?.approvedAt).toBeNull();
  });

  it('keeps a pending line out of the bill total', async () => {
    await submit([{ menuItemId: noodles.id, qty: 2 }]);
    const order = await openOrderOnTable();

    // The line is on the bill and the bill is worth nothing: the shop has not
    // agreed to sell anything yet.
    expect(order.lines).toHaveLength(1);
    expect(order.totalSatang).toBe(0);
  });

  it('prices the line from the menu, not from anything the phone sends', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/qr/${table.qrToken}/order`,
      payload: {
        lines: [
          {
            id: crypto.randomUUID(),
            menuItemId: noodles.id,
            qty: 1,
            // A tampered client asking for a bowl at 1 satang. There is no
            // price field in the schema, so this is simply ignored.
            unitPriceSatang: 1,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);

    const order = await openOrderOnTable();
    expect(order.lines[0]?.unitPriceSatang).toBe(noodles.priceSatang);
  });

  it('treats a resent order as the same order, not a second one', async () => {
    const lineId = crypto.randomUUID();
    const first = await submit([{ id: lineId, menuItemId: noodles.id }]);
    const second = await submit([{ id: lineId, menuItemId: noodles.id }]);

    expect(first.body.accepted).toBe(1);
    // Flaky 4G, a double tap, a page reload mid-request — the id came from the
    // phone (rule #6) so the server keeps the row it already has.
    expect(second.body.accepted).toBe(0);
    expect((await openOrderOnTable()).lines).toHaveLength(1);
  });

  it('does not leave an empty bill on the table when the order is refused', async () => {
    // The phone has had the page open since lunchtime and taps something that
    // sold out ten minutes ago. The bill is opened before the lines are added,
    // so without cleanup the table would go amber on the floor plan for a bill
    // nobody opened, nobody understands, and nobody is going to close.
    //
    // On a dish THIS test owns. Marking a SEEDED dish unavailable — even for
    // the moment between the update and the restore — makes every parallel
    // test file's addLine on that dish come back 409, which surfaces as an
    // unrelated file failing about one run in three.
    const template = await prisma.menuItem.findFirstOrThrow({
      where: { isAvailable: true },
      select: { branchId: true, categoryId: true },
    });
    const item = await prisma.menuItem.create({
      data: { ...template, name: 'ทดสอบ-คิวอาร์-ของหมด', priceSatang: 5000, isAvailable: false },
    });

    try {
      const result = await submit([{ menuItemId: item.id }]);
      expect(result.statusCode).toBe(409);
      expect(result.body.message).toContain('หมดแล้ว');

      const tables = await app.inject({
        method: 'GET',
        url: '/api/tables',
        headers: { cookie: staff.cookie },
      });
      const row = (tables.json().tables as TableDto[]).find((t) => t.id === table.id);
      expect(row?.openOrder).toBeNull();
    } finally {
      await prisma.menuItem.delete({ where: { id: item.id } });
    }
  });

  it('refuses everything once the shop switches QR ordering off', async () => {
    const off = await app.inject({
      method: 'PATCH',
      url: '/api/manage/qr-ordering',
      headers: { cookie: manager.cookie },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);

    const result = await submit([{ menuItemId: noodles.id }]);
    expect(result.statusCode).toBe(409);
    expect(result.body.message).toContain('เรียกพนักงาน');

    // ...but the menu still loads, so a customer who scans reads an answer
    // rather than a broken page.
    const view = await scan();
    expect(view.orderingEnabled).toBe(false);
    expect(view.menu.categories.length).toBeGreaterThan(0);
  });
});

describe('nothing reaches the kitchen unasked', () => {
  it('will not fire a pending line even when the whole bill is sent', async () => {
    await submit([{ menuItemId: noodles.id }]);
    const order = await openOrderOnTable();

    const fired = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/fire`,
      headers: { cookie: staff.cookie },
      payload: {},
    });

    // "ส่งครัว" is the button everyone presses all day. If it swept up
    // unapproved requests, the approval queue would be decoration.
    expect(fired.statusCode).toBe(409);
    expect(fired.json().message).toContain('ส่งไปหมดแล้ว');
  });

  it('refuses payment while a customer is still waiting for an answer', async () => {
    await submit([{ menuItemId: noodles.id }]);
    const order = await openOrderOnTable();

    const paid = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { cookie: staff.cookie },
      payload: { method: 'CASH', receivedSatang: 100_000 },
    });

    // Otherwise the bill closes for a total that leaves the bowl out, and the
    // request is stranded on a bill nobody will open again.
    expect(paid.statusCode).toBe(409);
    expect(paid.json().error).toBe('QR_APPROVAL_PENDING');
  });
});

describe('the approval queue', () => {
  it('lists what is waiting, with the table and how long it has been there', async () => {
    await submit([{ menuItemId: noodles.id, qty: 2 }]);
    const order = await openOrderOnTable();

    const queue = await pending();
    const entry = queue.orders.find((row) => row.orderId === order.id);
    expect(entry).toBeDefined();
    expect(entry?.tableName).toBe(table.name);
    expect(entry?.lines).toHaveLength(1);
    expect(entry?.lines[0]?.qty).toBe(2);
    expect(Number.isNaN(Date.parse(entry?.waitingSince ?? ''))).toBe(false);
  });

  it('approves and sends to the kitchen in one press, and moves the total', async () => {
    await submit([{ menuItemId: noodles.id }]);
    const order = await openOrderOnTable();
    const lineId = order.lines[0]?.id as string;

    const approved = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/approve`,
      headers: { cookie: staff.cookie },
      payload: { lineIds: [lineId] },
    });
    expect(approved.statusCode).toBe(200);

    const body: { order: OrderDto; stations: string[] } = approved.json();
    expect(body.stations.length).toBeGreaterThan(0);
    expect(body.order.lines[0]?.approvedAt).not.toBeNull();
    expect(body.order.lines[0]?.firedAt).not.toBeNull();
    expect(body.order.totalSatang).toBe(noodles.priceSatang);

    // And the customer's phone now says it is being cooked.
    const bill = await app.inject({ method: 'GET', url: `/api/qr/${table.qrToken}/bill` });
    expect(bill.json().bill.lines[0].status).toBe('COOKING');
    expect(bill.json().bill.pendingCount).toBe(0);
  });

  it('refuses to approve the same line twice', async () => {
    await submit([{ menuItemId: noodles.id }]);
    const order = await openOrderOnTable();
    const lineId = order.lines[0]?.id as string;
    const options = {
      method: 'POST' as const,
      url: `/api/orders/${order.id}/approve`,
      headers: { cookie: staff.cookie },
      payload: { lineIds: [lineId] },
    };

    expect((await app.inject(options)).statusCode).toBe(200);
    // A second press would otherwise fire a second ticket for one bowl.
    expect((await app.inject(options)).statusCode).toBe(409);
  });

  it('closes the bill it opened when every request on it is refused', async () => {
    await submit([{ menuItemId: noodles.id }]);
    const order = await openOrderOnTable();

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/reject`,
      headers: { cookie: staff.cookie },
      payload: { lineIds: [order.lines[0]?.id], reason: 'ไม่มีใครนั่งโต๊ะนี้' },
    });
    expect(rejected.statusCode).toBe(200);

    // Nobody opened this bill and nobody was going to close it — the customer
    // never spoke to a member of staff. Leaving it would hold the table.
    expect(rejected.json().order.status).toBe('CANCELLED');

    const tables = await app.inject({
      method: 'GET',
      url: '/api/tables',
      headers: { cookie: staff.cookie },
    });
    const row = (tables.json().tables as TableDto[]).find((t) => t.id === table.id);
    expect(row?.openOrder).toBeNull();
  });

  it('keeps a bill that also holds staff lines when a request is refused', async () => {
    await submit([{ menuItemId: noodles.id }]);
    const order = await openOrderOnTable();

    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines`,
      headers: { cookie: staff.cookie },
      payload: { id: crypto.randomUUID(), menuItemId: noodles.id, qty: 1 },
    });

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/reject`,
      headers: { cookie: staff.cookie },
      payload: { lineIds: [order.lines[0]?.id] },
    });

    expect(rejected.json().order.status).toBe('OPEN');
    expect(rejected.json().order.lines).toHaveLength(1);
  });

  it('shows the waiting count on the floor plan, so the badge is not a lie', async () => {
    await submit([{ menuItemId: noodles.id }]);
    await openOrderOnTable();

    const tables = await app.inject({
      method: 'GET',
      url: '/api/tables',
      headers: { cookie: staff.cookie },
    });
    const row = (tables.json().tables as TableDto[]).find((t) => t.id === table.id);
    expect(row?.pendingApprovalCount).toBe(1);
  });
});

describe('rotating a sticker', () => {
  it('kills the old token and hands out a new one', async () => {
    const before = table.qrToken;

    const rotated = await app.inject({
      method: 'POST',
      url: `/api/manage/tables/${table.id}/rotate-qr`,
      headers: { cookie: manager.cookie },
    });
    expect(rotated.statusCode).toBe(200);

    const after = (rotated.json().tables as { id: string; qrToken: string }[]).find(
      (row) => row.id === table.id,
    )?.qrToken as string;
    expect(after).not.toBe(before);

    // This is the whole point of the button: the photograph someone took of
    // the old sticker stops working.
    expect((await app.inject({ method: 'GET', url: `/api/qr/${before}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/qr/${after}` })).statusCode).toBe(200);

    table = { ...table, qrToken: after };
  });

  it('is closed to a cashier', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/manage/qr-ordering',
      headers: { cookie: staff.cookie },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the rate limiter in front of it all', () => {
  it('stops one phone flooding the approval queue', async () => {
    // The limiter is the only thing between a public endpoint and a script, so
    // the wiring is worth a case of its own — the counter's own arithmetic is
    // covered in rate-limit.test.ts.
    const results: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      results.push((await submit([{ menuItemId: noodles.id }])).statusCode);
    }
    await openOrderOnTable();

    expect(results.filter((status) => status === 201)).toHaveLength(6);
    expect(results.at(-1)).toBe(429);
  });
});

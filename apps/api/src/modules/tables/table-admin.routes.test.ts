/**
 * Editing the floor plan.
 *
 * Two refusals here are the whole point, and both are silent-wrong if missing:
 *
 *  - a table with an OPEN bill must not be retired or deleted. Retiring hides
 *    it from the floor plan, and food on a hidden table can never be charged
 *    for;
 *  - a table that has EVER held a bill must not be deleted. `Order.tableId` is
 *    an optional relation, so Postgres would set it null rather than refuse —
 *    every past bill would quietly lose its table name.
 *
 * ISOLATION: every table this file touches is one it created, named with a
 * prefix, and the seeded twelve are never edited — a parallel file opening a
 * bill on "A1" must not find it renamed underneath.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Role, type TableQrDto, type TableQrResponse } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs } from '../../test-helpers.js';

const PREFIX = 'ทดสอบผัง';
const ZONE = 'ทดสอบโซน';

let app: FastifyInstance;
let manager: { staffId: string; cookie: string };
let staff: { staffId: string; cookie: string };
let branchId: string;
let startedAt: Date;

const createdOrderIds: string[] = [];

const post = (url: string, payload?: Record<string, unknown>, cookie = manager.cookie) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload: payload ?? {} });

function body(over: Record<string, unknown> = {}) {
  return { name: `${PREFIX} A1`, zone: ZONE, seats: 4, isActive: true, ...over };
}

async function addTable(name: string, zone: string | null = ZONE): Promise<TableQrDto> {
  const response = await post('/api/manage/tables', body({ name: `${PREFIX} ${name}`, zone }));
  expect(response.statusCode).toBe(201);
  return findTable(response.json(), name);
}

function findTable(snapshot: TableQrResponse, name: string): TableQrDto {
  const table = snapshot.tables.find((row) => row.name === `${PREFIX} ${name}`);
  if (!table) throw new Error(`no table named ${name} in the snapshot`);
  return table;
}

/** Opens a bill on a table so the "open bill" refusals have something to see. */
async function openBillOn(tableId: string): Promise<string> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);
  const response = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: staff.cookie },
    payload: { id, tableId, channel: 'DINE_IN' },
  });
  expect(response.statusCode).toBe(201);
  return id;
}

beforeAll(async () => {
  app = await buildTestApp();
  manager = await loginAs(app, Role.MANAGER);
  staff = await loginAs(app, Role.STAFF);
  branchId = (
    await prisma.branch.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    })
  ).id;
  startedAt = new Date();
});

afterEach(async () => {
  await cleanupOrders(createdOrderIds);
  createdOrderIds.length = 0;

  const mine = await prisma.diningTable.findMany({
    where: { branchId, name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = mine.map((row) => row.id);
  await prisma.tableSession.deleteMany({ where: { tableId: { in: ids } } });
  await prisma.diningTable.deleteMany({ where: { id: { in: ids } } });
  await prisma.auditLog.deleteMany({
    where: { entityType: 'DiningTable', createdAt: { gte: startedAt } },
  });
});

afterAll(async () => {
  await app.close();
});

describe('who may edit the floor plan', () => {
  it('refuses a cashier', async () => {
    const response = await post('/api/manage/tables', body(), staff.cookie);
    expect(response.statusCode).toBe(403);
  });
});

describe('adding a table', () => {
  it('gives it a sticker code straight away and puts it last in its zone', async () => {
    // The column is NOT NULL and unique; a table with no token would be a hole
    // in the QR screen nobody notices until a customer scans nothing.
    const first = await addTable('A1');
    expect(first.qrToken).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(first.hasHistory).toBe(false);
    expect(first.hasOpenBill).toBe(false);

    const snapshot = (await post('/api/manage/tables', body({ name: `${PREFIX} A2` }))).json();
    expect(findTable(snapshot, 'A2').sortOrder).toBeGreaterThan(
      findTable(snapshot, 'A1').sortOrder,
    );
  });

  it('refuses a name another table already has, in Thai', async () => {
    await addTable('A1');
    const again = await post('/api/manage/tables', body({ name: `${PREFIX} A1` }));

    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('TABLE_NAME_TAKEN');
    expect(again.json().message).toContain(`${PREFIX} A1`);
  });

  it('stores an empty zone as null rather than as an empty string', async () => {
    // Two tables that look unzoned but sort into different groups is the kind
    // of thing nobody debugs, they just re-add the table.
    const table = await addTable('C1', null);
    expect(table.zone).toBeNull();
  });

  it('leaves an audit trail', async () => {
    const table = await addTable('A1');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'CREATE_TABLE', entityId: table.id },
    });
    expect((audit.after as { name: string }).name).toBe(`${PREFIX} A1`);
  });
});

describe('renaming', () => {
  it('keeps the sticker code so nobody has to reprint', async () => {
    const before = await addTable('A1');
    const response = await app.inject({
      method: 'PUT',
      url: `/api/manage/tables/${before.id}`,
      headers: { cookie: manager.cookie },
      payload: body({ name: `${PREFIX} A01`, seats: 6 }),
    });
    expect(response.statusCode).toBe(200);

    const after = findTable(response.json(), 'A01');
    // Correcting a name must not send anyone round the room with a scraper.
    expect(after.qrToken).toBe(before.qrToken);
    expect(after.seats).toBe(6);
  });

  it('moves a table to the end of its new zone when the zone changes', async () => {
    await addTable('A1');
    const moving = await addTable('A2');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/manage/tables/${moving.id}`,
      headers: { cookie: manager.cookie },
      payload: body({ name: `${PREFIX} A2`, zone: `${ZONE} 2` }),
    });
    expect(response.statusCode).toBe(200);
    // Keeping the old number would put it somewhere arbitrary in a zone whose
    // numbering it has never been part of.
    expect(findTable(response.json(), 'A2').sortOrder).toBe(0);
  });
});

describe('retiring and deleting', () => {
  it('refuses to retire a table that still has a bill on it', async () => {
    const table = await addTable('A1');
    await openBillOn(table.id);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/manage/tables/${table.id}`,
      headers: { cookie: manager.cookie },
      payload: body({ isActive: false }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('TABLE_HAS_OPEN_BILL');
  });

  it('refuses to delete a table that still has a bill on it', async () => {
    const table = await addTable('A1');
    await openBillOn(table.id);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/manage/tables/${table.id}`,
      headers: { cookie: manager.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('TABLE_HAS_OPEN_BILL');
  });

  it('refuses to delete a table that has ever held a bill, and says to retire it', async () => {
    const table = await addTable('A1');
    const orderId = await openBillOn(table.id);
    // Close the bill: the table is now free, but its name is on a real bill.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/manage/tables/${table.id}`,
      headers: { cookie: manager.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('TABLE_HAS_HISTORY');
    expect(response.json().message).toContain('ปิดใช้');

    // Deleting would have set Order.tableId to null and lost the name.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).tableId).toBe(
      table.id,
    );
  });

  it('deletes a table nothing points at', async () => {
    const table = await addTable('A1');
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/manage/tables/${table.id}`,
      headers: { cookie: manager.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tables.some((row: TableQrDto) => row.id === table.id)).toBe(false);
  });

  it('retires a free table and takes it off the floor plan without losing it here', async () => {
    const table = await addTable('A1');
    const response = await app.inject({
      method: 'PUT',
      url: `/api/manage/tables/${table.id}`,
      headers: { cookie: manager.cookie },
      payload: body({ isActive: false }),
    });
    expect(response.statusCode).toBe(200);
    expect(findTable(response.json(), 'A1').isActive).toBe(false);

    // Gone from the till's floor plan...
    const floor = await app.inject({
      method: 'GET',
      url: '/api/tables',
      headers: { cookie: staff.cookie },
    });
    expect(floor.json().tables.some((row: { id: string }) => row.id === table.id)).toBe(false);
  });

  it('marks a table that has held a bill so the screen can offer the right button', async () => {
    const table = await addTable('A1');
    await openBillOn(table.id);

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/manage/tables',
      headers: { cookie: manager.cookie },
    });
    const row = findTable(snapshot.json(), 'A1');
    expect(row.hasHistory).toBe(true);
    expect(row.hasOpenBill).toBe(true);
  });
});

describe('reordering', () => {
  it('swaps a table with its neighbour and renumbers the zone', async () => {
    const first = await addTable('A1');
    const second = await addTable('A2');
    expect(first.sortOrder).toBeLessThan(second.sortOrder);

    const response = await post(`/api/manage/tables/${second.id}/move`, { direction: 'UP' });
    expect(response.statusCode).toBe(200);

    const after = response.json();
    expect(findTable(after, 'A2').sortOrder).toBe(0);
    expect(findTable(after, 'A1').sortOrder).toBe(1);
  });

  it('does nothing rather than erroring at the end of a zone', async () => {
    // The button is disabled on screen; a 409 for pressing an edge is noise.
    const only = await addTable('A1');
    const response = await post(`/api/manage/tables/${only.id}/move`, { direction: 'UP' });

    expect(response.statusCode).toBe(200);
    expect(findTable(response.json(), 'A1').sortOrder).toBe(only.sortOrder);
  });

  it('only moves within the same zone', async () => {
    const here = await addTable('A1');
    await addTable('B1', `${ZONE} 2`);

    const response = await post(`/api/manage/tables/${here.id}/move`, { direction: 'DOWN' });
    expect(response.statusCode).toBe(200);
    // A1 is alone in its zone, so a neighbour in another zone must not be
    // reachable by pressing ลง.
    expect(findTable(response.json(), 'A1').sortOrder).toBe(0);
    expect(findTable(response.json(), 'B1').sortOrder).toBe(0);
  });
});

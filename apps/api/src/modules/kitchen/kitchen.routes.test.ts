/**
 * Sending food to the kitchen, and taking it back off the bill.
 *
 * Against the real database, like the other route tests, because everything
 * that matters here is a transaction: a fired line must become uneditable in
 * the same breath as the ticket appearing, and a void must move the total, the
 * void log and the kitchen board together or not at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import {
  Role,
  TicketStatus,
  type KitchenBoardResponse,
  type KitchenTicketDto,
  type MenuCategoryDto,
  type MenuItemDto,
  type OrderDto,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs, SEED_PINS } from '../../test-helpers.js';

let app: FastifyInstance;
let staff: { staffId: string; cookie: string };
let manager: { staffId: string; cookie: string };
let noodles: MenuItemDto;
/** Something fired to a DIFFERENT station, so "one ticket per station" is real. */
let drink: MenuItemDto;

const createdOrderIds: string[] = [];

/**
 * A PIN nobody else in the branch has.
 *
 * Staff PINs are unique per branch at the database level — two people who can
 * both type 3333 would make "who approved this" unanswerable — so a throwaway
 * account cannot simply borrow the seeded one.
 */
const OTHER_PIN = '4321';

async function openBill(): Promise<OrderDto> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);
  const response = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: staff.cookie },
    payload: { id, channel: 'TAKEAWAY' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

async function addLine(orderId: string, item: MenuItemDto, qty = 1): Promise<OrderDto> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/lines`,
    headers: { cookie: staff.cookie },
    payload: { id: crypto.randomUUID(), menuItemId: item.id, qty },
  });
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

async function fire(orderId: string): Promise<{ order: OrderDto; stations: string[] }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/fire`,
    headers: { cookie: staff.cookie },
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function board(station?: string): Promise<KitchenBoardResponse> {
  const response = await app.inject({
    method: 'GET',
    url: station
      ? `/api/kitchen/board?station=${encodeURIComponent(station)}`
      : '/api/kitchen/board',
    headers: { cookie: staff.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/** The tickets on the board that belong to one bill. */
async function ticketsFor(orderId: string, station?: string): Promise<KitchenTicketDto[]> {
  const { tickets } = await board(station);
  return tickets.filter((ticket) => ticket.orderId === orderId);
}

beforeAll(async () => {
  app = await buildTestApp();
  staff = await loginAs(app, Role.STAFF);
  manager = await loginAs(app, Role.MANAGER);

  const categories: MenuCategoryDto[] = (
    await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: staff.cookie } })
  ).json().categories;
  const items = categories.flatMap((category) => category.items).filter((item) => item.isAvailable);

  noodles = items[0] as MenuItemDto;
  drink = items.find((item) => item.station !== noodles.station) as MenuItemDto;
  expect(drink).toBeDefined();
});

afterAll(async () => {
  await cleanupOrders(createdOrderIds);
  await app.close();
  await prisma.$disconnect();
});

describe('sending an order to the kitchen', () => {
  it('splits one press into one ticket per station', async () => {
    // The noodle counter and the drinks fridge are different people standing in
    // different places. A ticket neither of them owns is a ticket both ignore.
    const order = await openBill();
    await addLine(order.id, noodles, 2);
    await addLine(order.id, drink);

    const result = await fire(order.id);

    expect(result.stations).toHaveLength(2);
    expect(result.order.lines.every((line) => line.firedAt !== null)).toBe(true);

    const tickets = await ticketsFor(order.id);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((ticket) => ticket.station))).toEqual(new Set(result.stations));

    const noodleTicket = tickets.find((ticket) => ticket.station === noodles.station);
    expect(noodleTicket?.lines).toHaveLength(1);
    expect(noodleTicket?.lines[0]?.qty).toBe(2);
    expect(noodleTicket?.lines[0]?.nameSnapshot).toBe(noodles.name);
    expect(noodleTicket?.status).toBe(TicketStatus.PENDING);
  });

  it('refuses a second press when there is nothing new', async () => {
    // A cashier who taps twice because the kitchen did not shout back must not
    // send the same bowls again.
    const order = await openBill();
    await addLine(order.id, noodles);
    await fire(order.id);

    const again = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/fire`,
      headers: { cookie: staff.cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('NOTHING_TO_FIRE');
  });

  it('sends only what is new when more is ordered later', async () => {
    const order = await openBill();
    await addLine(order.id, noodles);
    await fire(order.id);

    await addLine(order.id, drink);
    const second = await fire(order.id);

    // A second round is its own ticket on purpose: that is how a kitchen reads
    // "this just came in" as different from "this has been sitting here".
    expect(second.stations).toEqual([drink.station]);
    const tickets = await ticketsFor(order.id);
    expect(tickets).toHaveLength(2);
    expect(tickets.flatMap((ticket) => ticket.lines)).toHaveLength(2);
  });

  it('locks a fired line against ordinary editing', async () => {
    const order = await openBill();
    const withLine = await addLine(order.id, noodles);
    const lineId = withLine.lines[0]?.id as string;
    await fire(order.id);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staff.cookie },
      payload: { qty: 5 },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error).toBe('LINE_ALREADY_FIRED');

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staff.cookie },
    });
    expect(remove.statusCode).toBe(409);
  });
});

describe('voiding a line', () => {
  /** A bill with one fired line, and that line's id. */
  async function firedBill(): Promise<{ order: OrderDto; lineId: string }> {
    const order = await openBill();
    const withLine = await addLine(order.id, noodles);
    await fire(order.id);
    return { order: withLine, lineId: withLine.lines[0]?.id as string };
  }

  const voidPayload = (overrides: Record<string, unknown> = {}) => ({
    reason: 'ทำผิดเมนู',
    approverStaffId: manager.staffId,
    approverPin: SEED_PINS.MANAGER,
    ...overrides,
  });

  async function requestVoid(
    orderId: string,
    lineId: string,
    payload: Record<string, unknown>,
    cookie = staff.cookie,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/lines/${lineId}/void`,
      headers: { cookie },
      payload,
    });
  }

  it('takes the line off the total and leaves it on the bill as evidence', async () => {
    const { order, lineId } = await firedBill();
    const before = order.totalSatang;
    expect(before).toBeGreaterThan(0);

    const response = await requestVoid(order.id, lineId, voidPayload());
    expect(response.statusCode).toBe(200);

    const after: OrderDto = response.json().order;
    expect(after.totalSatang).toBe(0);
    // Still there. Deleting it would erase what happened.
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]?.voidedAt).not.toBeNull();
  });

  it('records who asked, who approved, and that the food had been cooked', async () => {
    const { order, lineId } = await firedBill();
    await requestVoid(order.id, lineId, voidPayload({ reason: 'ของหมด' }));

    const log = await prisma.voidLog.findFirstOrThrow({ where: { orderLineId: lineId } });
    expect(log.reason).toBe('ของหมด');
    expect(log.requestedByStaffId).toBe(staff.staffId);
    expect(log.approvedByStaffId).toBe(manager.staffId);
    // The whole point of the flag: this one was a real loss, not a correction.
    expect(log.wasFired).toBe(true);
    expect(log.amountSatang).toBeGreaterThan(0);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: lineId, action: 'VOID_LINE' },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses to let the cashier approve their own void', async () => {
    const { order, lineId } = await firedBill();
    const response = await requestVoid(
      order.id,
      lineId,
      voidPayload({ approverStaffId: staff.staffId, approverPin: SEED_PINS.STAFF }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('SELF_APPROVAL');
  });

  it('refuses an approver whose role cannot approve', async () => {
    // A second STAFF account walking past is not a supervisor. Their own PIN is
    // correct and the request still has to fail — the role is the gate, not the
    // ability to type four digits.
    const other = await prisma.staff.create({
      data: {
        // Oldest active branch — the SAME one `requireDefaultBranch` resolves
        // and therefore the one this session belongs to. An unordered
        // findFirst put this person on a throwaway branch another test file
        // had just created, and the void then failed with "approver not
        // found" instead of the 403 under test.
        branchId: (
          await prisma.branch.findFirstOrThrow({
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
          })
        ).id,
        fullName: 'พนักงานอีกคน',
        role: Role.STAFF,
        startDate: new Date(),
        pinHash: await bcrypt.hash(OTHER_PIN, 10),
      },
    });

    const { order, lineId } = await firedBill();
    const response = await requestVoid(
      order.id,
      lineId,
      voidPayload({ approverStaffId: other.id, approverPin: OTHER_PIN }),
    );

    expect(response.statusCode).toBe(403);
    await prisma.staff.delete({ where: { id: other.id } });
  });

  it('refuses a wrong approver PIN and leaves the bill untouched', async () => {
    const { order, lineId } = await firedBill();
    const response = await requestVoid(order.id, lineId, voidPayload({ approverPin: '0000' }));
    expect(response.statusCode).toBe(401);

    const still = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { cookie: staff.cookie },
    });
    expect(still.json().order.lines[0].voidedAt).toBeNull();

    // Undo the failed attempt so the next test is not fighting a lockout.
    await prisma.staff.update({
      where: { id: manager.staffId },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
  });

  it('makes "อื่นๆ" carry a written reason', async () => {
    const { order, lineId } = await firedBill();
    const response = await requestVoid(order.id, lineId, voidPayload({ reason: 'อื่นๆ' }));
    expect(response.statusCode).toBe(400);
  });

  it('refuses to void the same line twice', async () => {
    const { order, lineId } = await firedBill();
    expect((await requestVoid(order.id, lineId, voidPayload())).statusCode).toBe(200);

    const again = await requestVoid(order.id, lineId, voidPayload());
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('LINE_ALREADY_VOIDED');
  });
});

describe('the kitchen board', () => {
  it('shows only the station that was asked for', async () => {
    const order = await openBill();
    await addLine(order.id, noodles);
    await addLine(order.id, drink);
    await fire(order.id);

    const noodleOnly = await ticketsFor(order.id, noodles.station ?? undefined);
    expect(noodleOnly).toHaveLength(1);
    expect(noodleOnly[0]?.station).toBe(noodles.station);
  });

  it('lists every station from the menu, not just the ones fired today', async () => {
    // Otherwise the filter buttons appear one at a time during service, which
    // is exactly when nobody wants the screen changing shape.
    const { stations } = await board();
    expect(stations).toContain(noodles.station);
    expect(stations).toContain(drink.station);
  });

  it('walks a ticket from waiting to done and back', async () => {
    const order = await openBill();
    await addLine(order.id, noodles);
    await fire(order.id);
    const ticket = (await ticketsFor(order.id))[0] as KitchenTicketDto;

    const started = await app.inject({
      method: 'POST',
      url: `/api/kitchen/tickets/${ticket.id}/start`,
      headers: { cookie: staff.cookie },
      payload: {},
    });
    expect(started.json().ticket.status).toBe(TicketStatus.IN_PROGRESS);

    const done = await app.inject({
      method: 'POST',
      url: `/api/kitchen/tickets/${ticket.id}/done`,
      headers: { cookie: staff.cookie },
      payload: {},
    });
    expect(done.json().ticket.status).toBe(TicketStatus.DONE);
    expect(done.json().ticket.lines[0].doneAt).not.toBeNull();

    // A wet hand closes cards. Without an undo the only recovery is asking the
    // counter to read the bill back, in the middle of service.
    const recalled = await app.inject({
      method: 'POST',
      url: `/api/kitchen/tickets/${ticket.id}/recall`,
      headers: { cookie: staff.cookie },
      payload: {},
    });
    expect(recalled.json().ticket.status).toBe(TicketStatus.IN_PROGRESS);
    expect(recalled.json().ticket.lines[0].doneAt).toBeNull();
  });

  it('finishes a ticket when its last outstanding bowl is ticked off', async () => {
    const order = await openBill();
    await addLine(order.id, noodles);
    await addLine(order.id, noodles);
    await fire(order.id);
    const ticket = (await ticketsFor(order.id))[0] as KitchenTicketDto;
    expect(ticket.lines).toHaveLength(2);

    for (const line of ticket.lines) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/kitchen/lines/${line.id}/done`,
        headers: { cookie: staff.cookie },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }

    const finished = (await ticketsFor(order.id))[0] as KitchenTicketDto;
    expect(finished.status).toBe(TicketStatus.DONE);
  });

  it('clears a ticket whose last bowl was voided instead of cooked', async () => {
    // Nothing is coming. The card must not sit there going red for the rest of
    // service — and the cook has to be told to stop.
    const order = await openBill();
    const withLine = await addLine(order.id, noodles);
    const lineId = withLine.lines[0]?.id as string;
    await fire(order.id);

    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines/${lineId}/void`,
      headers: { cookie: staff.cookie },
      payload: {
        reason: 'ลูกค้าเปลี่ยนใจ',
        approverStaffId: manager.staffId,
        approverPin: SEED_PINS.MANAGER,
      },
    });

    const tickets = await ticketsFor(order.id);
    // CANCELLED tickets are off the board entirely.
    expect(tickets).toHaveLength(0);

    const row = await prisma.kitchenTicket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(row.status).toBe(TicketStatus.CANCELLED);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/kitchen/board' })).statusCode).toBe(401);
  });
});

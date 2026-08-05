/**
 * เปิดกะ ปิดกะ และนับเงินลิ้นชัก.
 *
 * Against the real database, because everything here is a question about which
 * rows fall inside a time window — and a mocked Prisma client would answer
 * whatever it was told to.
 *
 * The window is shared with every other test file hitting this branch, so this
 * one measures DIFFERENCES (before vs after its own bill) rather than absolute
 * totals wherever it can. Where it cannot, it opens the shift first and pays a
 * bill of a known amount immediately afterwards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PaymentMethod, Role, type MenuCategoryDto, type ShiftDto } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs, type TestSession } from '../../test-helpers.js';

let app: FastifyInstance;
let owner: TestSession;
let staff: TestSession;
let branchId: string;
let noodles: { id: string; priceSatang: number };

const createdOrderIds: string[] = [];
const createdExpenseIds: string[] = [];

/** Opens a bill, puts `qty` bowls on it, pays cash, and returns what was taken. */
async function sellForCash(qty: number): Promise<number> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);

  const opened = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: staff.cookie },
    payload: { id, channel: 'TAKEAWAY' },
  });
  expect(opened.statusCode).toBe(201);

  const withLine = await app.inject({
    method: 'POST',
    url: `/api/orders/${id}/lines`,
    headers: { cookie: staff.cookie },
    payload: { id: crypto.randomUUID(), menuItemId: noodles.id, qty },
  });
  expect(withLine.statusCode).toBe(201);
  const total: number = withLine.json().order.totalSatang;

  const paid = await app.inject({
    method: 'POST',
    url: `/api/orders/${id}/pay`,
    headers: { cookie: staff.cookie },
    payload: { method: PaymentMethod.CASH, receivedSatang: total },
  });
  expect(paid.statusCode).toBe(200);
  return total;
}

const openShift = (openingCashSatang: number, note?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/shifts/open',
    headers: { cookie: staff.cookie },
    payload: { openingCashSatang, ...(note ? { note } : {}) },
  });

const closeShift = (countedCashSatang: number, note?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/shifts/close',
    headers: { cookie: staff.cookie },
    payload: { countedCashSatang, ...(note ? { note } : {}) },
  });

const currentShift = async (): Promise<ShiftDto | null> =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/shifts/current',
      headers: { cookie: staff.cookie },
    })
  ).json().shift;

beforeAll(async () => {
  app = await buildTestApp();
  owner = await loginAs(app, Role.OWNER);
  staff = await loginAs(app, Role.STAFF);

  const branch = await prisma.branch.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  branchId = branch.id;

  const categories: MenuCategoryDto[] = (
    await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: staff.cookie } })
  ).json().categories;
  noodles = categories
    .flatMap((category) => category.items)
    .filter((i) => i.isAvailable)[0] as typeof noodles;
});

/** No test may inherit an open till from the one before it. */
beforeEach(async () => {
  await prisma.shift.deleteMany({ where: { branchId, closedAt: null } });
});

afterAll(async () => {
  await cleanupOrders(createdOrderIds);
  await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  const shifts = await prisma.shift.findMany({ where: { branchId }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: shifts.map((s) => s.id) } } });
  await prisma.shift.deleteMany({ where: { branchId } });
  await app.close();
  await prisma.$disconnect();
});

describe('opening the till', () => {
  it('records the float and starts the window', async () => {
    const response = await openShift(200_000, 'ตั้งเงินทอน 2000');
    expect(response.statusCode).toBe(201);

    const shift: ShiftDto = response.json().shift;
    expect(shift.openingCashSatang).toBe(200_000);
    expect(shift.closedAt).toBeNull();
    expect(shift.staffName).not.toBe('');
  });

  it('refuses a second one while the first is running', async () => {
    // Two overlapping windows would count the same ฿50 note twice.
    await openShift(200_000);
    const second = await openShift(100_000);

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('SHIFT_ALREADY_OPEN');
  });

  it('lets a new one open once the old one is closed', async () => {
    await openShift(200_000);
    await closeShift(200_000);
    expect((await openShift(50_000)).statusCode).toBe(201);
  });

  it('refuses a fat-fingered float instead of recording it', async () => {
    expect((await openShift(999_999_999)).statusCode).toBe(400);
  });
});

describe('what the open shift shows', () => {
  it('is null when nobody has opened the till', async () => {
    expect(await currentShift()).toBeNull();
  });

  it('counts a cash bill paid inside the window', async () => {
    await openShift(200_000);
    const before = await currentShift();
    const took = await sellForCash(2);
    const after = await currentShift();

    expect((after?.cashSalesSatang ?? 0) - (before?.cashSalesSatang ?? 0)).toBe(took);
    expect((after?.billCount ?? 0) - (before?.billCount ?? 0)).toBe(1);
  });

  it('does not count a bill paid BEFORE it was opened', async () => {
    // The cash is in the drawer and not in the expected figure, which reads as
    // "someone forgot to press เปิดกะ" — the truth, and better than back-dating.
    await sellForCash(1);
    await openShift(200_000);

    expect((await currentShift())?.cashSalesSatang).toBe(0);
  });

  it('hides the expected total while the shift is open', async () => {
    // A screen showing what the drawer SHOULD hold, next to the box for what it
    // DOES hold, is a screen that gets the expected number typed into it.
    await openShift(200_000);
    await sellForCash(1);
    const shift = await currentShift();

    expect(shift?.expectedCashSatang).toBeNull();
    expect(shift?.varianceSatang).toBeNull();
    expect(shift?.countedCashSatang).toBeNull();
  });
});

describe('closing and counting', () => {
  it('works the expected total out from the bills, and the variance from the count', async () => {
    await openShift(200_000);
    const took = await sellForCash(2);

    const expected = 200_000 + took;
    const response = await closeShift(expected);
    expect(response.statusCode).toBe(200);

    const shift: ShiftDto = response.json().shift;
    expect(shift.expectedCashSatang).toBe(expected);
    expect(shift.countedCashSatang).toBe(expected);
    expect(shift.varianceSatang).toBe(0);
    expect(shift.closedAt).not.toBeNull();
  });

  it('reports a short drawer as a negative variance', async () => {
    await openShift(200_000);
    const took = await sellForCash(1);

    const shift: ShiftDto = (await closeShift(200_000 + took - 5000)).json().shift;
    expect(shift.varianceSatang).toBe(-5000);
  });

  it('reports a long drawer as a positive one', async () => {
    await openShift(200_000);
    const took = await sellForCash(1);

    const shift: ShiftDto = (await closeShift(200_000 + took + 2000)).json().shift;
    expect(shift.varianceSatang).toBe(2000);
  });

  it('subtracts cash taken out of the drawer during the shift', async () => {
    await openShift(200_000);
    const took = await sellForCash(1);

    const expense = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      headers: { cookie: owner.cookie },
      payload: {
        date: new Date().toISOString().slice(0, 10),
        category: 'INGREDIENT',
        amountSatang: 50_000,
        paidBy: 'CASH',
        note: 'ซื้อผักตอนเที่ยง',
      },
    });
    expect(expense.statusCode).toBe(201);
    createdExpenseIds.push(
      ...(expense.json().expenses as { id: string; note: string | null }[])
        .filter((row) => row.note === 'ซื้อผักตอนเที่ยง')
        .map((row) => row.id),
    );

    // ฿500 to the market is not a missing ฿500 at closing time.
    const shift: ShiftDto = (await closeShift(200_000 + took - 50_000)).json().shift;
    expect(shift.cashOutSatang).toBe(50_000);
    expect(shift.expectedCashSatang).toBe(200_000 + took - 50_000);
    expect(shift.varianceSatang).toBe(0);
  });

  it('never lets PromptPay into the drawer figure', async () => {
    await openShift(0);

    const id = crypto.randomUUID();
    createdOrderIds.push(id);
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: staff.cookie },
      payload: { id, channel: 'TAKEAWAY' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/lines`,
      headers: { cookie: staff.cookie },
      payload: { id: crypto.randomUUID(), menuItemId: noodles.id, qty: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/pay`,
      headers: { cookie: staff.cookie },
      payload: { method: PaymentMethod.PROMPTPAY, referenceNo: '1234' },
    });

    // Counting it would guarantee a variance every day and train everyone to
    // ignore the number.
    const shift: ShiftDto = (await closeShift(0)).json().shift;
    expect(shift.transferSalesSatang).toBeGreaterThan(0);
    expect(shift.cashSalesSatang).toBe(0);
    expect(shift.varianceSatang).toBe(0);
  });

  it('says so rather than pretending when no shift is open', async () => {
    const response = await closeShift(200_000);
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('NO_OPEN_SHIFT');
  });

  it('cannot be closed twice — closed is closed', async () => {
    await openShift(200_000);
    expect((await closeShift(200_000)).statusCode).toBe(200);
    expect((await closeShift(999_00)).statusCode).toBe(404);
  });

  it('freezes the figures — a later sale does not move a closed shift', async () => {
    await openShift(200_000);
    const closed: ShiftDto = (await closeShift(200_000)).json().shift;

    await sellForCash(1);

    const again = await prisma.shift.findUniqueOrThrow({ where: { id: closed.id } });
    expect(again.expectedCashSatang).toBe(closed.expectedCashSatang);
    expect(again.varianceSatang).toBe(closed.varianceSatang);
  });

  it('writes the count and the gap into the audit log (rule #8)', async () => {
    await openShift(200_000);
    const closed: ShiftDto = (await closeShift(195_000)).json().shift;

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Shift', entityId: closed.id, action: 'CLOSE_SHIFT' },
    });
    expect(log.after).toMatchObject({ countedCashSatang: 195_000, varianceSatang: -5000 });
    expect(log.staffId).toBe(staff.staffId);
  });
});

describe('who may look', () => {
  it('keeps the history away from the people who work the till', async () => {
    // The variance starts a conversation about a missing ฿500, and that
    // conversation belongs to whoever is responsible for the shop.
    const response = await app.inject({
      method: 'GET',
      url: '/api/shifts',
      headers: { cookie: staff.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('shows the owner the closed shifts newest first', async () => {
    await openShift(200_000);
    await closeShift(200_000);

    const response = await app.inject({
      method: 'GET',
      url: '/api/shifts?limit=5',
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);

    const shifts: ShiftDto[] = response.json().shifts;
    expect(shifts.length).toBeGreaterThan(0);
    expect(shifts[0]?.closedAt).not.toBeNull();

    const times = shifts.map((shift) => Date.parse(shift.openedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('refuses a session-less request outright', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/shifts/current' })).statusCode).toBe(401);
  });
});

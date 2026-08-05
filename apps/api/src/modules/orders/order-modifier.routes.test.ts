/**
 * Options on a bill line (Step 3).
 *
 * These run against the real database because the things that break are the
 * things a mock would wave through: whether the price delta actually reaches
 * the stored total, whether a snapshot survives someone repricing "พิเศษ", and
 * whether the server refuses a combination the tablet should never have sent.
 *
 * The validation cases matter most. The tablet runs the same validateSelection
 * and will normally never send a bad set — which is exactly why the server has
 * to be tested directly, since nothing in ordinary use exercises this path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  defaultSelectionFor,
  minSelectOf,
  receiptTextPreview,
  Role,
  selectedModifiersOf,
  type MenuItemDto,
  type MenuResponse,
  type ModifierGroupDto,
  type OrderDto,
  type ReceiptDoc,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs } from '../../test-helpers.js';

let app: FastifyInstance;
let staffCookie: string;
let managerCookie: string;

let noodles: MenuItemDto;
let drink: MenuItemDto;
let noodleGroups: ModifierGroupDto[];
/** เส้น — required, exactly one. */
let singleGroup: ModifierGroupDto;
/** เพิ่มเติม — optional, several allowed. */
let multiGroup: ModifierGroupDto;

const createdOrderIds: string[] = [];

async function openBill(): Promise<OrderDto> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);
  const response = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: staffCookie },
    payload: { id, channel: 'TAKEAWAY' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

/** Raw inject so a test can assert on the failures too. */
function addLineRaw(orderId: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/lines`,
    headers: { cookie: staffCookie },
    payload: { id: crypto.randomUUID(), menuItemId: noodles.id, qty: 1, ...body },
  });
}

async function addLine(orderId: string, body: Record<string, unknown> = {}): Promise<OrderDto> {
  const response = await addLineRaw(orderId, body);
  expect(response.statusCode).toBe(201);
  return response.json().order;
}

beforeAll(async () => {
  app = await buildTestApp();
  staffCookie = (await loginAs(app, Role.STAFF)).cookie;
  managerCookie = (await loginAs(app, Role.MANAGER)).cookie;

  const menu: MenuResponse = (
    await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: staffCookie } })
  ).json();

  const items = menu.categories.flatMap((category) => category.items);
  noodles = items.find((item) => item.groupIds.length > 0 && item.isAvailable) as MenuItemDto;
  drink = items.find((item) => item.groupIds.length === 0 && item.isAvailable) as MenuItemDto;
  expect(noodles).toBeDefined();
  expect(drink).toBeDefined();

  const byId = new Map(menu.modifierGroups.map((group) => [group.id, group]));
  noodleGroups = noodles.groupIds
    .map((id) => byId.get(id))
    .filter((group): group is ModifierGroupDto => !!group);

  singleGroup = noodleGroups.find(
    (group) => minSelectOf(group) > 0 && group.maxSelect === 1,
  ) as ModifierGroupDto;
  multiGroup = noodleGroups.find((group) => group.maxSelect > 1) as ModifierGroupDto;
  expect(singleGroup).toBeDefined();
  expect(multiGroup).toBeDefined();
});

afterAll(async () => {
  await cleanupOrders(createdOrderIds);
  await app.close();
  await prisma.$disconnect();
});

describe('the menu ships its option groups', () => {
  it('sends groups once at the top level and items reference them by id', async () => {
    const menu: MenuResponse = (
      await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: staffCookie } })
    ).json();

    expect(menu.modifierGroups.length).toBeGreaterThan(0);
    // A bowl offers options; a drink offers none. That difference is the whole
    // reason the sheet can skip itself and keep a drink to one tap.
    expect(noodles.groupIds.length).toBeGreaterThan(0);
    expect(drink.groupIds).toEqual([]);

    const ids = new Set(menu.modifierGroups.map((group) => group.id));
    expect(noodles.groupIds.every((id) => ids.has(id))).toBe(true);
  });

  it('never sends a cost delta to a till', async () => {
    // Cost is a management figure. ModifierGroupDto has no field for it at all,
    // so this asserts the shape rather than a role check.
    const menu: MenuResponse = (
      await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: managerCookie } })
    ).json();
    const every = menu.modifierGroups.flatMap((group) => group.modifiers);
    expect(every.length).toBeGreaterThan(0);
    expect(every.every((modifier) => !('costDeltaSatang' in modifier))).toBe(true);
  });
});

describe('adding a line with options', () => {
  it('falls back to the shop defaults when no options are sent', async () => {
    // "the usual" — this is what keeps one bowl to a single round trip for a
    // caller that does not want to think about options.
    const order = await openBill();
    const withLine = await addLine(order.id);

    const expected = selectedModifiersOf(noodleGroups, defaultSelectionFor(noodleGroups));
    expect(withLine.lines[0]?.modifiers.map((m) => m.nameSnapshot)).toEqual(
      expected.map((m) => m.name),
    );
  });

  it('stores the chosen options in GROUP order, not the order they were sent', async () => {
    const order = await openBill();
    const noodle = singleGroup.modifiers[1] as { id: string; name: string };
    const extra = multiGroup.modifiers[0] as { id: string; name: string };

    // The other required groups keep their defaults; the extra is sent BEFORE
    // the noodle type on purpose, which is the thing under test.
    const withLine = await addLine(order.id, {
      modifierIds: [
        ...defaultSelectionFor(noodleGroups).filter((id) => !inGroup(singleGroup, id)),
        extra.id,
        noodle.id,
      ],
    });
    const names = withLine.lines[0]?.modifiers.map((m) => m.nameSnapshot) ?? [];

    // เส้น comes before เพิ่มเติม on the menu, so it comes first on the ticket
    // — a cook reading at 1.5m should not have to hunt for the noodle type.
    expect(names.indexOf(noodle.name)).toBeLessThan(names.indexOf(extra.name));
  });

  it('adds the price delta to the unit price and multiplies it by the quantity', async () => {
    const paid = noodleGroups
      .flatMap((group) => group.modifiers)
      .find((modifier) => modifier.priceDeltaSatang > 0) as {
      id: string;
      priceDeltaSatang: number;
    };
    expect(paid).toBeDefined();

    const order = await openBill();
    const selection = [...defaultSelectionFor(noodleGroups), paid.id];
    const withLine = await addLine(order.id, {
      qty: 2,
      modifierIds: dedupeGroups(selection, paid),
    });

    const line = withLine.lines[0];
    expect(line?.unitPriceSatang).toBe(noodles.priceSatang + paid.priceDeltaSatang);
    expect(line?.lineTotalSatang).toBe((noodles.priceSatang + paid.priceDeltaSatang) * 2);
    expect(withLine.totalSatang).toBe(line?.lineTotalSatang);
  });

  it('keeps the option snapshot when the option is repriced afterwards (rule #7)', async () => {
    const paid = noodleGroups
      .flatMap((group) => group.modifiers)
      .find((modifier) => modifier.priceDeltaSatang > 0) as {
      id: string;
      priceDeltaSatang: number;
    };

    const order = await openBill();
    const withLine = await addLine(order.id, {
      modifierIds: dedupeGroups([...defaultSelectionFor(noodleGroups), paid.id], paid),
    });
    const before = withLine.totalSatang;

    // Captured BEFORE the edit — reading it back afterwards would restore the
    // edited value, which is how an earlier version of this test quietly
    // renamed a seeded option to an empty string.
    const original = await prisma.modifier.findUniqueOrThrow({ where: { id: paid.id } });
    await prisma.modifier.update({
      where: { id: paid.id },
      data: {
        priceDeltaSatang: original.priceDeltaSatang + 2000,
        name: 'ชื่อใหม่ที่ไม่ควรย้อนหลัง',
      },
    });
    try {
      const reread = await app.inject({
        method: 'GET',
        url: `/api/orders/${order.id}`,
        headers: { cookie: staffCookie },
      });
      const after: OrderDto = reread.json().order;
      expect(after.totalSatang).toBe(before);
      expect(
        after.lines[0]?.modifiers.some((m) => m.nameSnapshot === 'ชื่อใหม่ที่ไม่ควรย้อนหลัง'),
      ).toBe(false);
    } finally {
      await prisma.modifier.update({
        where: { id: paid.id },
        data: { priceDeltaSatang: original.priceDeltaSatang, name: original.name },
      });
    }
  });

  it('adds the cost delta for a manager and shows nothing to a cashier', async () => {
    const costly = await prisma.modifier.findFirstOrThrow({
      where: { groupId: { in: noodleGroups.map((group) => group.id) }, costDeltaSatang: { gt: 0 } },
    });
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: noodles.id } });

    const order = await openBill();
    const staffView = await addLine(order.id, {
      modifierIds: dedupeGroups([...defaultSelectionFor(noodleGroups), costly.id], {
        id: costly.id,
      }),
    });
    expect(staffView.lines[0]?.unitCostSatang).toBeUndefined();

    const asManager = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { cookie: managerCookie },
    });
    const managerView: OrderDto = asManager.json().order;
    expect(managerView.lines[0]?.unitCostSatang).toBe(item.costSatang + costly.costDeltaSatang);
  });
});

describe('the server refuses an illegal bowl', () => {
  it('rejects an empty selection when a group is required', async () => {
    const order = await openBill();
    const response = await addLineRaw(order.id, { modifierIds: [] });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('TOO_FEW');
    expect(response.json().message).toContain(singleGroup.name);

    // And nothing was written — a rejected line must not leave half a bowl.
    const reread = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { cookie: staffCookie },
    });
    expect(reread.json().order.lines).toHaveLength(0);
  });

  it('rejects two choices in a single-select group', async () => {
    const order = await openBill();
    const both = singleGroup.modifiers.slice(0, 2).map((modifier) => modifier.id);
    const response = await addLineRaw(order.id, {
      modifierIds: [
        ...defaultSelectionFor(noodleGroups).filter((id) => !inGroup(singleGroup, id)),
        ...both,
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('TOO_MANY');
  });

  it('rejects an option that belongs to a different item', async () => {
    // The tampered-client case: a drink has no groups, so nothing is legal on it.
    const order = await openBill();
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/lines`,
      headers: { cookie: staffCookie },
      payload: {
        id: crypto.randomUUID(),
        menuItemId: drink.id,
        qty: 1,
        modifierIds: [singleGroup.modifiers[0]?.id],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('UNKNOWN_MODIFIER');
  });

  it('rejects the same option twice', async () => {
    const order = await openBill();
    const extra = multiGroup.modifiers[0]?.id as string;
    const response = await addLineRaw(order.id, {
      modifierIds: [...defaultSelectionFor(noodleGroups), extra, extra],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('DUPLICATE_MODIFIER');
  });

  it('rejects a sold-out option with a 409, the same as a sold-out dish', async () => {
    const soldOut = multiGroup.modifiers[0] as { id: string; name: string };
    await prisma.modifier.update({ where: { id: soldOut.id }, data: { isAvailable: false } });
    try {
      const order = await openBill();
      const response = await addLineRaw(order.id, {
        modifierIds: [...defaultSelectionFor(noodleGroups), soldOut.id],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('MODIFIER_UNAVAILABLE');
      expect(response.json().message).toContain(soldOut.name);
    } finally {
      await prisma.modifier.update({ where: { id: soldOut.id }, data: { isAvailable: true } });
    }
  });
});

describe('changing the options on a line', () => {
  it('replaces the set, re-prices the bill and records both sides in the audit log', async () => {
    const paid = noodleGroups
      .flatMap((group) => group.modifiers)
      .find((modifier) => modifier.priceDeltaSatang > 0) as {
      id: string;
      name: string;
      priceDeltaSatang: number;
    };

    const order = await openBill();
    const withLine = await addLine(order.id);
    const lineId = withLine.lines[0]?.id as string;
    expect(withLine.totalSatang).toBe(noodles.priceSatang);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staffCookie },
      payload: {
        qty: 1,
        modifierIds: dedupeGroups([...defaultSelectionFor(noodleGroups), paid.id], paid),
      },
    });

    expect(patched.statusCode).toBe(200);
    const after: OrderDto = patched.json().order;
    expect(after.totalSatang).toBe(noodles.priceSatang + paid.priceDeltaSatang);

    // Rule #8: the trail has to say what the bowl WAS, not just that it changed.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'OrderLine', entityId: lineId, action: 'EDIT_ORDER_LINE' },
    });
    const before = audit.before as { modifiers: string[] };
    const now = audit.after as { modifiers: string[] };
    expect(before.modifiers.length).toBeGreaterThan(0);
    // The chosen option is the difference — whether the COUNT moved depends on
    // whether it replaced a default in its own group, which is not the point.
    expect(before.modifiers).not.toContain(paid.name);
    expect(now.modifiers).toContain(paid.name);
    await prisma.auditLog.deleteMany({ where: { entityId: lineId } });
  });

  it('leaves the options alone when the patch only changes the quantity', async () => {
    const order = await openBill();
    const withLine = await addLine(order.id);
    const lineId = withLine.lines[0]?.id as string;
    const originals = withLine.lines[0]?.modifiers.map((m) => m.nameSnapshot);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      headers: { cookie: staffCookie },
      payload: { qty: 3 },
    });

    const after: OrderDto = patched.json().order;
    expect(after.lines[0]?.qty).toBe(3);
    expect(after.lines[0]?.modifiers.map((m) => m.nameSnapshot)).toEqual(originals);
    await prisma.auditLog.deleteMany({ where: { entityId: lineId } });
  });
});

describe('what the kitchen and the customer actually read', () => {
  it('prints the options under the item on the check slip', async () => {
    const paid = noodleGroups
      .flatMap((group) => group.modifiers)
      .find((modifier) => modifier.priceDeltaSatang > 0) as { id: string; name: string };

    const order = await openBill();
    await addLine(order.id, {
      modifierIds: dedupeGroups([...defaultSelectionFor(noodleGroups), paid.id], paid),
    });

    const queued = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/print-check`,
      headers: { cookie: staffCookie },
      payload: {},
    });
    expect(queued.statusCode).toBe(202);

    const job = await prisma.printJob.findUniqueOrThrow({ where: { id: queued.json().jobId } });
    const text = receiptTextPreview(job.payload as unknown as ReceiptDoc);

    // The name and the option share a slip, with the option indented under it.
    expect(text).toContain(noodles.name);
    expect(text).toContain(paid.name);
    expect(text).toContain('·');
  });
});

/* ------------------------------------------------------------------ */

function inGroup(group: ModifierGroupDto, modifierId: string): boolean {
  return group.modifiers.some((modifier) => modifier.id === modifierId);
}

/**
 * Adds one extra option to the defaults without breaking a single-select group.
 *
 * The defaults already fill every required group, so dropping the default from
 * whichever group the extra belongs to is what keeps the result legal —
 * otherwise "add พิเศษ" would silently mean "two sizes".
 */
function dedupeGroups(selection: readonly string[], extra: { id: string }): string[] {
  const owner = noodleGroups.find((group) => inGroup(group, extra.id));
  if (!owner || owner.maxSelect > 1) return [...new Set(selection)];
  const withoutOwner = selection.filter((id) => id === extra.id || !inGroup(owner, id));
  return [...new Set(withoutOwner)];
}

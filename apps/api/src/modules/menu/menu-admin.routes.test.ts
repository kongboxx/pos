/**
 * Managing the menu, and where cost comes from.
 *
 * Against the real database like the other route tests, because the two things
 * that matter here are both database-shaped: a cascade that has to reach every
 * dish using an ingredient, and a refusal that has to come from a foreign key
 * rather than from good intentions.
 *
 * NOTHING SEEDED IS EDITED. Every test builds its own category, ingredient and
 * dish and deletes them again — changing the price of the seeded pork would
 * move the costs another test file is asserting about while it runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Role, type MenuAdminResponse, type MenuResponse, type OrderDto } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs } from '../../test-helpers.js';

let app: FastifyInstance;
let manager: { staffId: string; cookie: string };
let staff: { staffId: string; cookie: string };
let branchId: string;

/** Everything this file creates, torn down in afterAll. */
const created = {
  categoryIds: [] as string[],
  ingredientIds: [] as string[],
  menuItemIds: [] as string[],
  groupIds: [] as string[],
  orderIds: [] as string[],
};

/**
 * A suffix unique to THIS RUN.
 *
 * The fixture names are unique per branch and the counter below restarts at 1
 * every run, so a run that dies before its afterAll leaves rows that make
 * every later run fail on a unique constraint — permanently, until somebody
 * deletes them by hand. That happened. The run id makes a crashed run leave
 * litter instead of a landmine.
 */
const RUN = Date.now().toString(36);

const NAME = {
  category: `หมวดทดสอบ Step 6 ${RUN}`,
  ingredient: `วัตถุดิบทดสอบ ${RUN}`,
  item: `เมนูทดสอบ ${RUN}`,
  group: `กลุ่มทดสอบ Step 6 ${RUN}`,
};

/**
 * The options object is built inline in both branches rather than assembled
 * and passed as a variable: `inject` is overloaded, and a spread-built literal
 * makes TypeScript pick the callback overload and lose `.statusCode`.
 */
async function manage<T = MenuAdminResponse>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET',
  url: string,
  payload?: object,
  cookie = manager.cookie,
): Promise<{ status: number; body: T }> {
  const response =
    payload === undefined
      ? await app.inject({ method, url: `/api${url}`, headers: { cookie } })
      : await app.inject({ method, url: `/api${url}`, headers: { cookie }, payload });
  return { status: response.statusCode, body: response.json() as T };
}

/**
 * A category with one subcategory, and an ingredient costing 10 satang a gram.
 *
 * Fresh ones per test, with a counter in the name: several of these tests
 * change what an ingredient costs, and sharing one between them would make the
 * cascade assertions depend on the order the tests happened to run in. Names
 * are unique per branch, so the counter is doing real work.
 */
let fixtureNo = 0;
async function makeFixtures(): Promise<{
  categoryId: string;
  ingredientId: string;
  ingredientName: string;
}> {
  fixtureNo += 1;
  const category = await prisma.menuCategory.create({
    data: {
      branchId,
      name: `${NAME.category} ${fixtureNo}`,
      subcategories: ['ทดสอบ'],
      sortOrder: 99,
    },
  });
  created.categoryIds.push(category.id);

  const ingredient = await prisma.ingredient.create({
    data: {
      branchId,
      name: `${NAME.ingredient} ${fixtureNo}`,
      baseUnit: 'กรัม',
      avgCostSatang: 10,
    },
  });
  created.ingredientIds.push(ingredient.id);

  return { categoryId: category.id, ingredientId: ingredient.id, ingredientName: ingredient.name };
}

async function makeItem(categoryId: string, name: string, priceSatang = 5000): Promise<string> {
  const { status, body } = await manage('POST', '/manage/menu-items', {
    categoryId,
    name,
    subcategory: 'ทดสอบ',
    priceSatang,
    station: 'ครัวทดสอบ',
  });
  expect(status).toBe(201);
  const item = findItem(body as unknown as { menu: MenuAdminResponse }, name);
  created.menuItemIds.push(item.id);
  return item.id;
}

function findItem(response: { menu: MenuAdminResponse }, name: string) {
  const item = response.menu.categories
    .flatMap((category) => category.items)
    .find((candidate) => candidate.name === name);
  if (!item) throw new Error(`menu item not found in response: ${name}`);
  return item;
}

beforeAll(async () => {
  app = await buildTestApp();
  manager = await loginAs(app, Role.MANAGER);
  staff = await loginAs(app, Role.STAFF);
  const branch = await prisma.branch.findFirstOrThrow({ where: { branchCode: 'HQ' } });
  branchId = branch.id;
});

afterAll(async () => {
  await cleanupOrders(created.orderIds);
  await prisma.recipeLine.deleteMany({
    where: {
      OR: [
        { menuItemId: { in: created.menuItemIds } },
        { branchId, ingredientId: { in: created.ingredientIds } },
      ],
    },
  });
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...created.menuItemIds, ...created.ingredientIds] } },
  });
  await prisma.menuItemGroup.deleteMany({ where: { menuItemId: { in: created.menuItemIds } } });
  await prisma.menuItem.deleteMany({ where: { id: { in: created.menuItemIds } } });
  await prisma.modifier.deleteMany({ where: { groupId: { in: created.groupIds } } });
  await prisma.modifierGroup.deleteMany({ where: { id: { in: created.groupIds } } });
  await prisma.ingredient.deleteMany({ where: { id: { in: created.ingredientIds } } });
  await prisma.menuCategory.deleteMany({ where: { id: { in: created.categoryIds } } });
  await app.close();
});

describe('who may manage the menu', () => {
  it('refuses a cashier', async () => {
    // The management view carries cost and margin for every dish. A STAFF
    // tablet must not be able to fetch it, not even read-only.
    const { status } = await manage('GET', '/manage/menu', undefined, staff.cookie);
    expect(status).toBe(403);
  });

  it('refuses a cashier trying to change a price directly', async () => {
    const { status } = await manage(
      'PUT',
      `/manage/menu-items/${crypto.randomUUID()}`,
      { categoryId: crypto.randomUUID(), name: 'x', priceSatang: 1 },
      staff.cookie,
    );
    expect(status).toBe(403);
  });

  it('lets a manager read the whole menu, switched-off rows included', async () => {
    const { status, body } = await manage('GET', '/manage/menu');
    expect(status).toBe(200);
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.ingredients.length).toBeGreaterThan(0);
    expect(body.stations).toContain('ครัวเส้น');
  });
});

describe('cost comes from the recipe', () => {
  it('computes a dish cost and says so, and admits when there is no recipe', async () => {
    const { categoryId, ingredientId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} สูตร`);

    const fresh = await manage<{ menu: MenuAdminResponse }>('GET', '/manage/menu');
    const before = findItem(
      { menu: fresh.body as unknown as MenuAdminResponse },
      `${NAME.item} สูตร`,
    );
    // A brand new dish has no recipe, and the screen must be able to say that
    // rather than showing a 0 that reads as "free".
    expect(before.hasRecipe).toBe(false);
    expect(before.costSatang).toBe(0);

    const saved = await manage<{ menu: MenuAdminResponse; recalculated: { menuItems: number } }>(
      'PUT',
      `/manage/menu-items/${itemId}/recipe`,
      { lines: [{ ingredientId, quantity: 120 }] },
    );
    expect(saved.status).toBe(200);

    const after = findItem(saved.body, `${NAME.item} สูตร`);
    expect(after.hasRecipe).toBe(true);
    expect(after.costSatang).toBe(1200); // 120 g x 10 satang
    expect(after.recipe[0]).toMatchObject({ quantity: 120, lineCostSatang: 1200 });
    expect(saved.body.recalculated.menuItems).toBe(1);
  });

  it('zeroes the cost when the last line is taken out of a recipe', async () => {
    const { categoryId, ingredientId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ล้างสูตร`);
    await manage('PUT', `/manage/menu-items/${itemId}/recipe`, {
      lines: [{ ingredientId, quantity: 50 }],
    });

    // Emptying a recipe is a deliberate act, so the cost goes with it — unlike
    // an item that never had one, which keeps whatever number it had.
    const cleared = await manage<{ menu: MenuAdminResponse }>(
      'PUT',
      `/manage/menu-items/${itemId}/recipe`,
      { lines: [] },
    );
    const item = findItem(cleared.body, `${NAME.item} ล้างสูตร`);
    expect(item.costSatang).toBe(0);
    expect(item.hasRecipe).toBe(false);
  });

  it('rewrites every dish using an ingredient when its price changes', async () => {
    const { categoryId, ingredientId, ingredientName } = await makeFixtures();
    const first = await makeItem(categoryId, `${NAME.item} ก`);
    const second = await makeItem(categoryId, `${NAME.item} ข`);
    const untouched = await makeItem(categoryId, `${NAME.item} ค`);
    await manage('PUT', `/manage/menu-items/${first}/recipe`, {
      lines: [{ ingredientId, quantity: 100 }],
    });
    await manage('PUT', `/manage/menu-items/${second}/recipe`, {
      lines: [{ ingredientId, quantity: 200 }],
    });

    const raised = await manage<{ menu: MenuAdminResponse; recalculated: { menuItems: number } }>(
      'PUT',
      `/manage/ingredients/${ingredientId}`,
      { name: ingredientName, baseUnit: 'กรัม', avgCostSatang: 15 },
    );

    expect(findItem(raised.body, `${NAME.item} ก`).costSatang).toBe(1500);
    expect(findItem(raised.body, `${NAME.item} ข`).costSatang).toBe(3000);
    // The count is dishes that MOVED, not dishes that were looked at — it is
    // shown to the owner as "แก้ต้นทุน N เมนู" and has to mean that.
    expect(raised.body.recalculated.menuItems).toBe(2);
    expect(findItem(raised.body, `${NAME.item} ค`).costSatang).toBe(0);
    expect(untouched).toBeTruthy();
  });

  it('leaves a sold line alone when the recipe changes underneath it (rule #7)', async () => {
    const { categoryId, ingredientId, ingredientName } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ขายแล้ว`, 6000);
    await manage('PUT', `/manage/menu-items/${itemId}/recipe`, {
      lines: [{ ingredientId, quantity: 100 }],
    });

    const orderId = crypto.randomUUID();
    created.orderIds.push(orderId);
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: manager.cookie },
      payload: { id: orderId, channel: 'TAKEAWAY' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/lines`,
      headers: { cookie: manager.cookie },
      payload: { id: crypto.randomUUID(), menuItemId: itemId, qty: 1 },
    });

    // Triple the ingredient AFTER the sale.
    await manage('PUT', `/manage/ingredients/${ingredientId}`, {
      name: ingredientName,
      baseUnit: 'กรัม',
      avgCostSatang: 30,
    });

    const reread = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: manager.cookie },
    });
    const order = reread.json().order as OrderDto;
    // Tonight's supplier price must not move this afternoon's profit.
    expect(order.lines[0]?.unitCostSatang).toBe(1000);
  });

  it('records who moved a price and what it was before', async () => {
    const { categoryId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ขึ้นราคา`, 5000);

    await manage('PUT', `/manage/menu-items/${itemId}`, {
      categoryId,
      name: `${NAME.item} ขึ้นราคา`,
      subcategory: 'ทดสอบ',
      priceSatang: 5500,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'MenuItem', entityId: itemId, action: 'CHANGE_PRICE' },
    });
    expect(entry.staffId).toBe(manager.staffId);
    expect(entry.before).toMatchObject({ priceSatang: 5000 });
    expect(entry.after).toMatchObject({ priceSatang: 5500 });
  });
});

describe('what a recipe will not accept', () => {
  it('refuses a negative quantity on a DISH', async () => {
    const { categoryId, ingredientId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ติดลบ`);
    const { status, body } = await manage<{ message: string }>(
      'PUT',
      `/manage/menu-items/${itemId}/recipe`,
      { lines: [{ ingredientId, quantity: -50 }] },
    );
    expect(status).toBe(400);
    expect(body.message).toContain('ติดลบ');
  });

  it('allows a negative quantity on an OPTION, because that is what a swap is', async () => {
    const { ingredientId } = await makeFixtures();
    const group = await prisma.modifierGroup.create({
      data: { branchId, name: NAME.group, sortOrder: 99 },
    });
    created.groupIds.push(group.id);
    const created$ = await manage<{ menu: MenuAdminResponse }>(
      'POST',
      `/manage/modifier-groups/${group.id}/modifiers`,
      { name: 'ตัวเลือกทดสอบ', priceDeltaSatang: 0 },
    );
    const modifier = created$.body.menu.modifierGroups
      .find((candidate) => candidate.id === group.id)
      ?.modifiers.find((candidate) => candidate.name === 'ตัวเลือกทดสอบ');
    expect(modifier).toBeDefined();

    const saved = await manage<{ menu: MenuAdminResponse }>(
      'PUT',
      `/manage/modifiers/${modifier?.id}/recipe`,
      { lines: [{ ingredientId, quantity: -40 }] },
    );
    expect(saved.status).toBe(200);
    const after = saved.body.menu.modifierGroups
      .find((candidate) => candidate.id === group.id)
      ?.modifiers.find((candidate) => candidate.name === 'ตัวเลือกทดสอบ');
    // The shop genuinely keeps 4 baht when this option is chosen.
    expect(after?.costDeltaSatang).toBe(-400);
  });

  it('refuses the same ingredient twice in one recipe', async () => {
    const { categoryId, ingredientId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ซ้ำ`);
    const { status } = await manage('PUT', `/manage/menu-items/${itemId}/recipe`, {
      lines: [
        { ingredientId, quantity: 10 },
        { ingredientId, quantity: 20 },
      ],
    });
    expect(status).toBe(400);
  });

  it('refuses a fifth decimal place the database cannot store', async () => {
    const { categoryId, ingredientId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ทศนิยม`);
    const { status } = await manage('PUT', `/manage/menu-items/${itemId}/recipe`, {
      lines: [{ ingredientId, quantity: 0.00001 }],
    });
    expect(status).toBe(400);
  });
});

describe('deleting, and refusing to', () => {
  it('deletes a dish that was never sold', async () => {
    const { categoryId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ลบได้`);
    const { status } = await manage('DELETE', `/manage/menu-items/${itemId}`);
    expect(status).toBe(200);
    expect(await prisma.menuItem.findUnique({ where: { id: itemId } })).toBeNull();
  });

  it('refuses to delete a dish that appears on a bill, and says what to do instead', async () => {
    const { categoryId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ห้ามลบ`);

    const orderId = crypto.randomUUID();
    created.orderIds.push(orderId);
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: manager.cookie },
      payload: { id: orderId, channel: 'TAKEAWAY' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/lines`,
      headers: { cookie: manager.cookie },
      payload: { id: crypto.randomUUID(), menuItemId: itemId, qty: 1 },
    });

    const { status, body } = await manage<{ message: string }>(
      'DELETE',
      `/manage/menu-items/${itemId}`,
    );
    expect(status).toBe(409);
    // "ลบไม่ได้" on its own is how people start editing the database by hand.
    expect(body.message).toContain('เลิกขาย');
  });

  it('refuses to delete an ingredient a recipe still uses', async () => {
    const { categoryId, ingredientId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} ใช้วัตถุดิบ`);
    await manage('PUT', `/manage/menu-items/${itemId}/recipe`, {
      lines: [{ ingredientId, quantity: 5 }],
    });

    const { status, body } = await manage<{ message: string }>(
      'DELETE',
      `/manage/ingredients/${ingredientId}`,
    );
    expect(status).toBe(409);
    expect(body.message).toContain('สูตร');
  });

  it('refuses to delete a category that still has dishes in it', async () => {
    const { categoryId } = await makeFixtures();
    await makeItem(categoryId, `${NAME.item} ในหมวด`);
    const { status } = await manage('DELETE', `/manage/categories/${categoryId}`);
    expect(status).toBe(409);
  });
});

describe('the guards that stop a menu going quietly wrong', () => {
  it('refuses a subcategory the category does not declare', async () => {
    const { categoryId } = await makeFixtures();
    const { status, body } = await manage<{ message: string }>('POST', '/manage/menu-items', {
      categoryId,
      name: `${NAME.item} หมวดย่อยผิด`,
      subcategory: 'ไม่มีจริง',
      priceSatang: 1000,
    });
    expect(status).toBe(400);
    expect(body.message).toContain('หมวดย่อย');
  });

  it('refuses a second dish with the same name', async () => {
    const { categoryId } = await makeFixtures();
    await makeItem(categoryId, `${NAME.item} ชื่อซ้ำ`);
    const { status, body } = await manage<{ message: string }>('POST', '/manage/menu-items', {
      categoryId,
      name: `${NAME.item} ชื่อซ้ำ`,
      priceSatang: 1000,
    });
    expect(status).toBe(409);
    expect(body.message).toContain('มีชื่อนี้อยู่แล้ว');
  });

  it('refuses to change a base unit while recipes still use it', async () => {
    const { categoryId, ingredientId, ingredientName } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} เปลี่ยนหน่วย`);
    await manage('PUT', `/manage/menu-items/${itemId}/recipe`, {
      lines: [{ ingredientId, quantity: 100 }],
    });

    // "120" meant grams this morning; renaming the unit to kilos would make
    // every dish using it a thousand times cheaper without changing a digit.
    const { status, body } = await manage<{ message: string }>(
      'PUT',
      `/manage/ingredients/${ingredientId}`,
      { name: ingredientName, baseUnit: 'กิโลกรัม', avgCostSatang: 10 },
    );
    expect(status).toBe(409);
    expect(body.message).toContain('หน่วย');
  });
});

describe('what the till sees', () => {
  it('hides a discontinued dish from the till but keeps it on the management screen', async () => {
    const { categoryId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} เลิกขาย`);

    await manage('PUT', `/manage/menu-items/${itemId}`, {
      categoryId,
      name: `${NAME.item} เลิกขาย`,
      subcategory: 'ทดสอบ',
      priceSatang: 5000,
      isActive: false,
    });

    const till = await app.inject({
      method: 'GET',
      url: '/api/menu',
      headers: { cookie: manager.cookie },
    });
    const menu = till.json() as MenuResponse;
    const onTill = menu.categories
      .flatMap((category) => category.items)
      .some((item) => item.id === itemId);
    expect(onTill).toBe(false);

    const admin = await manage('GET', '/manage/menu');
    expect(findItem({ menu: admin.body }, `${NAME.item} เลิกขาย`).isActive).toBe(false);
  });

  it('keeps a sold-out dish on the till, greyed out, so staff can answer', async () => {
    const { categoryId } = await makeFixtures();
    const itemId = await makeItem(categoryId, `${NAME.item} หมดวันนี้`);

    const { status } = await manage('PATCH', `/manage/menu-items/${itemId}/availability`, {
      isAvailable: false,
    });
    expect(status).toBe(200);

    const till = await app.inject({
      method: 'GET',
      url: '/api/menu',
      headers: { cookie: manager.cookie },
    });
    const item = (till.json() as MenuResponse).categories
      .flatMap((category) => category.items)
      .find((candidate) => candidate.id === itemId);
    expect(item?.isAvailable).toBe(false);
  });
});

/**
 * Arranging the menu.
 *
 * The order things appear in is not decoration: the first category is the tab
 * already open when a cashier reaches the till, and the first dish is the one
 * under their thumb. The trap this file guards is that two rows sharing a
 * sortOrder fall back to sorting by NAME — so a move that "worked" can still
 * leave the screen looking identical, and only a real reordering assertion
 * catches it.
 */
describe('the order things appear in', () => {
  /** Names in the order the API returns them, inside one category. */
  async function itemNames(categoryId: string): Promise<string[]> {
    const { body } = await manage('GET', '/manage/menu');
    return (
      body.categories.find((category) => category.id === categoryId)?.items.map((i) => i.name) ?? []
    );
  }

  it('puts a new dish at the bottom of its category, whatever its name', async () => {
    const { categoryId } = await makeFixtures();
    // Deliberately alphabetical-descending: sorted by name these come back
    // the other way round, which is exactly the bug.
    await makeItem(categoryId, `${NAME.item} เรียง ฮ`);
    await makeItem(categoryId, `${NAME.item} เรียง ก`);

    expect(await itemNames(categoryId)).toEqual([`${NAME.item} เรียง ฮ`, `${NAME.item} เรียง ก`]);
  });

  it('swaps a dish with its neighbour and renumbers the rest', async () => {
    const { categoryId } = await makeFixtures();
    const first = await makeItem(categoryId, `${NAME.item} หนึ่ง`);
    await makeItem(categoryId, `${NAME.item} สอง`);
    const third = await makeItem(categoryId, `${NAME.item} สาม`);

    const { status } = await manage('POST', `/manage/menu-items/${third}/move`, {
      direction: 'UP',
    });
    expect(status).toBe(200);
    expect(await itemNames(categoryId)).toEqual([
      `${NAME.item} หนึ่ง`,
      `${NAME.item} สาม`,
      `${NAME.item} สอง`,
    ]);

    // And every row now holds a distinct number, so the next move is not a
    // tie broken by the alphabet.
    const rows = await prisma.menuItem.findMany({
      where: { categoryId },
      select: { sortOrder: true },
    });
    expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(3);
    expect(first).toBeTruthy();
  });

  it('answers with the menu unchanged when there is nowhere left to go', async () => {
    // Pressing ↑ on the first row is a finger landing on a disabled button,
    // not an error worth a red box.
    const { categoryId } = await makeFixtures();
    const first = await makeItem(categoryId, `${NAME.item} บนสุด`);
    await makeItem(categoryId, `${NAME.item} ล่างสุด`);

    const { status } = await manage('POST', `/manage/menu-items/${first}/move`, {
      direction: 'UP',
    });
    expect(status).toBe(200);
    expect(await itemNames(categoryId)).toEqual([`${NAME.item} บนสุด`, `${NAME.item} ล่างสุด`]);
  });

  it('never moves a dish past the edge of its own category', async () => {
    const a = await makeFixtures();
    const b = await makeFixtures();
    const alone = await makeItem(a.categoryId, `${NAME.item} เดี่ยว`);
    await makeItem(b.categoryId, `${NAME.item} หมวดอื่น`);

    await manage('POST', `/manage/menu-items/${alone}/move`, { direction: 'DOWN' });

    expect(await itemNames(a.categoryId)).toEqual([`${NAME.item} เดี่ยว`]);
    expect(await itemNames(b.categoryId)).toEqual([`${NAME.item} หมวดอื่น`]);
  });

  it('sends a dish to the bottom when it is moved to another category', async () => {
    const a = await makeFixtures();
    const b = await makeFixtures();
    await makeItem(b.categoryId, `${NAME.item} อยู่ก่อน`);
    const moved = await makeItem(a.categoryId, `${NAME.item} ย้ายมา`);

    const { status } = await manage('PUT', `/manage/menu-items/${moved}`, {
      categoryId: b.categoryId,
      name: `${NAME.item} ย้ายมา`,
      priceSatang: 5000,
    });
    expect(status).toBe(200);
    expect(await itemNames(b.categoryId)).toEqual([`${NAME.item} อยู่ก่อน`, `${NAME.item} ย้ายมา`]);
  });

  it('renaming a dish leaves it exactly where it was', async () => {
    const { categoryId } = await makeFixtures();
    await makeItem(categoryId, `${NAME.item} หัว`);
    const second = await makeItem(categoryId, `${NAME.item} ท้าย`);

    await manage('PUT', `/manage/menu-items/${second}`, {
      categoryId,
      name: `${NAME.item} ก ท้าย`,
      priceSatang: 5000,
    });
    expect(await itemNames(categoryId)).toEqual([`${NAME.item} หัว`, `${NAME.item} ก ท้าย`]);
  });

  it('moves a category, and a rename does not move it', async () => {
    // Categories share one list across the whole branch, so this test works
    // with the two it creates rather than asserting on the whole menu.
    const first = await prisma.menuCategory.create({
      data: { branchId, name: `${NAME.category} เรียง A ${RUN}`, sortOrder: 500 },
    });
    const second = await prisma.menuCategory.create({
      data: { branchId, name: `${NAME.category} เรียง B ${RUN}`, sortOrder: 501 },
    });
    created.categoryIds.push(first.id, second.id);

    const order = async (): Promise<string[]> => {
      const { body } = await manage('GET', '/manage/menu');
      return body.categories
        .filter((category) => [first.id, second.id].includes(category.id))
        .map((category) => category.id);
    };

    expect(await order()).toEqual([first.id, second.id]);

    const { status } = await manage('POST', `/manage/categories/${second.id}/move`, {
      direction: 'UP',
    });
    expect(status).toBe(200);
    expect(await order()).toEqual([second.id, first.id]);

    await manage('PUT', `/manage/categories/${second.id}`, {
      name: `${NAME.category} เรียง Z ${RUN}`,
      subcategories: [],
    });
    expect(await order()).toEqual([second.id, first.id]);
  });
});

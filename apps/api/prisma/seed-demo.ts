/**
 * The DEMO shop: `pnpm db:seed:demo`.
 *
 * One branch that looks like a real noodle shop on opening day — 3 staff with
 * the 3 roles, 12 tables across 3 zones, a menu with working option groups,
 * ingredients with recipes, and a few fixed costs. This is what to run to click
 * around the app, and it is what the API tests need: they are integration tests
 * against this database and they look for a dish with no options, a dish with a
 * recipe cost, an option with a cost delta, and PINs 1111/2222/3333.
 *
 * A REAL shop runs `pnpm db:seed` instead, which creates nothing but the branch
 * and its owner. See prisma/seed.ts for why seeding somebody else's menu into a
 * shop that has to sell from it is a bad idea.
 *
 * Deliberately does NOT create orders. A fake bill in the database would make
 * the first real closing report wrong.
 *
 * Idempotent: safe to run repeatedly. Everything is keyed on natural unique
 * fields (branchCode, names) via upsert.
 */

import { PrismaClient } from '@prisma/client';
import { ExpenseCategory } from '@pos/shared';
import { recalculateCosts } from '../src/modules/menu/recipe.service.js';
import { newQrToken } from '../src/modules/qr/qr-token.js';
import { seedDocSequences, upsertBranch, upsertStaff, type StaffSeed } from './seed-core.js';

const prisma = new PrismaClient();

const BRANCH_CODE = 'HQ';

async function main(): Promise<void> {
  console.log('Seeding the demo shop…');

  const branch = await seedBranch();
  await seedStaff(branch.id);
  await seedTables(branch.id);
  const ingredients = await seedIngredients(branch.id);
  const groups = await seedModifierGroups(branch.id, ingredients);
  await seedMenu(branch.id, groups, ingredients);
  await seedDocSequences(prisma, branch.id);
  await seedExpenses(branch.id);

  // Step 6: cost is not seeded, it is computed. Every costSatang above was
  // left at 0 and every costDeltaSatang at whatever the create put there —
  // this is the pass that makes them agree with the recipes, using the exact
  // function the management screen calls.
  const recalculated = await recalculateCosts(prisma, branch.id, { all: true });
  console.log(
    `  costs from recipes: ${recalculated.menuItems} items / ${recalculated.modifiers} options`,
  );

  console.log('\nDone.');
  console.log(`Branch: ${branch.name} (${branch.branchCode})`);
  console.log('PINs — OWNER 1111 / MANAGER 2222 / STAFF 3333 (dev only)');
}

/* ------------------------------------------------------------------ */

async function seedBranch() {
  const branch = await upsertBranch(prisma, {
    name: 'ร้านก๋วยเตี๋ยว สาขาหลัก',
    branchCode: BRANCH_CODE,
    address: '123 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพฯ 10000',
    phone: '02-000-0000',
    rentPerMonthSatang: 2_500_000, // 25,000.00 THB
    // Placeholder mobile number so the PromptPay QR can be exercised in dev.
    // The REAL seed leaves this null — a shipped default here would be a
    // stranger's phone number collecting a shop's takings.
    promptPayId: '0812345678',
  });

  // upsertBranch never updates, which keeps an owner's settings safe but also
  // means a database seeded before a column existed never gets it. Filled in
  // here, and only while still empty.
  if (branch.promptPayId === null) {
    return prisma.branch.update({
      where: { id: branch.id },
      data: { promptPayId: '0812345678' },
    });
  }
  return branch;
}

async function seedStaff(branchId: string): Promise<void> {
  const people: StaffSeed[] = [
    {
      fullName: 'สมชาย เจ้าของร้าน',
      nickname: 'พี่ชาย',
      position: 'เจ้าของ',
      role: 'OWNER',
      pin: '1111',
      wageType: 'MONTHLY',
      wageRateSatang: 0,
      nationality: 'TH',
      startDate: new Date('2026-07-01'),
    },
    {
      fullName: 'สมหญิง ผู้จัดการ',
      nickname: 'พี่หญิง',
      position: 'ผู้จัดการร้าน',
      role: 'MANAGER',
      pin: '2222',
      wageType: 'MONTHLY',
      wageRateSatang: 2_000_000, // 20,000.00 / month
      nationality: 'TH',
      startDate: new Date('2026-07-01'),
    },
    {
      fullName: 'Aung Min',
      nickname: 'อ่อง',
      position: 'ผู้ช่วยครัว',
      role: 'STAFF',
      pin: '3333',
      wageType: 'DAILY',
      wageRateSatang: 45_000, // 450.00 / day
      // Foreign worker: documents + expiry so Step 9 can warn 90 days ahead.
      nationality: 'FOREIGN',
      startDate: new Date('2026-07-01'),
      passportNo: 'MM1234567',
      passportExpiry: new Date('2029-05-31'),
      workPermitNo: 'WP-2026-00891',
      workPermitExpiry: new Date('2027-03-15'),
    },
  ];

  for (const person of people) {
    // The dev PINs are reset on every run on purpose: 1111/2222/3333 always
    // working is the whole point of the demo database, and the API tests log
    // in with them.
    await upsertStaff(prisma, branchId, person, { overwrite: true });
  }
  console.log(`  staff: ${people.length}`);
}

async function seedTables(branchId: string): Promise<void> {
  const layout = [
    { zone: 'ในร้าน', names: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], seats: 4 },
    { zone: 'หน้าร้าน', names: ['B1', 'B2', 'B3', 'B4'], seats: 2 },
    { zone: 'ห้องแอร์', names: ['C1', 'C2'], seats: 6 },
  ];

  let sortOrder = 0;
  for (const { zone, names, seats } of layout) {
    for (const name of names) {
      await prisma.diningTable.upsert({
        where: { branchId_name: { branchId, name } },
        // qrToken is created ONCE and never touched by a re-seed. It is
        // printed on a sticker on the furniture; rewriting it here would
        // silently kill every QR code in the shop the next time anyone runs
        // the seed to fix something unrelated.
        update: { zone, seats, sortOrder },
        create: { branchId, name, zone, seats, sortOrder, qrToken: newQrToken() },
      });
      sortOrder += 1;
    }
  }
  console.log(`  tables: ${sortOrder}`);
}

type IngredientMap = Record<string, string>;

async function seedIngredients(branchId: string): Promise<IngredientMap> {
  // avgCostSatang is the cost of ONE baseUnit. Units are chosen small enough
  // (gram, ml, piece) that an integer satang cost is still precise.
  const rows = [
    { name: 'เส้นเล็ก', baseUnit: 'กรัม', avgCostSatang: 3, shelfLifeDays: 2 },
    { name: 'เส้นใหญ่', baseUnit: 'กรัม', avgCostSatang: 3, shelfLifeDays: 2 },
    { name: 'บะหมี่', baseUnit: 'กรัม', avgCostSatang: 4, shelfLifeDays: 3 },
    { name: 'วุ้นเส้น', baseUnit: 'กรัม', avgCostSatang: 5, shelfLifeDays: 30 },
    { name: 'หมูสับ', baseUnit: 'กรัม', avgCostSatang: 18, shelfLifeDays: 2 },
    { name: 'หมูชิ้น', baseUnit: 'กรัม', avgCostSatang: 20, shelfLifeDays: 2 },
    { name: 'ลูกชิ้นหมู', baseUnit: 'ชิ้น', avgCostSatang: 250, shelfLifeDays: 7 },
    { name: 'เนื้อวัว', baseUnit: 'กรัม', avgCostSatang: 32, shelfLifeDays: 2 },
    { name: 'ผักบุ้ง', baseUnit: 'กรัม', avgCostSatang: 4, shelfLifeDays: 2 },
    { name: 'ถั่วงอก', baseUnit: 'กรัม', avgCostSatang: 3, shelfLifeDays: 2 },
    { name: 'น้ำซุปกระดูกหมู', baseUnit: 'มิลลิลิตร', avgCostSatang: 2, shelfLifeDays: 2 },
    { name: 'น้ำตก (เลือดหมู)', baseUnit: 'มิลลิลิตร', avgCostSatang: 6, shelfLifeDays: 1 },
    { name: 'น้ำต้มยำ', baseUnit: 'มิลลิลิตร', avgCostSatang: 3, shelfLifeDays: 2 },
    { name: 'เกี๊ยว', baseUnit: 'ชิ้น', avgCostSatang: 300, shelfLifeDays: 5 },
    { name: 'ไข่ไก่', baseUnit: 'ฟอง', avgCostSatang: 500, shelfLifeDays: 14 },
    { name: 'น้ำแข็ง', baseUnit: 'กรัม', avgCostSatang: 1, shelfLifeDays: 1 },
    { name: 'น้ำเปล่าขวด', baseUnit: 'ขวด', avgCostSatang: 500, shelfLifeDays: 365 },
  ];

  const map: IngredientMap = {};
  for (const row of rows) {
    const ingredient = await prisma.ingredient.upsert({
      where: { branchId_name: { branchId, name: row.name } },
      update: { avgCostSatang: row.avgCostSatang, baseUnit: row.baseUnit },
      create: { branchId, ...row },
    });
    map[row.name] = ingredient.id;
  }
  console.log(`  ingredients: ${rows.length}`);
  return map;
}

type GroupMap = Record<string, string>;

/**
 * Option groups, with a recipe per option instead of a typed-in cost.
 *
 * An option's recipe is a DIFFERENCE against the base bowl, which is why the
 * quantities may be negative: "บะหมี่" takes the 120 g of เส้นเล็ก back out and
 * puts 120 g of บะหมี่ in, so it costs the gap and not a whole new portion.
 * Nothing here sets costDeltaSatang — recalculateCosts() does that at the end
 * of the seed, using the same function the management screen calls.
 *
 * KNOWN LIMIT, and the reason "พิเศษ" only adds noodles and soup: an option is
 * shared by every dish that offers the group, so its recipe can only name
 * ingredients every one of those dishes actually has. Adding 25 g of หมูชิ้น
 * here would put pork into a bowl of ก๋วยเตี๋ยวเนื้อ.
 */
async function seedModifierGroups(branchId: string, ingredients: IngredientMap): Promise<GroupMap> {
  const definitions = [
    {
      name: 'เส้น',
      isRequired: true,
      minSelect: 1,
      maxSelect: 1,
      isNegative: false,
      sortOrder: 1,
      // The most-ordered choice is the default so one bowl is one tap. It is
      // also the one already in the base recipe, so it costs nothing extra.
      modifiers: [
        { name: 'เส้นเล็ก', priceDeltaSatang: 0, isDefault: true, recipe: [] },
        {
          name: 'เส้นใหญ่',
          priceDeltaSatang: 0,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: -120 },
            { ingredient: 'เส้นใหญ่', quantity: 120 },
          ],
        },
        {
          name: 'บะหมี่',
          priceDeltaSatang: 0,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: -120 },
            { ingredient: 'บะหมี่', quantity: 120 },
          ],
        },
        {
          name: 'วุ้นเส้น',
          priceDeltaSatang: 500,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: -120 },
            { ingredient: 'วุ้นเส้น', quantity: 120 },
          ],
        },
        {
          name: 'เกาเหลา (ไม่เอาเส้น)',
          priceDeltaSatang: 0,
          // Nothing replaces the noodles, so the shop genuinely keeps the 3.60.
          recipe: [{ ingredient: 'เส้นเล็ก', quantity: -120 }],
        },
      ],
    },
    {
      name: 'น้ำซุป',
      isRequired: true,
      minSelect: 1,
      maxSelect: 1,
      isNegative: false,
      sortOrder: 2,
      modifiers: [
        { name: 'น้ำใส', priceDeltaSatang: 0, isDefault: true, recipe: [] },
        {
          name: 'น้ำตก',
          priceDeltaSatang: 0,
          recipe: [{ ingredient: 'น้ำตก (เลือดหมู)', quantity: 30 }],
        },
        {
          name: 'ต้มยำ',
          priceDeltaSatang: 0,
          recipe: [
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: -300 },
            { ingredient: 'น้ำต้มยำ', quantity: 300 },
          ],
        },
        {
          name: 'แห้ง',
          priceDeltaSatang: 0,
          // Still gets a small bowl of soup on the side, so only most of it goes.
          recipe: [{ ingredient: 'น้ำซุปกระดูกหมู', quantity: -200 }],
        },
      ],
    },
    {
      name: 'ขนาด',
      isRequired: true,
      minSelect: 1,
      maxSelect: 1,
      isNegative: false,
      sortOrder: 3,
      modifiers: [
        { name: 'ธรรมดา', priceDeltaSatang: 0, isDefault: true, recipe: [] },
        {
          name: 'พิเศษ',
          priceDeltaSatang: 1000,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: 60 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 100 },
          ],
        },
      ],
    },
    {
      name: 'เพิ่มเติม',
      isRequired: false,
      minSelect: 0,
      maxSelect: 5,
      isNegative: false,
      sortOrder: 4,
      modifiers: [
        {
          name: 'เพิ่มลูกชิ้น',
          priceDeltaSatang: 1000,
          recipe: [{ ingredient: 'ลูกชิ้นหมู', quantity: 2 }],
        },
        {
          name: 'เพิ่มหมู',
          priceDeltaSatang: 1500,
          recipe: [{ ingredient: 'หมูชิ้น', quantity: 35 }],
        },
        {
          name: 'เพิ่มเกี๊ยว',
          priceDeltaSatang: 1000,
          recipe: [{ ingredient: 'เกี๊ยว', quantity: 2 }],
        },
        { name: 'ไข่ต้ม', priceDeltaSatang: 1000, recipe: [{ ingredient: 'ไข่ไก่', quantity: 1 }] },
      ],
    },
    {
      name: 'ไม่ใส่',
      isRequired: false,
      minSelect: 0,
      maxSelect: 5,
      // A removal group: the kitchen ticket prints these in a warning colour.
      isNegative: true,
      sortOrder: 5,
      modifiers: [
        { name: 'ไม่ผัก', priceDeltaSatang: 0, recipe: [{ ingredient: 'ผักบุ้ง', quantity: -30 }] },
        {
          name: 'ไม่ถั่วงอก',
          priceDeltaSatang: 0,
          recipe: [{ ingredient: 'ถั่วงอก', quantity: -20 }],
        },
        // Seasoning is not tracked as an ingredient, so these genuinely save
        // nothing measurable — an empty recipe rather than a made-up number.
        { name: 'ไม่ผงชูรส', priceDeltaSatang: 0, recipe: [] },
        { name: 'ไม่เผ็ด', priceDeltaSatang: 0, recipe: [] },
      ],
    },
  ];

  const map: GroupMap = {};
  for (const def of definitions) {
    const group = await prisma.modifierGroup.upsert({
      where: { branchId_name: { branchId, name: def.name } },
      update: {
        isRequired: def.isRequired,
        minSelect: def.minSelect,
        maxSelect: def.maxSelect,
        isNegative: def.isNegative,
        sortOrder: def.sortOrder,
      },
      create: {
        branchId,
        name: def.name,
        isRequired: def.isRequired,
        minSelect: def.minSelect,
        maxSelect: def.maxSelect,
        isNegative: def.isNegative,
        sortOrder: def.sortOrder,
      },
    });
    map[def.name] = group.id;

    let sortOrder = 0;
    for (const definition of def.modifiers) {
      // costDeltaSatang is never written here — see the recalculateCosts pass
      // at the end of main(). A number typed in this file would be a second
      // answer to a question the recipe already answers.
      const modifier = await prisma.modifier.upsert({
        where: { groupId_name: { groupId: group.id, name: definition.name } },
        update: {
          priceDeltaSatang: definition.priceDeltaSatang,
          isDefault: definition.isDefault ?? false,
          sortOrder,
        },
        create: {
          branchId,
          groupId: group.id,
          name: definition.name,
          priceDeltaSatang: definition.priceDeltaSatang,
          isDefault: definition.isDefault ?? false,
          sortOrder,
        },
      });
      sortOrder += 1;

      // Replaced wholesale so re-running the seed cannot double a recipe.
      await prisma.recipeLine.deleteMany({ where: { modifierId: modifier.id } });
      for (const line of definition.recipe) {
        const ingredientId = ingredients[line.ingredient];
        if (!ingredientId) continue;
        await prisma.recipeLine.create({
          data: { branchId, modifierId: modifier.id, ingredientId, quantity: line.quantity },
        });
      }
    }
  }
  console.log(`  modifier groups: ${definitions.length}`);
  return map;
}

async function seedMenu(
  branchId: string,
  groups: GroupMap,
  ingredients: IngredientMap,
): Promise<void> {
  const categories = [
    {
      name: 'ก๋วยเตี๋ยว',
      icon: '🍜',
      sortOrder: 1,
      subcategories: ['หมู', 'เนื้อ', 'เกี๊ยว'],
      // Every noodle bowl offers the full option set.
      groupNames: ['เส้น', 'น้ำซุป', 'ขนาด', 'เพิ่มเติม', 'ไม่ใส่'],
      station: 'ครัวเส้น',
      items: [
        {
          name: 'ก๋วยเตี๋ยวหมู',
          subcategory: 'หมู',
          priceSatang: 5000,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: 120 },
            { ingredient: 'หมูชิ้น', quantity: 50 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 300 },
            { ingredient: 'ผักบุ้ง', quantity: 30 },
            { ingredient: 'ถั่วงอก', quantity: 20 },
          ],
        },
        {
          name: 'ก๋วยเตี๋ยวหมูสับ',
          subcategory: 'หมู',
          priceSatang: 5000,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: 120 },
            { ingredient: 'หมูสับ', quantity: 60 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 300 },
            { ingredient: 'ผักบุ้ง', quantity: 30 },
          ],
        },
        {
          name: 'ก๋วยเตี๋ยวลูกชิ้น',
          subcategory: 'หมู',
          priceSatang: 5000,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: 120 },
            { ingredient: 'ลูกชิ้นหมู', quantity: 4 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 300 },
            { ingredient: 'ถั่วงอก', quantity: 20 },
          ],
        },
        {
          name: 'ก๋วยเตี๋ยวเนื้อ',
          subcategory: 'เนื้อ',
          priceSatang: 6000,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: 120 },
            { ingredient: 'เนื้อวัว', quantity: 60 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 300 },
            { ingredient: 'ผักบุ้ง', quantity: 30 },
          ],
        },
        {
          name: 'ก๋วยเตี๋ยวเกี๊ยว',
          subcategory: 'เกี๊ยว',
          priceSatang: 5500,
          recipe: [
            { ingredient: 'บะหมี่', quantity: 120 },
            { ingredient: 'เกี๊ยว', quantity: 5 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 300 },
          ],
        },
        {
          name: 'ก๋วยเตี๋ยวรวมมิตร',
          subcategory: 'หมู',
          priceSatang: 7000,
          recipe: [
            { ingredient: 'เส้นเล็ก', quantity: 120 },
            { ingredient: 'หมูชิ้น', quantity: 40 },
            { ingredient: 'หมูสับ', quantity: 30 },
            { ingredient: 'ลูกชิ้นหมู', quantity: 3 },
            { ingredient: 'น้ำซุปกระดูกหมู', quantity: 300 },
          ],
        },
      ],
    },
    {
      name: 'ของทานเล่น',
      icon: '🥟',
      sortOrder: 2,
      subcategories: ['ทอด', 'นึ่ง'],
      groupNames: ['ขนาด'],
      station: 'ครัวทอด',
      items: [
        {
          name: 'เกี๊ยวทอด',
          subcategory: 'ทอด',
          priceSatang: 4000,
          recipe: [{ ingredient: 'เกี๊ยว', quantity: 8 }],
        },
        {
          name: 'ลูกชิ้นทอด',
          subcategory: 'ทอด',
          priceSatang: 4000,
          recipe: [{ ingredient: 'ลูกชิ้นหมู', quantity: 6 }],
        },
      ],
    },
    {
      name: 'เครื่องดื่ม',
      icon: '🥤',
      sortOrder: 3,
      subcategories: ['เย็น', 'ร้อน'],
      // Drinks have no noodle options — this is the point of MenuItemGroup.
      groupNames: [],
      station: 'เครื่องดื่ม',
      items: [
        {
          name: 'น้ำเปล่า',
          subcategory: 'เย็น',
          priceSatang: 1000,
          recipe: [{ ingredient: 'น้ำเปล่าขวด', quantity: 1 }],
        },
        { name: 'น้ำอัดลม', subcategory: 'เย็น', priceSatang: 2000, recipe: [] },
        {
          name: 'ชาดำเย็น',
          subcategory: 'เย็น',
          priceSatang: 2500,
          recipe: [{ ingredient: 'น้ำแข็ง', quantity: 200 }],
        },
      ],
    },
  ];

  let itemCount = 0;
  for (const category of categories) {
    const menuCategory = await prisma.menuCategory.upsert({
      where: { branchId_name: { branchId, name: category.name } },
      update: {
        icon: category.icon,
        sortOrder: category.sortOrder,
        subcategories: category.subcategories,
      },
      create: {
        branchId,
        name: category.name,
        icon: category.icon,
        sortOrder: category.sortOrder,
        subcategories: category.subcategories,
      },
    });

    let sortOrder = 0;
    for (const item of category.items) {
      // costSatang stays 0 here: Step 6 computes it from the recipe below.
      // Filling it in by hand now would create two sources of truth.
      const menuItem = await prisma.menuItem.upsert({
        where: { branchId_name: { branchId, name: item.name } },
        update: {
          categoryId: menuCategory.id,
          subcategory: item.subcategory,
          priceSatang: item.priceSatang,
          station: category.station,
          sortOrder,
        },
        create: {
          branchId,
          categoryId: menuCategory.id,
          subcategory: item.subcategory,
          name: item.name,
          priceSatang: item.priceSatang,
          costSatang: 0,
          station: category.station,
          sortOrder,
        },
      });
      sortOrder += 1;
      itemCount += 1;

      for (const [index, groupName] of category.groupNames.entries()) {
        const groupId = groups[groupName];
        if (!groupId) continue;
        await prisma.menuItemGroup.upsert({
          where: { menuItemId_groupId: { menuItemId: menuItem.id, groupId } },
          update: { sortOrder: index },
          create: { branchId, menuItemId: menuItem.id, groupId, sortOrder: index },
        });
      }

      // Recipes are replaced wholesale so re-running the seed cannot double them.
      await prisma.recipeLine.deleteMany({ where: { menuItemId: menuItem.id } });
      for (const line of item.recipe) {
        const ingredientId = ingredients[line.ingredient];
        if (!ingredientId) continue;
        await prisma.recipeLine.create({
          data: { branchId, menuItemId: menuItem.id, ingredientId, quantity: line.quantity },
        });
      }
    }
  }
  console.log(`  menu: ${categories.length} categories / ${itemCount} items`);
}

async function seedExpenses(branchId: string): Promise<void> {
  // A couple of realistic fixed costs so the break-even screen has something to
  // work with on a fresh install.
  //
  // `category` is the ExpenseCategory KEY, not the Thai label it is displayed
  // as. Step 8 keys the FIXED/VARIABLE split and the "was rent recorded this
  // month" check off these exact values — seeding "ค่าเช่า" as a string looks
  // right on screen and is invisible to both, so the break-even would fall back
  // to the branch rent setting while a 25,000 baht rent row sat on the page.
  const rows = [
    {
      date: new Date('2026-07-01'),
      category: ExpenseCategory.RENT,
      amountSatang: 2_500_000,
      paidBy: 'TRANSFER' as const,
      note: 'ค่าเช่าเดือนกรกฎาคม',
    },
    {
      date: new Date('2026-07-05'),
      category: ExpenseCategory.UTILITY,
      amountSatang: 480_000,
      paidBy: 'TRANSFER' as const,
      note: 'ค่าไฟ',
    },
    {
      date: new Date('2026-07-05'),
      category: ExpenseCategory.UTILITY,
      amountSatang: 85_000,
      paidBy: 'TRANSFER' as const,
      note: 'ค่าน้ำ',
    },
    {
      date: new Date('2026-07-02'),
      category: ExpenseCategory.EQUIPMENT,
      amountSatang: 1_200_000,
      paidBy: 'CASH' as const,
      note: 'เครื่องพิมพ์ใบเสร็จ + ลิ้นชัก',
    },
  ];

  for (const row of rows) {
    const existing = await prisma.expense.findFirst({
      where: { branchId, date: row.date, category: row.category, amountSatang: row.amountSatang },
    });
    if (!existing) {
      await prisma.expense.create({ data: { branchId, ...row } });
    }
  }
  console.log(`  expenses: ${rows.length}`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

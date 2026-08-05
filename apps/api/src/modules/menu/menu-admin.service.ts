/**
 * Changing the menu.
 *
 * Everything here sits behind MANAGE_MENU and every method answers with the
 * WHOLE menu again (see menu-admin.ts for why: one ingredient edit moves the
 * margin on nine dishes, and a targeted response would leave eight of them
 * wrong on screen).
 *
 * WHAT MAY BE DELETED, AND WHAT MAY ONLY BE SWITCHED OFF.
 *
 * A dish that has never been sold is a typo and can go. A dish that appears on
 * even one old bill can not: the order line points at it, the line keeps the
 * name and price it was sold at (rule #7), but the row still has to exist for
 * the foreign key — and deleting sales history to tidy up a menu is not a trade
 * anyone should be offered. Those get `isActive = false` instead, which takes
 * them off the till while every report keeps working. The refusal says which
 * one it is, because "ลบไม่ได้" with no reason is how people start editing the
 * database by hand.
 *
 * COST IS NEVER AN INPUT. There is no field for it in any request in this file.
 * It comes from the recipe, via recipe.service.ts, or it does not exist.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  recipeLineCostSatang,
  type AdminIngredientDto,
  type AdminMenuCategoryDto,
  type AdminMenuItemDto,
  type AdminModifierDto,
  type AdminModifierGroupDto,
  type AdminRecipeLineDto,
  type IngredientRequest,
  type MenuAdminResponse,
  type MenuCategoryRequest,
  type MenuItemRequest,
  type MoveDirection,
  type ModifierGroupRequest,
  type ModifierRequest,
  type SaveRecipeRequest,
} from '@pos/shared';
import { badRequest, conflict, notFound } from '../../http-error.js';
import { recalculateCosts, saveRecipe, type RecalculationSummary } from './recipe.service.js';

/** Just enough of the session to say who changed a price. */
export interface AdminActor {
  staffId: string;
  fullName: string;
}

const NOTHING: RecalculationSummary = { menuItems: 0, modifiers: 0 };

const RECIPE_INCLUDE = {
  include: { ingredient: { select: { name: true, baseUnit: true, avgCostSatang: true } } },
} satisfies Prisma.MenuItem$recipeLinesArgs;

const MENU_ITEM_INCLUDE = {
  groups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } },
  recipeLines: RECIPE_INCLUDE,
} satisfies Prisma.MenuItemInclude;

type MenuItemRow = Prisma.MenuItemGetPayload<{ include: typeof MENU_ITEM_INCLUDE }>;
type RecipeRow = MenuItemRow['recipeLines'][number];

export class MenuAdminService {
  constructor(private readonly db: PrismaClient) {}

  /* ================= reading ================= */

  /**
   * The management view of the whole menu.
   *
   * Unlike GET /menu this includes what is switched off, what has never been
   * costed, and how often each thing has been sold — the owner is deciding what
   * to keep, and a screen that hides the disappointing rows cannot help.
   */
  async snapshot(branchId: string): Promise<MenuAdminResponse> {
    const [categories, groups, ingredients, itemSales, modifierSales, groupUsage, recipeUsage] =
      await Promise.all([
        this.db.menuCategory.findMany({
          where: { branchId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            items: {
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              include: MENU_ITEM_INCLUDE,
            },
          },
        }),
        this.db.modifierGroup.findMany({
          where: { branchId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            modifiers: {
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              include: { recipeLines: RECIPE_INCLUDE },
            },
          },
        }),
        this.db.ingredient.findMany({ where: { branchId }, orderBy: { name: 'asc' } }),
        this.db.orderLine.groupBy({ by: ['menuItemId'], where: { branchId }, _count: true }),
        this.db.orderLineModifier.groupBy({
          by: ['modifierId'],
          where: { branchId },
          _count: true,
        }),
        this.db.menuItemGroup.groupBy({ by: ['groupId'], where: { branchId }, _count: true }),
        this.db.recipeLine.groupBy({ by: ['ingredientId'], where: { branchId }, _count: true }),
      ]);

    const soldItems = new Map(itemSales.map((row) => [row.menuItemId, row._count]));
    const soldModifiers = new Map(modifierSales.map((row) => [row.modifierId, row._count]));
    const usedGroups = new Map(groupUsage.map((row) => [row.groupId, row._count]));
    const usedIngredients = new Map(recipeUsage.map((row) => [row.ingredientId, row._count]));

    const categoryDtos: AdminMenuCategoryDto[] = categories.map((category) => ({
      id: category.id,
      name: category.name,
      icon: category.icon,
      subcategories: category.subcategories,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      items: category.items.map((item) => toMenuItemDto(item, soldItems.get(item.id) ?? 0)),
    }));

    const groupDtos: AdminModifierGroupDto[] = groups.map((group) => ({
      id: group.id,
      name: group.name,
      isRequired: group.isRequired,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      isNegative: group.isNegative,
      sortOrder: group.sortOrder,
      usedByItemCount: usedGroups.get(group.id) ?? 0,
      modifiers: group.modifiers.map((modifier): AdminModifierDto => ({
        id: modifier.id,
        groupId: modifier.groupId,
        name: modifier.name,
        priceDeltaSatang: modifier.priceDeltaSatang,
        costDeltaSatang: modifier.costDeltaSatang,
        hasRecipe: modifier.recipeLines.length > 0,
        isDefault: modifier.isDefault,
        isAvailable: modifier.isAvailable,
        sortOrder: modifier.sortOrder,
        recipe: toRecipeDto(modifier.recipeLines),
        soldCount: soldModifiers.get(modifier.id) ?? 0,
      })),
    }));

    const ingredientDtos: AdminIngredientDto[] = ingredients.map(
      (ingredient): AdminIngredientDto => ({
        id: ingredient.id,
        name: ingredient.name,
        baseUnit: ingredient.baseUnit,
        avgCostSatang: ingredient.avgCostSatang,
        shelfLifeDays: ingredient.shelfLifeDays,
        isActive: ingredient.isActive,
        usedByCount: usedIngredients.get(ingredient.id) ?? 0,
      }),
    );

    // Stations come from what the items actually say, not a settings table:
    // the kitchen screen already derives its filters the same way, and two
    // lists of station names would drift the first time one was renamed.
    const stations = [
      ...new Set(
        categories.flatMap((category) =>
          category.items
            .map((item) => item.station)
            .filter((station): station is string => Boolean(station)),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right, 'th'));

    return {
      categories: categoryDtos,
      modifierGroups: groupDtos,
      ingredients: ingredientDtos,
      stations,
    };
  }

  /* ================= categories ================= */

  /**
   * A new category lands at the END of the list, not at 0.
   *
   * Everything created with the same number sorts by name behind it, so a shop
   * that added หมวดของหวาน last would find it wherever the Thai alphabet put
   * it — and the ขึ้น/ลง buttons would appear to do nothing until the whole
   * list had been renumbered by hand.
   */
  async createCategory(
    branchId: string,
    input: MenuCategoryRequest,
  ): Promise<RecalculationSummary> {
    const last = await this.db.menuCategory.findFirst({
      where: { branchId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    await guardUniqueName(() =>
      this.db.menuCategory.create({
        data: {
          branchId,
          name: input.name,
          icon: input.icon ?? null,
          subcategories: input.subcategories,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          isActive: input.isActive,
        },
      }),
    );
    return NOTHING;
  }

  async updateCategory(
    branchId: string,
    id: string,
    input: MenuCategoryRequest,
  ): Promise<RecalculationSummary> {
    const category = await this.db.menuCategory.findFirst({ where: { id, branchId } });
    if (!category) throw notFound('CATEGORY_NOT_FOUND', 'ไม่พบหมวดนี้');

    // Dropping a subcategory that dishes are still filed under would leave them
    // pointing at a label that no longer exists — the till would show a filter
    // chip for it built from the category, and nothing under it.
    const removed = category.subcategories.filter((name) => !input.subcategories.includes(name));
    if (removed.length > 0) {
      const stranded = await this.db.menuItem.count({
        where: { branchId, categoryId: id, subcategory: { in: removed } },
      });
      if (stranded > 0) {
        throw conflict(
          'SUBCATEGORY_IN_USE',
          `ยังมีเมนู ${stranded} รายการอยู่ในหมวดย่อย ${removed.join(', ')} — ย้ายเมนูก่อน`,
        );
      }
    }

    // No sortOrder: renaming a category must not move it. That is what the
    // ขึ้น/ลง buttons are for, and they renumber the whole list.
    await guardUniqueName(() =>
      this.db.menuCategory.update({
        where: { id },
        data: {
          name: input.name,
          icon: input.icon ?? null,
          subcategories: input.subcategories,
          isActive: input.isActive,
        },
      }),
    );
    return NOTHING;
  }

  /**
   * Swaps a category with its neighbour, then renumbers the whole list 0..n-1.
   *
   * Server-side for the same reason the floor plan does it server-side: two
   * rows sharing a sortOrder fall back to sorting by name, so a client that
   * posted "you are now 3" would sometimes move a category nowhere visible.
   * Renumbering everything also cleans up whatever the seed left behind.
   */
  async moveCategory(
    branchId: string,
    id: string,
    direction: MoveDirection,
  ): Promise<RecalculationSummary> {
    const category = await this.db.menuCategory.findFirst({
      where: { id, branchId },
      select: { id: true },
    });
    if (!category) throw notFound('CATEGORY_NOT_FOUND', 'ไม่พบหมวดนี้');

    const siblings = await this.db.menuCategory.findMany({
      where: { branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true },
    });

    await this.renumber(siblings, id, direction, (rowId, sortOrder) =>
      this.db.menuCategory.update({ where: { id: rowId }, data: { sortOrder } }),
    );
    return NOTHING;
  }

  async deleteCategory(branchId: string, id: string): Promise<RecalculationSummary> {
    const category = await this.db.menuCategory.findFirst({
      where: { id, branchId },
      include: { _count: { select: { items: true } } },
    });
    if (!category) throw notFound('CATEGORY_NOT_FOUND', 'ไม่พบหมวดนี้');
    if (category._count.items > 0) {
      throw conflict(
        'CATEGORY_NOT_EMPTY',
        `หมวดนี้ยังมีเมนูอยู่ ${category._count.items} รายการ — ย้ายหรือลบเมนูก่อน`,
      );
    }
    await this.db.menuCategory.delete({ where: { id } });
    return NOTHING;
  }

  /* ================= menu items ================= */

  async createMenuItem(branchId: string, input: MenuItemRequest): Promise<RecalculationSummary> {
    await this.assertCategory(branchId, input.categoryId, input.subcategory ?? null);
    await this.assertGroups(branchId, input.groupIds);

    // Bottom of its category, like a new category goes to the bottom of the
    // menu: a dish added mid-service should not reshuffle the grid a cashier
    // has already learned the shape of.
    const last = await this.db.menuItem.findFirst({
      where: { branchId, categoryId: input.categoryId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    await guardUniqueName(() =>
      this.db.menuItem.create({
        data: {
          branchId,
          categoryId: input.categoryId,
          name: input.name,
          subcategory: input.subcategory ?? null,
          priceSatang: input.priceSatang,
          // No costSatang: a new dish costs nothing until it has a recipe, and
          // the screen says "ยังไม่ได้ใส่สูตร" rather than claiming it is free.
          station: input.station ?? null,
          isAvailable: input.isAvailable,
          isActive: input.isActive,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          groups: {
            create: input.groupIds.map((groupId, index) => ({
              branchId,
              groupId,
              sortOrder: index,
            })),
          },
        },
      }),
    );
    return NOTHING;
  }

  async updateMenuItem(
    branchId: string,
    actor: AdminActor,
    id: string,
    input: MenuItemRequest,
  ): Promise<RecalculationSummary> {
    const existing = await this.db.menuItem.findFirst({ where: { id, branchId } });
    if (!existing) throw notFound('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
    await this.assertCategory(branchId, input.categoryId, input.subcategory ?? null);
    await this.assertGroups(branchId, input.groupIds);

    // Moving a dish to another category sends it to the bottom of the new one;
    // its old position means nothing there. Staying put keeps its place —
    // an edit to the price must not shuffle the grid.
    const moved =
      existing.categoryId === input.categoryId
        ? {}
        : { sortOrder: await this.nextItemSortOrder(branchId, input.categoryId) };

    await this.db.$transaction(async (tx) => {
      await guardUniqueName(() =>
        tx.menuItem.update({
          where: { id },
          data: {
            categoryId: input.categoryId,
            name: input.name,
            subcategory: input.subcategory ?? null,
            priceSatang: input.priceSatang,
            station: input.station ?? null,
            isAvailable: input.isAvailable,
            isActive: input.isActive,
            ...moved,
          },
        }),
      );

      // The link rows carry the ORDER the option sheet shows groups in, so
      // they are rewritten rather than diffed — a diff would have to invent a
      // position for anything it kept.
      await tx.menuItemGroup.deleteMany({ where: { menuItemId: id } });
      if (input.groupIds.length > 0) {
        await tx.menuItemGroup.createMany({
          data: input.groupIds.map((groupId, index) => ({
            branchId,
            menuItemId: id,
            groupId,
            sortOrder: index,
          })),
        });
      }

      // "ใครขึ้นราคา" is a question that gets asked, and only about price.
      // Logging every field would bury it.
      if (existing.priceSatang !== input.priceSatang) {
        await audit(tx, branchId, actor, 'CHANGE_PRICE', 'MenuItem', id, {
          before: { name: existing.name, priceSatang: existing.priceSatang },
          after: { name: input.name, priceSatang: input.priceSatang },
        });
      }
    });
    return NOTHING;
  }

  /** Swaps a dish with its neighbour INSIDE its own category. */
  async moveMenuItem(
    branchId: string,
    id: string,
    direction: MoveDirection,
  ): Promise<RecalculationSummary> {
    const item = await this.db.menuItem.findFirst({
      where: { id, branchId },
      select: { categoryId: true },
    });
    if (!item) throw notFound('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');

    const siblings = await this.db.menuItem.findMany({
      where: { branchId, categoryId: item.categoryId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true },
    });

    await this.renumber(siblings, id, direction, (rowId, sortOrder) =>
      this.db.menuItem.update({ where: { id: rowId }, data: { sortOrder } }),
    );
    return NOTHING;
  }

  /** The one-tap "หมดแล้ว" during service. Deliberately not the full editor. */
  async setAvailability(
    branchId: string,
    id: string,
    isAvailable: boolean,
  ): Promise<RecalculationSummary> {
    const { count } = await this.db.menuItem.updateMany({
      where: { id, branchId },
      data: { isAvailable },
    });
    if (count === 0) throw notFound('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
    return NOTHING;
  }

  async deleteMenuItem(branchId: string, id: string): Promise<RecalculationSummary> {
    const item = await this.db.menuItem.findFirst({
      where: { id, branchId },
      include: { _count: { select: { orderLines: true } } },
    });
    if (!item) throw notFound('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
    if (item._count.orderLines > 0) {
      throw conflict(
        'MENU_ITEM_SOLD',
        `"${item.name}" เคยขายไปแล้ว ${item._count.orderLines} ครั้ง ลบไม่ได้ — ใช้ "เลิกขาย" แทน แล้วบิลเก่าจะยังอ่านได้`,
      );
    }
    // Recipe lines and group links cascade from the schema; nothing else points
    // at a dish that has never been sold.
    await this.db.menuItem.delete({ where: { id } });
    return NOTHING;
  }

  async saveMenuItemRecipe(
    branchId: string,
    id: string,
    input: SaveRecipeRequest,
  ): Promise<RecalculationSummary> {
    const item = await this.db.menuItem.findFirst({
      where: { id, branchId },
      select: { id: true },
    });
    if (!item) throw notFound('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
    await this.assertIngredients(branchId, input.lines);
    // A dish is what it is; only an OPTION can subtract (see recipe.ts).
    for (const line of input.lines) {
      if (line.quantity < 0) {
        throw badRequest(
          'NEGATIVE_RECIPE_QTY',
          'สูตรของเมนูใส่จำนวนติดลบไม่ได้ — ถ้าไม่ใส่วัตถุดิบนี้ ให้ลบบรรทัดออก',
        );
      }
    }

    return this.db.$transaction((tx) => saveRecipe(tx, branchId, { menuItemId: id }, input.lines));
  }

  /* ================= ingredients ================= */

  async createIngredient(
    branchId: string,
    input: IngredientRequest,
  ): Promise<RecalculationSummary> {
    await guardUniqueName(() =>
      this.db.ingredient.create({
        data: {
          branchId,
          name: input.name,
          baseUnit: input.baseUnit,
          avgCostSatang: input.avgCostSatang,
          shelfLifeDays: input.shelfLifeDays ?? null,
          isActive: input.isActive,
        },
      }),
    );
    return NOTHING;
  }

  /**
   * The one that cascades.
   *
   * Changing what pork costs is the whole reason this screen exists, and it is
   * also the only edit in this file that rewrites rows the user did not open.
   */
  async updateIngredient(
    branchId: string,
    actor: AdminActor,
    id: string,
    input: IngredientRequest,
  ): Promise<RecalculationSummary> {
    const existing = await this.db.ingredient.findFirst({ where: { id, branchId } });
    if (!existing) throw notFound('INGREDIENT_NOT_FOUND', 'ไม่พบวัตถุดิบนี้');

    // Changing the base unit under an existing recipe silently rescales every
    // dish that uses it: "120" meant grams this morning and kilos this
    // afternoon. Refused while anything still refers to it.
    if (existing.baseUnit !== input.baseUnit) {
      const uses = await this.db.recipeLine.count({ where: { branchId, ingredientId: id } });
      if (uses > 0) {
        throw conflict(
          'UNIT_IN_USE',
          `เปลี่ยนหน่วยไม่ได้ เพราะมี ${uses} สูตรที่ใช้ "${existing.name}" อยู่ — จำนวนในสูตรจะกลายเป็นคนละหน่วยทันที`,
        );
      }
    }

    return this.db.$transaction(async (tx) => {
      await guardUniqueName(() =>
        tx.ingredient.update({
          where: { id },
          data: {
            name: input.name,
            baseUnit: input.baseUnit,
            avgCostSatang: input.avgCostSatang,
            shelfLifeDays: input.shelfLifeDays ?? null,
            isActive: input.isActive,
          },
        }),
      );

      if (existing.avgCostSatang === input.avgCostSatang) return NOTHING;

      await audit(tx, branchId, actor, 'CHANGE_COST', 'Ingredient', id, {
        before: { name: existing.name, avgCostSatang: existing.avgCostSatang },
        after: { name: input.name, avgCostSatang: input.avgCostSatang },
      });
      return recalculateCosts(tx, branchId, { ingredientIds: [id] });
    });
  }

  async deleteIngredient(branchId: string, id: string): Promise<RecalculationSummary> {
    const ingredient = await this.db.ingredient.findFirst({
      where: { id, branchId },
      include: { _count: { select: { recipeLines: true, movements: true } } },
    });
    if (!ingredient) throw notFound('INGREDIENT_NOT_FOUND', 'ไม่พบวัตถุดิบนี้');
    if (ingredient._count.recipeLines > 0) {
      throw conflict(
        'INGREDIENT_IN_USE',
        `"${ingredient.name}" ถูกใช้ใน ${ingredient._count.recipeLines} สูตร ลบไม่ได้ — เอาออกจากสูตรก่อน`,
      );
    }
    if (ingredient._count.movements > 0) {
      throw conflict(
        'INGREDIENT_HAS_STOCK',
        `"${ingredient.name}" มีประวัติรับ/ตัดสต๊อกแล้ว ลบไม่ได้ — ปิดการใช้งานแทน`,
      );
    }
    await this.db.ingredient.delete({ where: { id } });
    return NOTHING;
  }

  /* ================= option groups ================= */

  async createModifierGroup(
    branchId: string,
    input: ModifierGroupRequest,
  ): Promise<RecalculationSummary> {
    await guardUniqueName(() => this.db.modifierGroup.create({ data: { branchId, ...input } }));
    return NOTHING;
  }

  async updateModifierGroup(
    branchId: string,
    id: string,
    input: ModifierGroupRequest,
  ): Promise<RecalculationSummary> {
    const group = await this.db.modifierGroup.findFirst({
      where: { id, branchId },
      include: { _count: { select: { modifiers: true } } },
    });
    if (!group) throw notFound('GROUP_NOT_FOUND', 'ไม่พบกลุ่มตัวเลือกนี้');

    // A group that must have one chosen, with nothing to choose, makes every
    // dish offering it impossible to order — and the failure appears at the
    // till, mid-service, not here.
    if (input.minSelect > 0 && group._count.modifiers === 0) {
      throw conflict(
        'GROUP_EMPTY',
        'กลุ่มนี้ยังไม่มีตัวเลือก — ตั้งเป็นบังคับเลือกไม่ได้ ไม่งั้นเมนูที่ใช้กลุ่มนี้จะสั่งไม่ได้',
      );
    }

    await guardUniqueName(() => this.db.modifierGroup.update({ where: { id }, data: input }));
    return NOTHING;
  }

  async deleteModifierGroup(branchId: string, id: string): Promise<RecalculationSummary> {
    const group = await this.db.modifierGroup.findFirst({
      where: { id, branchId },
      include: { _count: { select: { menuItems: true } } },
    });
    if (!group) throw notFound('GROUP_NOT_FOUND', 'ไม่พบกลุ่มตัวเลือกนี้');
    if (group._count.menuItems > 0) {
      throw conflict(
        'GROUP_IN_USE',
        `กลุ่มนี้ถูกใช้อยู่ใน ${group._count.menuItems} เมนู ลบไม่ได้ — เอาออกจากเมนูก่อน`,
      );
    }

    const sold = await this.db.orderLineModifier.count({
      where: { branchId, modifier: { groupId: id } },
    });
    if (sold > 0) {
      throw conflict(
        'GROUP_SOLD',
        `ตัวเลือกในกลุ่มนี้เคยถูกขายไปแล้ว ${sold} ครั้ง ลบไม่ได้ — บิลเก่าอ้างถึงอยู่`,
      );
    }

    await this.db.modifierGroup.delete({ where: { id } });
    return NOTHING;
  }

  async createModifier(
    branchId: string,
    groupId: string,
    input: ModifierRequest,
  ): Promise<RecalculationSummary> {
    const group = await this.db.modifierGroup.findFirst({
      where: { id: groupId, branchId },
      select: { id: true },
    });
    if (!group) throw notFound('GROUP_NOT_FOUND', 'ไม่พบกลุ่มตัวเลือกนี้');

    await this.db.$transaction(async (tx) => {
      await guardUniqueName(() => tx.modifier.create({ data: { branchId, groupId, ...input } }));
      if (input.isDefault) await clearOtherDefaults(tx, branchId, groupId, input.name);
    });
    return NOTHING;
  }

  async updateModifier(
    branchId: string,
    id: string,
    input: ModifierRequest,
  ): Promise<RecalculationSummary> {
    const existing = await this.db.modifier.findFirst({ where: { id, branchId } });
    if (!existing) throw notFound('MODIFIER_NOT_FOUND', 'ไม่พบตัวเลือกนี้');

    await this.db.$transaction(async (tx) => {
      await guardUniqueName(() => tx.modifier.update({ where: { id }, data: input }));
      if (input.isDefault) await clearOtherDefaults(tx, branchId, existing.groupId, input.name);
    });
    return NOTHING;
  }

  async deleteModifier(branchId: string, id: string): Promise<RecalculationSummary> {
    const modifier = await this.db.modifier.findFirst({
      where: { id, branchId },
      include: { _count: { select: { orderLines: true } } },
    });
    if (!modifier) throw notFound('MODIFIER_NOT_FOUND', 'ไม่พบตัวเลือกนี้');
    if (modifier._count.orderLines > 0) {
      throw conflict(
        'MODIFIER_SOLD',
        `"${modifier.name}" เคยถูกขายไปแล้ว ${modifier._count.orderLines} ครั้ง ลบไม่ได้ — ปิดการใช้งานแทน`,
      );
    }
    await this.db.modifier.delete({ where: { id } });
    return NOTHING;
  }

  /**
   * An option's recipe, where a negative quantity is the point.
   *
   * "บะหมี่" is −120 g เส้นเล็ก and +120 g บะหมี่: the option is a DIFFERENCE
   * against the bowl it is attached to, not a thing on its own.
   */
  async saveModifierRecipe(
    branchId: string,
    id: string,
    input: SaveRecipeRequest,
  ): Promise<RecalculationSummary> {
    const modifier = await this.db.modifier.findFirst({
      where: { id, branchId },
      select: { id: true },
    });
    if (!modifier) throw notFound('MODIFIER_NOT_FOUND', 'ไม่พบตัวเลือกนี้');
    await this.assertIngredients(branchId, input.lines);

    return this.db.$transaction((tx) => saveRecipe(tx, branchId, { modifierId: id }, input.lines));
  }

  /* ================= ordering ================= */

  private async nextItemSortOrder(branchId: string, categoryId: string): Promise<number> {
    const last = await this.db.menuItem.findFirst({
      where: { branchId, categoryId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }

  /**
   * Moves one row past its neighbour and writes the whole list back 0..n-1.
   *
   * Pressing ↑ on the first row is not an error — it is a finger landing on a
   * button the screen has already disabled, and answering a 409 for it would
   * put a red box in front of somebody who did nothing wrong. The list simply
   * comes back unchanged.
   */
  private async renumber(
    rows: readonly { id: string }[],
    id: string,
    direction: MoveDirection,
    write: (id: string, sortOrder: number) => Prisma.PrismaPromise<unknown>,
  ): Promise<void> {
    const from = rows.findIndex((row) => row.id === id);
    const to = direction === 'UP' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= rows.length) return;

    const reordered = [...rows];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved as { id: string });

    await this.db.$transaction(reordered.map((row, index) => write(row.id, index)));
  }

  /* ================= guards ================= */

  private async assertCategory(
    branchId: string,
    categoryId: string,
    subcategory: string | null,
  ): Promise<void> {
    const category = await this.db.menuCategory.findFirst({ where: { id: categoryId, branchId } });
    if (!category) throw notFound('CATEGORY_NOT_FOUND', 'ไม่พบหมวดนี้');
    // The schema has always said a subcategory must be one the category
    // declares; until now nothing enforced it, so a typo became a filter chip
    // on the till with exactly one dish behind it.
    if (subcategory && !category.subcategories.includes(subcategory)) {
      throw badRequest(
        'SUBCATEGORY_UNKNOWN',
        `หมวด "${category.name}" ไม่มีหมวดย่อย "${subcategory}" — เพิ่มในหมวดก่อน`,
      );
    }
  }

  private async assertGroups(branchId: string, groupIds: readonly string[]): Promise<void> {
    if (groupIds.length === 0) return;
    if (new Set(groupIds).size !== groupIds.length) {
      throw badRequest('GROUP_DUPLICATE', 'เลือกกลุ่มตัวเลือกซ้ำกัน');
    }
    const found = await this.db.modifierGroup.count({
      where: { branchId, id: { in: [...groupIds] } },
    });
    if (found !== groupIds.length) throw notFound('GROUP_NOT_FOUND', 'มีกลุ่มตัวเลือกที่ไม่พบ');
  }

  private async assertIngredients(
    branchId: string,
    lines: readonly { ingredientId: string }[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const ids = [...new Set(lines.map((line) => line.ingredientId))];
    const found = await this.db.ingredient.count({ where: { branchId, id: { in: ids } } });
    if (found !== ids.length) throw notFound('INGREDIENT_NOT_FOUND', 'มีวัตถุดิบที่ไม่พบ');
  }
}

/* ================= mapping ================= */

function toMenuItemDto(item: MenuItemRow, soldCount: number): AdminMenuItemDto {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    subcategory: item.subcategory,
    priceSatang: item.priceSatang,
    costSatang: item.costSatang,
    hasRecipe: item.recipeLines.length > 0,
    station: item.station,
    isAvailable: item.isAvailable,
    isActive: item.isActive,
    sortOrder: item.sortOrder,
    groupIds: item.groups.map((link) => link.groupId),
    recipe: toRecipeDto(item.recipeLines),
    soldCount,
  };
}

/**
 * Recipe rows for the editor, sorted by ingredient name.
 *
 * There is no sortOrder column on a recipe line and there should not be: sorted
 * by cost the rows would rearrange themselves under the finger that just typed
 * a quantity, which is how you delete the wrong line.
 */
function toRecipeDto(lines: readonly RecipeRow[]): AdminRecipeLineDto[] {
  return lines
    .map((line): AdminRecipeLineDto => {
      const quantity = line.quantity.toNumber();
      return {
        ingredientId: line.ingredientId,
        name: line.ingredient.name,
        baseUnit: line.ingredient.baseUnit,
        quantity,
        unitCostSatang: line.ingredient.avgCostSatang,
        lineCostSatang: recipeLineCostSatang({
          quantity,
          unitCostSatang: line.ingredient.avgCostSatang,
        }),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'th'));
}

/* ================= helpers ================= */

/**
 * Turns Postgres's unique-violation into a sentence.
 *
 * Without this, adding a second "ก๋วยเตี๋ยวหมู" answers with a 500 and the
 * constraint name — which tells the owner nothing and looks like the system
 * broke rather than like they already have one.
 */
async function guardUniqueName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict('NAME_TAKEN', 'มีชื่อนี้อยู่แล้ว — ใช้ชื่ออื่น');
    }
    throw error;
  }
}

/**
 * One default per group.
 *
 * Two defaults in a "choose exactly one" group means the till preselects both
 * and the option sheet opens already invalid — the cashier has to work out
 * which one to un-tap while a customer waits.
 */
async function clearOtherDefaults(
  tx: Prisma.TransactionClient,
  branchId: string,
  groupId: string,
  keepName: string,
): Promise<void> {
  await tx.modifier.updateMany({
    where: { branchId, groupId, isDefault: true, name: { not: keepName } },
    data: { isDefault: false },
  });
}

async function audit(
  tx: Prisma.TransactionClient,
  branchId: string,
  actor: AdminActor,
  action: string,
  entityType: string,
  entityId: string,
  change: { before: Prisma.InputJsonValue; after: Prisma.InputJsonValue },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      branchId,
      staffId: actor.staffId,
      action,
      entityType,
      entityId,
      before: change.before,
      after: change.after,
    },
  });
}

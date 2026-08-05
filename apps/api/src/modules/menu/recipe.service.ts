/**
 * Keeping cost in step with the recipe.
 *
 * `MenuItem.costSatang` and `Modifier.costDeltaSatang` are caches. The truth is
 * the recipe lines plus what each ingredient costs today, and this file is the
 * only thing allowed to write those two columns.
 *
 * THE CASCADE IS THE WHOLE POINT. Pork goes up 2 satang a gram and nine dishes
 * change cost. Nobody is going to re-save nine dishes by hand, and a shop that
 * has to would simply stop updating ingredient prices — at which point every
 * margin on the screen is a number from opening week. So an ingredient edit
 * walks the recipes that use it and rewrites them all in the same transaction.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *
 *  - Orders. Rule #7: a line keeps the cost it was sold at. Tonight's recipe
 *    change must not move this afternoon's profit, so nothing here goes near
 *    order_lines.
 *  - Anything without a recipe. The recompute walks recipe LINES, so a dish
 *    with an empty recipe is never visited and keeps whatever number it has.
 *    That is what stops an unrelated ingredient edit from silently zeroing the
 *    items nobody has written a recipe for yet; the management screen flags
 *    them as "ยังไม่ได้ใส่สูตร" instead of pretending they are free.
 */

import type { Prisma } from '@prisma/client';
import { recipeCostSatang, type RecipeCostLine } from '@pos/shared';

export interface RecalculationSummary {
  /** How many dishes actually moved — not how many were looked at. */
  menuItems: number;
  modifiers: number;
}

export const NOTHING_RECALCULATED: RecalculationSummary = { menuItems: 0, modifiers: 0 };

export interface RecalculationScope {
  menuItemIds?: readonly string[];
  modifierIds?: readonly string[];
  /** Expands to every dish and option whose recipe uses these. */
  ingredientIds?: readonly string[];
  /** Every recipe in the branch. Used by the seed and by a manual re-cost. */
  all?: boolean;
}

/** A recipe line with the ingredient's current price attached. */
type CostedLine = {
  menuItemId: string | null;
  modifierId: string | null;
  quantity: Prisma.Decimal;
  ingredient: { avgCostSatang: number };
};

export async function recalculateCosts(
  tx: Prisma.TransactionClient,
  branchId: string,
  scope: RecalculationScope,
): Promise<RecalculationSummary> {
  const menuItemIds = new Set(scope.menuItemIds ?? []);
  const modifierIds = new Set(scope.modifierIds ?? []);

  // An ingredient edit does not know what it affects; the recipe lines do.
  if (scope.ingredientIds?.length) {
    const users = await tx.recipeLine.findMany({
      where: { branchId, ingredientId: { in: [...scope.ingredientIds] } },
      select: { menuItemId: true, modifierId: true },
    });
    for (const row of users) {
      if (row.menuItemId) menuItemIds.add(row.menuItemId);
      if (row.modifierId) modifierIds.add(row.modifierId);
    }
  }

  if (!scope.all && menuItemIds.size === 0 && modifierIds.size === 0) {
    return NOTHING_RECALCULATED;
  }

  const lines = (await tx.recipeLine.findMany({
    where: {
      branchId,
      ...(scope.all
        ? {}
        : {
            OR: [
              { menuItemId: { in: [...menuItemIds] } },
              { modifierId: { in: [...modifierIds] } },
            ],
          }),
    },
    select: {
      menuItemId: true,
      modifierId: true,
      quantity: true,
      ingredient: { select: { avgCostSatang: true } },
    },
  })) as CostedLine[];

  const byMenuItem = new Map<string, RecipeCostLine[]>();
  const byModifier = new Map<string, RecipeCostLine[]>();
  for (const line of lines) {
    const costLine: RecipeCostLine = {
      // Decimal -> number happens exactly here, and recipeCostSatang scales it
      // back to integers immediately. It is never used in float arithmetic.
      quantity: line.quantity.toNumber(),
      unitCostSatang: line.ingredient.avgCostSatang,
    };
    const bucket = line.menuItemId ? byMenuItem : line.modifierId ? byModifier : null;
    const key = line.menuItemId ?? line.modifierId;
    if (!bucket || !key) continue;
    const existing = bucket.get(key);
    if (existing) existing.push(costLine);
    else bucket.set(key, [costLine]);
  }

  let menuItems = 0;
  for (const [id, costLines] of byMenuItem) {
    menuItems += await writeCost(tx, 'menuItem', branchId, id, recipeCostSatang(costLines));
  }
  let modifiers = 0;
  for (const [id, costLines] of byModifier) {
    modifiers += await writeCost(tx, 'modifier', branchId, id, recipeCostSatang(costLines));
  }
  return { menuItems, modifiers };
}

/**
 * Writes one cost, and reports 1 only if the number really moved.
 *
 * The `not` in the WHERE is doing two jobs: it keeps `updatedAt` still for rows
 * that did not change, and it makes the count on screen ("แก้ต้นทุน 9 เมนู")
 * mean what it says instead of counting everything that was looked at.
 */
async function writeCost(
  tx: Prisma.TransactionClient,
  kind: 'menuItem' | 'modifier',
  branchId: string,
  id: string,
  costSatang: number,
): Promise<number> {
  if (kind === 'menuItem') {
    const { count } = await tx.menuItem.updateMany({
      where: { id, branchId, costSatang: { not: costSatang } },
      data: { costSatang },
    });
    return count;
  }
  const { count } = await tx.modifier.updateMany({
    where: { id, branchId, costDeltaSatang: { not: costSatang } },
    data: { costDeltaSatang: costSatang },
  });
  return count;
}

/**
 * Replaces a whole recipe and re-costs what owns it.
 *
 * An EMPTY list is a deliberate act — "this dish has no recipe" — so the cost
 * is zeroed here rather than left behind. That is the one case the cascade
 * cannot cover, because with no lines left there is nothing for it to walk.
 */
export async function saveRecipe(
  tx: Prisma.TransactionClient,
  branchId: string,
  owner: { menuItemId: string } | { modifierId: string },
  lines: readonly { ingredientId: string; quantity: number }[],
): Promise<RecalculationSummary> {
  const where =
    'menuItemId' in owner ? { menuItemId: owner.menuItemId } : { modifierId: owner.modifierId };

  await tx.recipeLine.deleteMany({ where: { branchId, ...where } });
  if (lines.length > 0) {
    await tx.recipeLine.createMany({
      data: lines.map((line) => ({
        branchId,
        ...where,
        ingredientId: line.ingredientId,
        quantity: line.quantity,
      })),
    });
    return recalculateCosts(tx, branchId, {
      ...('menuItemId' in owner
        ? { menuItemIds: [owner.menuItemId] }
        : { modifierIds: [owner.modifierId] }),
    });
  }

  if ('menuItemId' in owner) {
    const { count } = await tx.menuItem.updateMany({
      where: { id: owner.menuItemId, branchId, costSatang: { not: 0 } },
      data: { costSatang: 0 },
    });
    return { menuItems: count, modifiers: 0 };
  }
  const { count } = await tx.modifier.updateMany({
    where: { id: owner.modifierId, branchId, costDeltaSatang: { not: 0 } },
    data: { costDeltaSatang: 0 },
  });
  return { menuItems: 0, modifiers: count };
}

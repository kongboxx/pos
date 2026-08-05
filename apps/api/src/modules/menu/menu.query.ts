/**
 * The menu, as both the till and a customer's phone read it.
 *
 * Extracted from menu.routes.ts in Step 7 for one reason: the QR page has to
 * show the SAME menu the till shows. Two queries would drift — one of them
 * would forget `isActive`, or forget that a sold-out dish is still listed and
 * greyed rather than hidden — and the version that drifts is always the one
 * the customer sees, because nobody in the shop looks at it.
 *
 * `includeCost` is the only difference between the two callers, and it is
 * false for the customer always: those endpoints need no login, so a field that
 * is merely "not displayed" is a field that is published.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import type { MenuResponse } from '@pos/shared';
import { loadAllGroups, toModifierGroupDto } from './modifier.service.js';

export async function loadMenuResponse(
  db: PrismaClient | Prisma.TransactionClient,
  branchId: string,
  includeCost: boolean,
): Promise<MenuResponse> {
  const [categories, groups] = await Promise.all([
    db.menuCategory.findMany({
      where: { branchId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          // Unavailable items are still returned, greyed out on screen. Hiding
          // them makes staff think the menu is broken and re-tap; showing them
          // as "หมด" answers the customer's question instead.
          //
          // isActive is the other thing entirely (Step 6): a dish the shop
          // stopped selling has no business on the till at all, and it only
          // still exists because old bills point at it.
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { groups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } } },
        },
      },
    }),
    loadAllGroups(db, branchId),
  ]);

  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      subcategories: category.subcategories,
      items: category.items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        name: item.name,
        subcategory: item.subcategory,
        priceSatang: item.priceSatang,
        ...(includeCost ? { costSatang: item.costSatang } : {}),
        station: item.station,
        isAvailable: item.isAvailable,
        groupIds: item.groups.map((link) => link.groupId),
      })),
    })),
    modifierGroups: groups.map(toModifierGroupDto),
  };
}

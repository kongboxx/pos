/**
 * Option groups, and turning a list of chosen ids into line snapshots.
 *
 * The server is the authority on what a bowl may be. The tablet runs the same
 * `validateSelection` from @pos/shared to grey out its confirm button, but that
 * is a courtesy to the cashier — this file is what decides, because the tablet
 * is a device on shop wifi that anybody can open devtools on.
 *
 * Cost never leaves here in a DTO. `costDeltaSatang` is read from the row and
 * written straight onto the snapshot; it is not part of ModifierGroupDto at
 * all, so there is no code path that could accidentally ship it to a till.
 */

import type { Modifier, ModifierGroup, Prisma } from '@prisma/client';
import {
  defaultSelectionFor,
  selectedModifiersOf,
  validateSelection,
  type ModifierGroupDto,
} from '@pos/shared';
import { badRequest, conflict } from '../../http-error.js';

export type ModifierGroupRow = ModifierGroup & { modifiers: Modifier[] };

/** What one chosen option becomes on the order line (rule #7: a snapshot). */
export interface ModifierSnapshot {
  modifierId: string;
  nameSnapshot: string;
  priceDeltaSatang: number;
  costDeltaSatang: number;
  /** Position within the line — the group order, frozen. */
  sortOrder: number;
}

const MODIFIER_ORDER = { orderBy: { sortOrder: 'asc' } } satisfies {
  orderBy: Prisma.ModifierOrderByWithRelationInput;
};

/**
 * The groups one menu item offers, in the order the sheet should show them.
 *
 * MenuItemGroup.sortOrder wins over the group's own sortOrder: the owner may
 * want ขนาด first on a drink and last on a bowl, and the link row is where
 * that decision belongs.
 */
export async function loadGroupsForMenuItem(
  tx: Prisma.TransactionClient,
  branchId: string,
  menuItemId: string,
): Promise<ModifierGroupRow[]> {
  const links = await tx.menuItemGroup.findMany({
    where: { branchId, menuItemId },
    orderBy: { sortOrder: 'asc' },
    include: { group: { include: { modifiers: MODIFIER_ORDER } } },
  });
  return links.map((link) => link.group);
}

/** Every group in the branch — the reference list the /menu response ships. */
export async function loadAllGroups(
  db: Prisma.TransactionClient,
  branchId: string,
): Promise<ModifierGroupRow[]> {
  return db.modifierGroup.findMany({
    where: { branchId },
    orderBy: { sortOrder: 'asc' },
    include: { modifiers: MODIFIER_ORDER },
  });
}

export function toModifierGroupDto(group: ModifierGroupRow): ModifierGroupDto {
  return {
    id: group.id,
    name: group.name,
    isRequired: group.isRequired,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    isNegative: group.isNegative,
    modifiers: group.modifiers.map((modifier) => ({
      id: modifier.id,
      name: modifier.name,
      priceDeltaSatang: modifier.priceDeltaSatang,
      isDefault: modifier.isDefault,
      isAvailable: modifier.isAvailable,
    })),
  };
}

/**
 * Validates a chosen set and returns the rows to store on the line.
 *
 * `requested === undefined` means "the usual" and falls back to the group
 * defaults. An empty array means the caller genuinely chose nothing, which is
 * an error if any group is required — see addOrderLineRequestSchema.
 *
 * Throws with the same code @pos/shared produced, so an API error and the
 * text the sheet already showed are the same sentence.
 */
export function resolveModifierSnapshots(
  groups: readonly ModifierGroupRow[],
  requested: readonly string[] | undefined,
): ModifierSnapshot[] {
  const dtoGroups = groups.map(toModifierGroupDto);
  const selection = requested ?? defaultSelectionFor(dtoGroups);

  const problem = validateSelection(dtoGroups, selection);
  if (problem) {
    // "หมดแล้ว" is a state of the shop, not a bad request — same 409 the till
    // already handles for a sold-out menu item.
    throw problem.code === 'MODIFIER_UNAVAILABLE'
      ? conflict(problem.code, problem.message)
      : badRequest(problem.code, problem.message);
  }

  const rows = new Map(groups.flatMap((group) => group.modifiers).map((row) => [row.id, row]));

  // selectedModifiersOf fixes the order (group order, not tap order); the map
  // lookup then adds the cost, which the DTO deliberately does not carry.
  return selectedModifiersOf(dtoGroups, selection).map((chosen, index) => {
    const row = rows.get(chosen.id) as Modifier;
    return {
      modifierId: row.id,
      nameSnapshot: row.name,
      priceDeltaSatang: row.priceDeltaSatang,
      costDeltaSatang: row.costDeltaSatang,
      sortOrder: index,
    };
  });
}

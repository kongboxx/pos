/**
 * Options — เส้น / น้ำซุป / ขนาด / เพิ่มเติม / ไม่ใส่.
 *
 * The whole point of this file is that THE RULE LIVES IN ONE PLACE.
 *
 * Two different programs need to know whether a set of chosen options is legal:
 * the tablet, so it can grey out the "เพิ่มลงบิล" button and say why, and the
 * API, which is the only authority that actually counts. If those two carried
 * their own copy of "เส้น is required, เพิ่มเติม allows at most 5", they would
 * drift within a month and the till would offer a combination the server then
 * refuses — with the customer already standing there.
 *
 * So `validateSelection` is written once here, imported by both, and tested
 * against the cases that hurt rather than against its own implementation.
 *
 * Money: a modifier carries a price DELTA which may be negative (เกาเหลา gives
 * money back). Deltas are integer satang like everything else, and they are
 * summed with sumSatang so a float can never sneak in through an option.
 */

import { z } from 'zod';
import { sumSatang, type Satang } from './money.js';
import { satangSchema, uuidSchema } from './schemas.js';

/** Bounds the work a single request can ask for. Real groups cap far lower. */
export const MAX_MODIFIERS_PER_LINE = 20;

export const modifierDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  /** May be negative — a removal that gives money back. */
  priceDeltaSatang: satangSchema,
  /** Preselected when the sheet opens: the choice most customers make. */
  isDefault: z.boolean(),
  /** false = ของหมด. Still shown, but cannot be picked. */
  isAvailable: z.boolean(),
});
export type ModifierDto = z.infer<typeof modifierDtoSchema>;

export const modifierGroupDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  isRequired: z.boolean(),
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(1),
  /** true for "ไม่ใส่…" — a removal group, drawn in a warning colour. */
  isNegative: z.boolean(),
  modifiers: z.array(modifierDtoSchema),
});
export type ModifierGroupDto = z.infer<typeof modifierGroupDtoSchema>;

/** The ids of the chosen options. Order is irrelevant; the group order wins. */
export const modifierIdsSchema = z.array(uuidSchema).max(MAX_MODIFIERS_PER_LINE);

/* ------------------------------------------------------------------ */
/* rules                                                               */
/* ------------------------------------------------------------------ */

/**
 * How many options this group insists on.
 *
 * `isRequired` and `minSelect` are two ways of saying the same thing and a
 * menu editor will eventually set one without the other. Required always means
 * at least one, whatever minSelect says.
 */
export function minSelectOf(group: ModifierGroupDto): number {
  return group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;
}

/**
 * What the sheet starts with.
 *
 * This is what makes one bowl fast: the common bowl (เส้นเล็ก น้ำใส ธรรมดา) is
 * already chosen when the sheet opens, so an ordinary order is open-confirm,
 * and only an unusual one costs extra taps.
 *
 * A sold-out default is skipped — offering it would produce a selection the
 * server rejects the moment it is confirmed.
 */
export function defaultSelectionFor(groups: readonly ModifierGroupDto[]): string[] {
  const chosen: string[] = [];
  for (const group of groups) {
    const defaults = group.modifiers.filter(
      (modifier) => modifier.isDefault && modifier.isAvailable,
    );
    for (const modifier of defaults.slice(0, group.maxSelect)) chosen.push(modifier.id);
  }
  return chosen;
}

export type SelectionProblemCode =
  'UNKNOWN_MODIFIER' | 'DUPLICATE_MODIFIER' | 'MODIFIER_UNAVAILABLE' | 'TOO_FEW' | 'TOO_MANY';

export interface SelectionProblem {
  code: SelectionProblemCode;
  /** Thai, ready to show on the tablet or to return as an API error message. */
  message: string;
  /** Which group to highlight, when the problem belongs to one. */
  groupId?: string;
}

/**
 * Checks a set of chosen option ids against the groups the item offers.
 *
 * Returns the FIRST problem, or null when the selection is legal. One problem
 * rather than a list because the sheet shows a single line of text under the
 * confirm button — a list would not fit and would not be read.
 */
export function validateSelection(
  groups: readonly ModifierGroupDto[],
  selectedIds: readonly string[],
): SelectionProblem | null {
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) {
      return { code: 'DUPLICATE_MODIFIER', message: 'เลือกตัวเลือกเดียวกันซ้ำ' };
    }
    seen.add(id);
  }

  const byId = new Map<string, { group: ModifierGroupDto; modifier: ModifierDto }>();
  for (const group of groups) {
    for (const modifier of group.modifiers) byId.set(modifier.id, { group, modifier });
  }

  for (const id of selectedIds) {
    const found = byId.get(id);
    if (!found) {
      return { code: 'UNKNOWN_MODIFIER', message: 'มีตัวเลือกที่ไม่ได้อยู่ในเมนูนี้' };
    }
    if (!found.modifier.isAvailable) {
      return {
        code: 'MODIFIER_UNAVAILABLE',
        message: `"${found.modifier.name}" หมดแล้ว`,
        groupId: found.group.id,
      };
    }
  }

  for (const group of groups) {
    const count = group.modifiers.filter((modifier) => seen.has(modifier.id)).length;
    const min = minSelectOf(group);
    if (count < min) {
      return {
        code: 'TOO_FEW',
        message:
          min === 1
            ? `ต้องเลือก "${group.name}"`
            : `"${group.name}" ต้องเลือกอย่างน้อย ${min} อย่าง`,
        groupId: group.id,
      };
    }
    if (count > group.maxSelect) {
      return {
        code: 'TOO_MANY',
        message: `"${group.name}" เลือกได้ไม่เกิน ${group.maxSelect} อย่าง`,
        groupId: group.id,
      };
    }
  }

  return null;
}

/**
 * The chosen options, in GROUP order — not tap order.
 *
 * A kitchen ticket that reads "น้ำใส · เส้นเล็ก" on one line and
 * "เส้นเล็ก · น้ำใส" on the next is slower to read at 1.5m, and the cook is
 * the one paying for it. Group order is also what the receipt prints and what
 * the snapshot stores, so the same bowl always looks the same.
 */
export function selectedModifiersOf(
  groups: readonly ModifierGroupDto[],
  selectedIds: readonly string[],
): ModifierDto[] {
  const selected = new Set(selectedIds);
  return groups.flatMap((group) => group.modifiers.filter((modifier) => selected.has(modifier.id)));
}

/** Sum of the chosen options' price deltas. May be negative. */
export function selectionPriceDeltaSatang(
  groups: readonly ModifierGroupDto[],
  selectedIds: readonly string[],
): Satang {
  return sumSatang(selectedModifiersOf(groups, selectedIds).map((m) => m.priceDeltaSatang));
}

/** `เส้นเล็ก · น้ำตก · พิเศษ` — the one-line summary printed under an item. */
export function formatModifierSummary(names: readonly string[]): string {
  return names.join(' · ');
}

/**
 * The identity of a bill line, for deciding "same thing, add one" vs "new row".
 *
 * Before Step 3 the till merged on menu item alone. That is wrong the moment
 * options exist: two bowls of ก๋วยเตี๋ยวหมู, one เส้นเล็ก and one บะหมี่, are
 * NOT the same line, and merging them would send the kitchen a ticket for two
 * identical bowls. Ids are sorted so the order they were tapped in cannot
 * split what is really one line.
 */
export function lineSignature(
  menuItemId: string,
  modifierIds: readonly string[],
  note?: string | null,
): string {
  const ids = [...modifierIds].sort();
  return `${menuItemId}|${ids.join(',')}|${note ?? ''}`;
}

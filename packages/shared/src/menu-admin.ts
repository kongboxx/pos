/**
 * The menu as the OWNER sees it, and the requests that change it.
 *
 * Two shapes for one menu, on purpose. `MenuResponse` (order.ts) is what a
 * cashier's tablet gets: no costs, no inactive rows, no recipes. This file is
 * the management view — costs, margins, recipes, how often a thing has been
 * sold — and every route that serves it sits behind MANAGE_MENU.
 *
 * WHY EVERY MUTATION RETURNS THE WHOLE MENU BACK.
 *
 * Changing one ingredient's price moves the cost of every dish that uses it.
 * A response carrying only the row that was edited would leave the rest of the
 * screen showing yesterday's margins, and the owner would be reading stale
 * numbers while believing they had just refreshed them. The whole snapshot is
 * a few kilobytes for a noodle shop; a wrong margin is a wrong price decision.
 */

import { z } from 'zod';
import { isStorableQuantity, MAX_RECIPE_LINES, RECIPE_QTY_DECIMALS } from './recipe.js';
import { nonNegativeSatangSchema, satangSchema, uuidSchema } from './schemas.js';

/* ---------------- shared field rules ---------------- */

export const menuNameSchema = z
  .string()
  .trim()
  .min(1, 'ต้องใส่ชื่อ')
  .max(80, 'ชื่อยาวเกินไป (ไม่เกิน 80 ตัวอักษร)');

/** "กรัม", "มิลลิลิตร", "ชิ้น" — free text, because a shop invents units. */
export const baseUnitSchema = z.string().trim().min(1, 'ต้องใส่หน่วย').max(20, 'หน่วยยาวเกินไป');

export const subcategorySchema = z.string().trim().min(1).max(40);
export const sortOrderSchema = z.number().int().min(0).max(999);
export const stationSchema = z.string().trim().min(1).max(64);

/* ---------------- recipe ---------------- */

export const recipeQuantitySchema = z
  .number()
  .refine(isStorableQuantity, `จำนวนต้องมีทศนิยมไม่เกิน ${RECIPE_QTY_DECIMALS} ตำแหน่ง`)
  .refine((value) => value !== 0, 'จำนวนต้องไม่เป็น 0 — ถ้าไม่ใช้ ให้ลบบรรทัดออก');

export const recipeLineInputSchema = z.object({
  ingredientId: uuidSchema,
  quantity: recipeQuantitySchema,
});
export type RecipeLineInput = z.infer<typeof recipeLineInputSchema>;

/**
 * The WHOLE recipe, every time — this replaces what was there.
 *
 * Line-by-line add/remove endpoints would need the client to track ids it does
 * not otherwise care about, and two tablets editing the same dish would
 * interleave into a recipe neither of them typed. Sending the finished list
 * makes the last save win, visibly and completely.
 */
export const saveRecipeRequestSchema = z
  .object({
    lines: z.array(recipeLineInputSchema).max(MAX_RECIPE_LINES, 'สูตรมีวัตถุดิบมากเกินไป'),
  })
  .refine(
    (value) => new Set(value.lines.map((line) => line.ingredientId)).size === value.lines.length,
    { message: 'มีวัตถุดิบซ้ำกันในสูตรเดียว — รวมเป็นบรรทัดเดียว', path: ['lines'] },
  );
export type SaveRecipeRequest = z.infer<typeof saveRecipeRequestSchema>;

/* ---------------- ingredients ---------------- */

export const ingredientRequestSchema = z.object({
  name: menuNameSchema,
  baseUnit: baseUnitSchema,
  /** Cost of ONE base unit. Pick the unit small enough that this stays precise:
   *  3 satang per gram, not 3000 per kilo, or every recipe rounds to nothing. */
  avgCostSatang: nonNegativeSatangSchema,
  shelfLifeDays: z.number().int().min(0).max(3650).nullish(),
  isActive: z.boolean().default(true),
});
export type IngredientRequest = z.infer<typeof ingredientRequestSchema>;

/* ---------------- categories ---------------- */

/**
 * `sortOrder` IS NOT HERE, and the same is true of a dish below.
 *
 * The order the till shows things in is decided by the ขึ้น/ลง buttons, which
 * renumber a whole list server-side (see moveRequestSchema). A form that posted
 * a number would keep handing new rows a 0, and rows sharing a number fall back
 * to sorting by name — so a category the owner had just dragged to the top
 * would quietly sit wherever the Thai alphabet put it.
 */
export const menuCategoryRequestSchema = z.object({
  name: menuNameSchema,
  icon: z.string().trim().max(8).nullish(),
  subcategories: z.array(subcategorySchema).max(20).default([]),
  isActive: z.boolean().default(true),
});
export type MenuCategoryRequest = z.infer<typeof menuCategoryRequestSchema>;

/* ---------------- menu items ---------------- */

/**
 * A full replace of everything the editor shows, not a patch.
 *
 * The form always holds every field, so a patch would only add "which keys did
 * they actually touch" as a question nobody needs answered. Cost is absent by
 * design — it comes from the recipe, and this is the one place someone would
 * otherwise be tempted to type it.
 */
export const menuItemRequestSchema = z.object({
  categoryId: uuidSchema,
  name: menuNameSchema,
  subcategory: subcategorySchema.nullish(),
  priceSatang: nonNegativeSatangSchema,
  /** Which kitchen prints/shows it. Null falls back to DEFAULT_STATION. */
  station: stationSchema.nullish(),
  /** Option groups offered, in the order the sheet should show them. */
  groupIds: z.array(uuidSchema).max(20).default([]),
  /** false = หมดวันนี้. Still drawn on the till, greyed out. */
  isAvailable: z.boolean().default(true),
  /** false = เลิกขาย. Off the till entirely, but history keeps it. */
  isActive: z.boolean().default(true),
});
export type MenuItemRequest = z.infer<typeof menuItemRequestSchema>;

/** The one-tap "หมดแล้ว" during service — not worth sending the whole item for. */
export const availabilityRequestSchema = z.object({ isAvailable: z.boolean() });
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;

/* ---------------- option groups ---------------- */

export const modifierGroupRequestSchema = z
  .object({
    name: menuNameSchema,
    isRequired: z.boolean().default(false),
    minSelect: z.number().int().min(0).max(20).default(0),
    maxSelect: z.number().int().min(1).max(20).default(1),
    isNegative: z.boolean().default(false),
    sortOrder: sortOrderSchema.default(0),
  })
  .refine((value) => value.minSelect <= value.maxSelect, {
    message: 'เลือกอย่างน้อยต้องไม่มากกว่าเลือกได้สูงสุด',
    path: ['minSelect'],
  })
  .refine((value) => !value.isRequired || value.minSelect >= 1, {
    message: 'กลุ่มบังคับเลือกต้องเลือกอย่างน้อย 1',
    path: ['minSelect'],
  });
export type ModifierGroupRequest = z.infer<typeof modifierGroupRequestSchema>;

export const modifierRequestSchema = z.object({
  name: menuNameSchema,
  /** May be negative: เกาเหลา gives money back. */
  priceDeltaSatang: satangSchema,
  isDefault: z.boolean().default(false),
  isAvailable: z.boolean().default(true),
  sortOrder: sortOrderSchema.default(0),
});
export type ModifierRequest = z.infer<typeof modifierRequestSchema>;

/* ---------------- responses ---------------- */

export const adminRecipeLineDtoSchema = z.object({
  ingredientId: uuidSchema,
  name: z.string(),
  baseUnit: z.string(),
  quantity: z.number(),
  /** The ingredient's cost per base unit at this moment, not a snapshot. */
  unitCostSatang: satangSchema,
  lineCostSatang: satangSchema,
});
export type AdminRecipeLineDto = z.infer<typeof adminRecipeLineDtoSchema>;

export const adminIngredientDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  baseUnit: z.string(),
  avgCostSatang: satangSchema,
  shelfLifeDays: z.number().int().nullable(),
  isActive: z.boolean(),
  /** Recipes referencing it. Zero means it is safe to delete. */
  usedByCount: z.number().int(),
});
export type AdminIngredientDto = z.infer<typeof adminIngredientDtoSchema>;

export const adminMenuItemDtoSchema = z.object({
  id: uuidSchema,
  categoryId: uuidSchema,
  name: z.string(),
  subcategory: z.string().nullable(),
  priceSatang: satangSchema,
  /** Derived from `recipe`. Meaningless unless `hasRecipe` is true. */
  costSatang: satangSchema,
  /** false = the cost above is a leftover, not an answer. The screen says so. */
  hasRecipe: z.boolean(),
  station: z.string().nullable(),
  isAvailable: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  groupIds: z.array(uuidSchema),
  recipe: z.array(adminRecipeLineDtoSchema),
  /** Lines ever sold. Non-zero means delete is refused — history needs the row. */
  soldCount: z.number().int(),
});
export type AdminMenuItemDto = z.infer<typeof adminMenuItemDtoSchema>;

export const adminMenuCategoryDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  icon: z.string().nullable(),
  subcategories: z.array(z.string()),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  items: z.array(adminMenuItemDtoSchema),
});
export type AdminMenuCategoryDto = z.infer<typeof adminMenuCategoryDtoSchema>;

export const adminModifierDtoSchema = z.object({
  id: uuidSchema,
  groupId: uuidSchema,
  name: z.string(),
  priceDeltaSatang: satangSchema,
  /** Derived from `recipe`, and negative for a swap that removes more than it adds. */
  costDeltaSatang: satangSchema,
  hasRecipe: z.boolean(),
  isDefault: z.boolean(),
  isAvailable: z.boolean(),
  sortOrder: z.number().int(),
  recipe: z.array(adminRecipeLineDtoSchema),
  soldCount: z.number().int(),
});
export type AdminModifierDto = z.infer<typeof adminModifierDtoSchema>;

export const adminModifierGroupDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  isRequired: z.boolean(),
  minSelect: z.number().int(),
  maxSelect: z.number().int(),
  isNegative: z.boolean(),
  sortOrder: z.number().int(),
  /** Menu items offering this group — the delete guard, and useful on screen. */
  usedByItemCount: z.number().int(),
  modifiers: z.array(adminModifierDtoSchema),
});
export type AdminModifierGroupDto = z.infer<typeof adminModifierGroupDtoSchema>;

export const menuAdminResponseSchema = z.object({
  categories: z.array(adminMenuCategoryDtoSchema),
  modifierGroups: z.array(adminModifierGroupDtoSchema),
  ingredients: z.array(adminIngredientDtoSchema),
  /** Every station named by any item — the item editor offers these as chips. */
  stations: z.array(z.string()),
});
export type MenuAdminResponse = z.infer<typeof menuAdminResponseSchema>;

/**
 * What one mutation did.
 *
 * `recalculated` is the honest part: raising the price of pork silently moves
 * the margin on nine dishes, and the screen should be able to say "แก้ต้นทุน
 * 9 เมนู" rather than letting the owner discover it by comparing rows.
 */
export const menuAdminMutationResponseSchema = z.object({
  menu: menuAdminResponseSchema,
  recalculated: z.object({
    menuItems: z.number().int(),
    modifiers: z.number().int(),
  }),
});
export type MenuAdminMutationResponse = z.infer<typeof menuAdminMutationResponseSchema>;

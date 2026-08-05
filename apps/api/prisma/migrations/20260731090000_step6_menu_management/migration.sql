-- Step 6: managing the menu, and cost that comes from the recipe.
--
-- "เลิกขาย" is not "หมดวันนี้".
--
-- isAvailable already existed and means the shop ran out this morning: the
-- button stays on the till, greyed out, so staff can answer the customer. What
-- was missing is a way to take a dish OFF the menu for good. It cannot be a
-- DELETE, because every order line ever sold still points at the row and
-- history must survive; and it cannot reuse isAvailable, because "we stopped
-- selling this in March" would then read to the kitchen as "we ran out today".
ALTER TABLE "menu_items" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- One row per ingredient per recipe.
--
-- Two rows for the same ingredient would still add up to the right cost, so
-- nothing would look broken — but the editor would list it twice and whoever
-- corrected one of them would leave the other behind, and the dish would then
-- cost more than its recipe says forever.
--
-- Postgres treats NULLs as distinct, so a menu item's rows (modifierId NULL)
-- never collide with a modifier's (menuItemId NULL). That is what lets these
-- be two plain unique indexes instead of two partial ones.
CREATE UNIQUE INDEX "recipe_lines_menuItemId_ingredientId_key" ON "recipe_lines"("menuItemId", "ingredientId");
CREATE UNIQUE INDEX "recipe_lines_modifierId_ingredientId_key" ON "recipe_lines"("modifierId", "ingredientId");

-- modifiers.ingredientId goes away: it was a guess that has been overtaken.
--
-- The column was added in Step 0 as "the ingredient this option consumes",
-- pointing at ONE ingredient with no quantity — which cannot cost anything.
-- Step 6 answers the same question properly with recipe_lines: a modifier gets
-- a recipe exactly like a dish does, and "บะหมี่" turns out to be two lines,
-- −120 g of one noodle and +120 g of another.
--
-- No code ever read the column. Leaving it would only invite the next person
-- to wire costing to the half that cannot work.
--
-- Its own migration rather than part of the Step 6 one because that migration
-- had already been applied to the dev database, and rewriting an applied
-- migration is how a team ends up with two databases that disagree about what
-- they have run.
ALTER TABLE "modifiers" DROP CONSTRAINT "modifiers_ingredientId_fkey";
ALTER TABLE "modifiers" DROP COLUMN "ingredientId";

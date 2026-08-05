-- Step 7: customer QR ordering.
--
-- Three changes, and the interesting one is the third.
--
-- 1. branches.qrOrderingEnabled — the off switch for an endpoint that needs no
--    login. Defaults to true because a shop that just migrated has no stickers
--    printed yet, so there is nothing to switch off.
--
-- 2. dining_tables.qrToken — what is printed on the sticker on the table.
--    Added nullable, backfilled with a random value per table, and only then
--    made NOT NULL: adding a UNIQUE NOT NULL column to a table that already has
--    rows fails outright, and a DEFAULT would give every existing table the
--    SAME token, which is worse than failing.
--
-- 3. table_sessions.qrToken is DROPPED. It was a Step 0 guess: a token that
--    rotates every sitting so a screenshot cannot order onto the next
--    customer's bill. That idea does not survive the physical world — the
--    customer reaches the page by scanning a printed sticker, and a sticker
--    cannot be reprinted between two bowls of noodles. Nothing ever read the
--    column. Leaving it would invite the next person to build the rotating-token
--    exchange it implies, on top of a sticker that cannot rotate.

ALTER TABLE "branches" ADD COLUMN "qrOrderingEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "dining_tables" ADD COLUMN "qrToken" TEXT;

-- gen_random_uuid() is built in from Postgres 13 (this project runs 16), so no
-- extension is needed. The dashes come out because the token is a URL segment
-- and shorter is denser is easier for a phone camera to read across a table.
-- 32 hex characters is longer than the 16 the API generates from here on; both
-- pass qrTokenSchema, and these rows exist only until someone prints a sticker.
UPDATE "dining_tables"
SET "qrToken" = replace(gen_random_uuid()::text, '-', '')
WHERE "qrToken" IS NULL;

ALTER TABLE "dining_tables" ALTER COLUMN "qrToken" SET NOT NULL;
CREATE UNIQUE INDEX "dining_tables_qrToken_key" ON "dining_tables"("qrToken");

DROP INDEX IF EXISTS "table_sessions_qrToken_key";
ALTER TABLE "table_sessions" DROP COLUMN "qrToken";

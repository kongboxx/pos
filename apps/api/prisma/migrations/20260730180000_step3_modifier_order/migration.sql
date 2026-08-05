-- Step 3: options on an order line have a stable printed order.
--
-- Rows come back from Postgres in whatever order it likes unless asked. The
-- snapshot is written in modifier-GROUP order, and this column preserves that
-- so a reprinted kitchen ticket reads exactly like the first one.
ALTER TABLE "order_line_modifiers" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

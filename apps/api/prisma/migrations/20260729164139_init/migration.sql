-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RESTAURANT', 'RETAIL');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'PROBATION', 'LEAVE', 'LEFT');

-- CreateEnum
CREATE TYPE "Nationality" AS ENUM ('TH', 'FOREIGN');

-- CreateEnum
CREATE TYPE "WageType" AS ENUM ('DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateEnum
CREATE TYPE "OrderLineSource" AS ENUM ('STAFF', 'QR');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'PROMPTPAY');

-- CreateEnum
CREATE TYPE "PaidBy" AS ENUM ('CASH', 'TRANSFER');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('RECEIPT', 'TAX_INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIVE', 'SALE', 'WASTE', 'TRANSFER', 'COUNT');

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "businessType" "BusinessType" NOT NULL DEFAULT 'RESTAURANT',
    "address" TEXT,
    "phone" TEXT,
    "taxId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "dayCutoffHour" INTEGER NOT NULL DEFAULT 4,
    "vatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "priceIncludesVat" BOOLEAN NOT NULL DEFAULT true,
    "vatEffectiveDate" DATE,
    "rentPerMonthSatang" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "nickname" TEXT,
    "position" TEXT,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "pinHash" TEXT NOT NULL,
    "phone" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" "StaffStatus" NOT NULL DEFAULT 'PROBATION',
    "nationality" "Nationality" NOT NULL DEFAULT 'TH',
    "passportNo" TEXT,
    "passportExpiry" DATE,
    "workPermitNo" TEXT,
    "workPermitExpiry" DATE,
    "wageType" "WageType" NOT NULL DEFAULT 'DAILY',
    "wageRateSatang" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_deductions" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "note" TEXT,
    "payrollLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "totalSatang" INTEGER NOT NULL DEFAULT 0,
    "expenseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "payrollId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "wageTypeSnapshot" "WageType" NOT NULL,
    "wageRateSnapshot" INTEGER NOT NULL,
    "daysWorked" INTEGER NOT NULL DEFAULT 0,
    "grossSatang" INTEGER NOT NULL,
    "bonusSatang" INTEGER NOT NULL DEFAULT 0,
    "deductSatang" INTEGER NOT NULL DEFAULT 0,
    "netSatang" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dining_tables" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT,
    "seats" INTEGER NOT NULL DEFAULT 4,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dining_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "qrToken" TEXT NOT NULL,

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "subcategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subcategory" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "priceSatang" INTEGER NOT NULL,
    "costSatang" INTEGER NOT NULL DEFAULT 0,
    "station" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "isNegative" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifiers" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaSatang" INTEGER NOT NULL DEFAULT 0,
    "costDeltaSatang" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "ingredientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_groups" (
    "branchId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_item_groups_pkey" PRIMARY KEY ("menuItemId","groupId")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "avgCostSatang" INTEGER NOT NULL DEFAULT 0,
    "shelfLifeDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_lines" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "modifierId" TEXT,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT,
    "sessionId" TEXT,
    "orderNo" TEXT,
    "businessDate" DATE NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "channel" "OrderChannel" NOT NULL DEFAULT 'DINE_IN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "subtotalExVatSatang" INTEGER NOT NULL DEFAULT 0,
    "vatRateBpSnapshot" INTEGER NOT NULL DEFAULT 0,
    "vatAmountSatang" INTEGER NOT NULL DEFAULT 0,
    "totalSatang" INTEGER NOT NULL DEFAULT 0,
    "costSatang" INTEGER NOT NULL DEFAULT 0,
    "discountSatang" INTEGER NOT NULL DEFAULT 0,
    "isVatInclusive" BOOLEAN NOT NULL DEFAULT true,
    "taxInvoiceNo" TEXT,
    "customerTaxId" TEXT,
    "customerName" TEXT,
    "createdOffline" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPriceSatang" INTEGER NOT NULL,
    "unitCostSatang" INTEGER NOT NULL,
    "vatAmountSatang" INTEGER NOT NULL DEFAULT 0,
    "source" "OrderLineSource" NOT NULL DEFAULT 'STAFF',
    "firedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_modifiers" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "priceDeltaSatang" INTEGER NOT NULL DEFAULT 0,
    "costDeltaSatang" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_tickets" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tableName" TEXT,
    "station" TEXT NOT NULL DEFAULT 'ครัว',
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_lines" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "modifiersSnapshot" TEXT,
    "note" TEXT,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "ticket_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "receivedSatang" INTEGER,
    "changeSatang" INTEGER DEFAULT 0,
    "referenceNo" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "void_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT NOT NULL,
    "wasFired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "void_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "note" TEXT,
    "paidBy" "PaidBy" NOT NULL DEFAULT 'CASH',
    "attachmentUrl" TEXT,
    "isAutoGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_closes" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "salesSatang" INTEGER NOT NULL DEFAULT 0,
    "foodCostSatang" INTEGER NOT NULL DEFAULT 0,
    "wageSatang" INTEGER NOT NULL DEFAULT 0,
    "rentSatang" INTEGER NOT NULL DEFAULT 0,
    "otherSatang" INTEGER NOT NULL DEFAULT 0,
    "vatSatang" INTEGER NOT NULL DEFAULT 0,
    "profitSatang" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "closedByStaffId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_sequences" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unitCostSatang" INTEGER,
    "refDocId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prep_batches" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ingredientsUsed" JSONB NOT NULL,
    "yieldQty" DECIMAL(12,4) NOT NULL,
    "yieldUnit" TEXT NOT NULL,
    "madeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "madeByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingCashSatang" INTEGER NOT NULL DEFAULT 0,
    "countedCashSatang" INTEGER,
    "expectedCashSatang" INTEGER,
    "varianceSatang" INTEGER,
    "note" TEXT,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branches_branchCode_key" ON "branches"("branchCode");

-- CreateIndex
CREATE INDEX "branches_isActive_idx" ON "branches"("isActive");

-- CreateIndex
CREATE INDEX "staff_branchId_status_idx" ON "staff"("branchId", "status");

-- CreateIndex
CREATE INDEX "staff_branchId_workPermitExpiry_idx" ON "staff"("branchId", "workPermitExpiry");

-- CreateIndex
CREATE UNIQUE INDEX "staff_branchId_pinHash_key" ON "staff"("branchId", "pinHash");

-- CreateIndex
CREATE INDEX "staff_deductions_branchId_date_idx" ON "staff_deductions"("branchId", "date");

-- CreateIndex
CREATE INDEX "staff_deductions_staffId_date_idx" ON "staff_deductions"("staffId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_expenseId_key" ON "payrolls"("expenseId");

-- CreateIndex
CREATE INDEX "payrolls_branchId_yearMonth_idx" ON "payrolls"("branchId", "yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_branchId_yearMonth_key" ON "payrolls"("branchId", "yearMonth");

-- CreateIndex
CREATE INDEX "payroll_lines_branchId_staffId_idx" ON "payroll_lines"("branchId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_payrollId_staffId_key" ON "payroll_lines"("payrollId", "staffId");

-- CreateIndex
CREATE INDEX "dining_tables_branchId_zone_sortOrder_idx" ON "dining_tables"("branchId", "zone", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_branchId_name_key" ON "dining_tables"("branchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "table_sessions_qrToken_key" ON "table_sessions"("qrToken");

-- CreateIndex
CREATE INDEX "table_sessions_branchId_closedAt_idx" ON "table_sessions"("branchId", "closedAt");

-- CreateIndex
CREATE INDEX "table_sessions_tableId_closedAt_idx" ON "table_sessions"("tableId", "closedAt");

-- CreateIndex
CREATE INDEX "menu_categories_branchId_sortOrder_idx" ON "menu_categories"("branchId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "menu_categories_branchId_name_key" ON "menu_categories"("branchId", "name");

-- CreateIndex
CREATE INDEX "menu_items_branchId_categoryId_sortOrder_idx" ON "menu_items"("branchId", "categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "menu_items_branchId_isAvailable_idx" ON "menu_items"("branchId", "isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_branchId_name_key" ON "menu_items"("branchId", "name");

-- CreateIndex
CREATE INDEX "modifier_groups_branchId_sortOrder_idx" ON "modifier_groups"("branchId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_groups_branchId_name_key" ON "modifier_groups"("branchId", "name");

-- CreateIndex
CREATE INDEX "modifiers_branchId_groupId_sortOrder_idx" ON "modifiers"("branchId", "groupId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "modifiers_groupId_name_key" ON "modifiers"("groupId", "name");

-- CreateIndex
CREATE INDEX "menu_item_groups_branchId_idx" ON "menu_item_groups"("branchId");

-- CreateIndex
CREATE INDEX "ingredients_branchId_isActive_idx" ON "ingredients"("branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_branchId_name_key" ON "ingredients"("branchId", "name");

-- CreateIndex
CREATE INDEX "recipe_lines_branchId_idx" ON "recipe_lines"("branchId");

-- CreateIndex
CREATE INDEX "recipe_lines_menuItemId_idx" ON "recipe_lines"("menuItemId");

-- CreateIndex
CREATE INDEX "recipe_lines_modifierId_idx" ON "recipe_lines"("modifierId");

-- CreateIndex
CREATE INDEX "orders_branchId_businessDate_status_idx" ON "orders"("branchId", "businessDate", "status");

-- CreateIndex
CREATE INDEX "orders_branchId_status_idx" ON "orders"("branchId", "status");

-- CreateIndex
CREATE INDEX "orders_sessionId_idx" ON "orders"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_branchId_orderNo_key" ON "orders"("branchId", "orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "orders_branchId_taxInvoiceNo_key" ON "orders"("branchId", "taxInvoiceNo");

-- CreateIndex
CREATE INDEX "order_lines_orderId_idx" ON "order_lines"("orderId");

-- CreateIndex
CREATE INDEX "order_lines_branchId_firedAt_idx" ON "order_lines"("branchId", "firedAt");

-- CreateIndex
CREATE INDEX "order_lines_branchId_menuItemId_idx" ON "order_lines"("branchId", "menuItemId");

-- CreateIndex
CREATE INDEX "order_line_modifiers_orderLineId_idx" ON "order_line_modifiers"("orderLineId");

-- CreateIndex
CREATE INDEX "order_line_modifiers_branchId_idx" ON "order_line_modifiers"("branchId");

-- CreateIndex
CREATE INDEX "kitchen_tickets_branchId_station_status_idx" ON "kitchen_tickets"("branchId", "station", "status");

-- CreateIndex
CREATE INDEX "kitchen_tickets_branchId_firedAt_idx" ON "kitchen_tickets"("branchId", "firedAt");

-- CreateIndex
CREATE INDEX "ticket_lines_ticketId_idx" ON "ticket_lines"("ticketId");

-- CreateIndex
CREATE INDEX "ticket_lines_branchId_idx" ON "ticket_lines"("branchId");

-- CreateIndex
CREATE INDEX "payments_branchId_paidAt_idx" ON "payments"("branchId", "paidAt");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "void_logs_branchId_createdAt_idx" ON "void_logs"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "void_logs_orderId_idx" ON "void_logs"("orderId");

-- CreateIndex
CREATE INDEX "audit_logs_branchId_createdAt_idx" ON "audit_logs"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_branchId_entityType_entityId_idx" ON "audit_logs"("branchId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "expenses_branchId_date_idx" ON "expenses"("branchId", "date");

-- CreateIndex
CREATE INDEX "expenses_branchId_category_date_idx" ON "expenses"("branchId", "category", "date");

-- CreateIndex
CREATE INDEX "monthly_closes_branchId_yearMonth_idx" ON "monthly_closes"("branchId", "yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_closes_branchId_yearMonth_key" ON "monthly_closes"("branchId", "yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "doc_sequences_branchId_docType_year_key" ON "doc_sequences"("branchId", "docType", "year");

-- CreateIndex
CREATE INDEX "stock_movements_branchId_ingredientId_createdAt_idx" ON "stock_movements"("branchId", "ingredientId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_branchId_type_createdAt_idx" ON "stock_movements"("branchId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "prep_batches_branchId_expiresAt_idx" ON "prep_batches"("branchId", "expiresAt");

-- CreateIndex
CREATE INDEX "shifts_branchId_openedAt_idx" ON "shifts"("branchId", "openedAt");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_deductions" ADD CONSTRAINT "staff_deductions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_deductions" ADD CONSTRAINT "staff_deductions_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payrollId_fkey" FOREIGN KEY ("payrollId") REFERENCES "payrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "dining_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_groups" ADD CONSTRAINT "menu_item_groups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_groups" ADD CONSTRAINT "menu_item_groups_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_groups" ADD CONSTRAINT "menu_item_groups_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "modifiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "dining_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "modifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "kitchen_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "void_logs" ADD CONSTRAINT "void_logs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "void_logs" ADD CONSTRAINT "void_logs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "void_logs" ADD CONSTRAINT "void_logs_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "void_logs" ADD CONSTRAINT "void_logs_requestedByStaffId_fkey" FOREIGN KEY ("requestedByStaffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "void_logs" ADD CONSTRAINT "void_logs_approvedByStaffId_fkey" FOREIGN KEY ("approvedByStaffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_closes" ADD CONSTRAINT "monthly_closes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_sequences" ADD CONSTRAINT "doc_sequences_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_madeByStaffId_fkey" FOREIGN KEY ("madeByStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

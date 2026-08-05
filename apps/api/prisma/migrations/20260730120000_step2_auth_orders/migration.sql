-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "promptPayId" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "receiptNo" TEXT;

-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "pinLockedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "orders_branchId_receiptNo_key" ON "orders"("branchId", "receiptNo");


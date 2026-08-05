-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customerAddress" TEXT,
ADD COLUMN     "customerBranchLabel" TEXT,
ADD COLUMN     "taxInvoiceIssuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "creditNoteNo" TEXT NOT NULL,
    "taxInvoiceNo" TEXT,
    "receiptNo" TEXT,
    "businessDate" DATE NOT NULL,
    "subtotalExVatSatang" INTEGER NOT NULL,
    "vatAmountSatang" INTEGER NOT NULL,
    "vatRateBpSnapshot" INTEGER NOT NULL DEFAULT 0,
    "totalSatang" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "issuedByStaffId" TEXT,
    "approvedByStaffId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_orderId_key" ON "credit_notes"("orderId");

-- CreateIndex
CREATE INDEX "credit_notes_branchId_businessDate_idx" ON "credit_notes"("branchId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_branchId_creditNoteNo_key" ON "credit_notes"("branchId", "creditNoteNo");

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issuedByStaffId_fkey" FOREIGN KEY ("issuedByStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_approvedByStaffId_fkey" FOREIGN KEY ("approvedByStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

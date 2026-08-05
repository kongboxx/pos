-- CreateEnum
CREATE TYPE "PrintJobType" AS ENUM ('TEST_RECEIPT', 'RECEIPT', 'KITCHEN_TICKET', 'DRAWER_KICK');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "station" TEXT NOT NULL DEFAULT 'counter',
    "type" "PrintJobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "printedAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_jobs_branchId_station_status_availableAt_idx" ON "print_jobs"("branchId", "station", "status", "availableAt");

-- CreateIndex
CREATE INDEX "print_jobs_branchId_createdAt_idx" ON "print_jobs"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

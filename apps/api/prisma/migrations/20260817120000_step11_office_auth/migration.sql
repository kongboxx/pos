-- CreateEnum
CREATE TYPE "SessionSurface" AS ENUM ('POS', 'OFFICE');

-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "email" TEXT,
ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginLockedUntil" TIMESTAMP(3),
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "totpSecret" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "surface" "SessionSurface" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_staffId_revokedAt_idx" ON "sessions"("staffId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "staff_email_key" ON "staff"("email");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

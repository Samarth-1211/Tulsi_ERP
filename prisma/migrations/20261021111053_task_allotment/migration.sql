-- CreateEnum
CREATE TYPE "AllotmentEligibility" AS ENUM ('NOT_CONNECTED', 'CONTACTED_OPEN');

-- CreateEnum
CREATE TYPE "AllotmentPriority" AS ENUM ('SMART', 'HIGHEST_VALUE', 'LONGEST_SILENT', 'NEWEST_ENQUIRY', 'OLDEST_ENQUIRY', 'FEWEST_ATTEMPTS', 'MOST_ENGAGED');

-- CreateEnum
CREATE TYPE "AllotmentStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED', 'EXPIRED');

-- AlterTable
ALTER TABLE "OrgSettings" ADD COLUMN     "autoAllotBatchSize" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "autoAllotEligibility" "AllotmentEligibility" NOT NULL DEFAULT 'NOT_CONNECTED',
ADD COLUMN     "autoAllotEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoAllotIncludeLost" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoAllotLookbackDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "autoAllotMinValue" DECIMAL(12,2),
ADD COLUMN     "autoAllotPriority" "AllotmentPriority" NOT NULL DEFAULT 'SMART',
ADD COLUMN     "autoAllotRestDays" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "autoAllotThenBy" "AllotmentPriority" NOT NULL DEFAULT 'LONGEST_SILENT';

-- CreateTable
CREATE TABLE "task_allotments" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "allotDate" DATE NOT NULL,
    "rank" INTEGER NOT NULL,
    "status" "AllotmentStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_allotments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_allotments_orgId_allotDate_idx" ON "task_allotments"("orgId", "allotDate");

-- CreateIndex
CREATE INDEX "task_allotments_userId_allotDate_idx" ON "task_allotments"("userId", "allotDate");

-- CreateIndex
CREATE INDEX "task_allotments_leadId_status_idx" ON "task_allotments"("leadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "task_allotments_userId_leadId_allotDate_key" ON "task_allotments"("userId", "leadId", "allotDate");

-- AddForeignKey
ALTER TABLE "task_allotments" ADD CONSTRAINT "task_allotments_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_allotments" ADD CONSTRAINT "task_allotments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_allotments" ADD CONSTRAINT "task_allotments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

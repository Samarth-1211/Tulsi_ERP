-- AlterTable
ALTER TABLE "OrgSettings" ADD COLUMN     "emailNotificationTypes" "NotificationType"[] DEFAULT ARRAY['LEAD_ASSIGNED', 'TASK_ASSIGNED', 'TASK_REMINDER', 'TASK_ALLOTTED']::"NotificationType"[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailNotifications" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "emailedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "notifications_emailedAt_createdAt_idx" ON "notifications"("emailedAt", "createdAt");

-- Notifications from before email existed are history, not news: never email them.
UPDATE "notifications" SET "emailedAt" = NOW() WHERE "emailedAt" IS NULL;

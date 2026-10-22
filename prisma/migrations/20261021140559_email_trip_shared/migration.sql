-- AlterTable
ALTER TABLE "OrgSettings" ALTER COLUMN "emailNotificationTypes" SET DEFAULT ARRAY['LEAD_ASSIGNED', 'TASK_ASSIGNED', 'TASK_REMINDER', 'TASK_ALLOTTED', 'TRIP_SHARED']::"NotificationType"[];

-- Orgs keep their picks; "trip shared" is added like the other defaults (the picker shipped the same day).
UPDATE "OrgSettings" SET "emailNotificationTypes" = array_append("emailNotificationTypes", 'TRIP_SHARED'::"NotificationType")
WHERE NOT ('TRIP_SHARED'::"NotificationType" = ANY("emailNotificationTypes"));

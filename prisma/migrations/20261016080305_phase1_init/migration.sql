-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'CALLER', 'DELIVERY_PARTNER', 'WAREHOUSE_STAFF');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WHATSAPP_CTWA', 'WHATSAPP_ORGANIC', 'META_LEAD_FORM', 'MANUAL', 'WALK_IN', 'REFERRAL', 'CSV_IMPORT', 'WEBSITE', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('DEALER', 'RETAILER', 'CONTRACTOR', 'CARPENTER', 'BUILDER', 'INTERIOR_DESIGNER', 'HOMEOWNER', 'OTHER');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('WHATSAPP', 'META_LEAD_FORM', 'WEBHOOK_GENERIC');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ERROR');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED');

-- CreateEnum
CREATE TYPE "AllocationMode" AS ENUM ('ROUND_ROBIN', 'MANUAL');

-- CreateEnum
CREATE TYPE "AssignmentMethod" AS ENUM ('AUTO_ROUND_ROBIN', 'MANUAL', 'SELF');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CREATED', 'ASSIGNED', 'REASSIGNED', 'STATUS_CHANGED', 'UPDATED', 'NOTE', 'CALL', 'WHATSAPP', 'FOLLOW_UP', 'RE_ENQUIRY', 'DELETED');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'DONE', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('CHECKED_IN', 'CHECKED_OUT', 'ABSENT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TASK_REMINDER', 'TASK_ASSIGNED', 'GENERIC', 'LEAD_CAPTURED', 'LEAD_ASSIGNED', 'LEAD_UPDATED', 'LEAD_DELETED');

-- CreateEnum
CREATE TYPE "UserAuditAction" AS ENUM ('ADMIN_CREATED', 'ADMIN_DELETED', 'ADMIN_DEACTIVATED', 'ADMIN_REACTIVATED', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "OrganizationAuditAction" AS ENUM ('ORG_CREATED', 'ORG_UPDATED', 'ORG_SUSPENDED', 'ORG_REACTIVATED', 'ORG_ARCHIVED');

-- CreateEnum
CREATE TYPE "VerificationTokenType" AS ENUM ('ORG_ADMIN_VERIFY', 'USER_VERIFY');

-- CreateEnum
CREATE TYPE "EmployeeActivityType" AS ENUM ('CALL', 'WHATSAPP', 'MEETING', 'SITE_VISIT', 'TRAVEL', 'FOLLOW_UP', 'NOTE', 'DOCUMENTATION', 'PAYMENT', 'MARKETING', 'REPORTING', 'INTERNAL_MEETING', 'TRAINING', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('FOLLOW_UP', 'SITE_VISIT', 'CALL', 'MEETING', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('NORMAL', 'URGENT', 'VERY_URGENT', 'TOP_PRIORITY');

-- CreateEnum
CREATE TYPE "LeadImportStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadImportAllocationMode" AS ENUM ('ALL_TEAMS', 'MANAGERS_AND_TEAMS', 'MANAGERS_ONLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TargetMetric" AS ENUM ('CALLS', 'CONVERSIONS');

-- CreateEnum
CREATE TYPE "WhatsAppIntegrationStatus" AS ENUM ('PENDING', 'CONNECTED', 'FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WhatsAppMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppWebhookEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industryType" TEXT NOT NULL DEFAULT 'PLYWOOD_WHOLESALE',
    "gstin" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "allocationMode" "AllocationMode" NOT NULL DEFAULT 'ROUND_ROBIN',
    "allocationTargetRole" "Role" NOT NULL DEFAULT 'MANAGER',
    "allocateOnlyCheckedIn" BOOLEAN NOT NULL DEFAULT false,
    "checkoutSummaryMinLength" INTEGER NOT NULL DEFAULT 20,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "autoReallocateLostLeads" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "employeeCode" TEXT,
    "managerId" TEXT,
    "createdById" TEXT,
    "lastLeadAssignedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "isTemporaryPassword" BOOLEAN NOT NULL DEFAULT false,
    "photoUrl" TEXT,
    "leadsSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkOutAt" TIMESTAMP(3),
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "summary" TEXT,
    "workedMinutes" INTEGER,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'CHECKED_IN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "IntegrationType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "webhookToken" TEXT NOT NULL,
    "verifyToken" TEXT,
    "externalAccountId" TEXT,
    "config" JSONB,
    "encryptedSecrets" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "integrationId" TEXT,
    "source" "IntegrationType" NOT NULL,
    "externalId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "leadId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "altPhone" TEXT,
    "email" TEXT,
    "city" TEXT,
    "pincode" TEXT,
    "address" TEXT,
    "customerType" "CustomerType",
    "requirementNotes" TEXT,
    "estimatedValue" DECIMAL(12,2),
    "source" "LeadSource" NOT NULL,
    "integrationId" TEXT,
    "sourceLeadId" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "lostReason" TEXT,
    "convertedAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "nextFollowUpAt" TIMESTAMP(3),
    "customFields" JSONB,
    "rawPayload" JSONB,
    "previousLeadId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adSourceId" TEXT,
    "importBatchId" TEXT,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAdAttribution" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'META',
    "campaignId" TEXT,
    "campaignName" TEXT,
    "adsetId" TEXT,
    "adsetName" TEXT,
    "adId" TEXT,
    "adName" TEXT,
    "formId" TEXT,
    "formName" TEXT,
    "pageId" TEXT,
    "ctwaClid" TEXT,
    "sourceType" TEXT,
    "sourceUrl" TEXT,
    "headline" TEXT,
    "body" TEXT,
    "mediaType" TEXT,
    "imageUrl" TEXT,
    "videoUrl" TEXT,
    "thumbnailUrl" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAdAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT NOT NULL,
    "method" "AssignmentMethod" NOT NULL,
    "assignedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadActivityLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "ActivityType" NOT NULL,
    "message" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "outcome" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'TASK_REMINDER',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "taskId" TEXT,
    "leadId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_audit_logs" (
    "id" TEXT NOT NULL,
    "action" "UserAuditAction" NOT NULL,
    "performedById" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_audit_logs" (
    "id" TEXT NOT NULL,
    "action" "OrganizationAuditAction" NOT NULL,
    "orgId" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_integrations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT,
    "businessName" TEXT,
    "businessManagerId" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "appSecretEncrypted" TEXT,
    "webhookSlug" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "status" "WhatsAppIntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "waMessageId" TEXT,
    "direction" "WhatsAppMessageDirection" NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "textBody" TEXT,
    "mediaId" TEXT,
    "mediaMimeType" TEXT,
    "mediaStorageKey" TEXT,
    "mediaFileName" TEXT,
    "mediaSize" INTEGER,
    "mediaError" TEXT,
    "phoneNumberId" TEXT,
    "rawPayload" JSONB,
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'SENT',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "sentByUserId" TEXT,
    "waTimestamp" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_webhook_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureValid" BOOLEAN,
    "object" TEXT,
    "phoneNumberId" TEXT,
    "eventType" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "processingStatus" "WhatsAppWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "whatsapp_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_ad_sources" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'ad',
    "headline" TEXT,
    "body" TEXT,
    "sourceUrl" TEXT,
    "mappedById" TEXT,
    "mappedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_ad_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_thread_reads" (
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_thread_reads_pkey" PRIMARY KEY ("userId","leadId")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "type" "VerificationTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_otps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_import_batches" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "LeadImportStatus" NOT NULL DEFAULT 'PROCESSING',
    "totalRows" INTEGER NOT NULL,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB,
    "allocation" JSONB,
    "ignoredColumns" TEXT[],
    "error" TEXT,
    "fileStorageKey" TEXT,
    "fileMimeType" TEXT,
    "fileSizeBytes" INTEGER,
    "allocationMode" "LeadImportAllocationMode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "lead_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_import_collaborators" (
    "batchId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,

    CONSTRAINT "lead_import_collaborators_pkey" PRIMARY KEY ("batchId","managerId")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "metric" "TargetMetric" NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "setById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_activities" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EmployeeActivityType" NOT NULL,
    "description" TEXT,
    "leadId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "taskType" "TaskType",
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3),
    "leadId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_reminders" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "offsetMinutes" INTEGER NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSettings_orgId_key" ON "OrgSettings"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_orgId_role_status_idx" ON "User"("orgId", "role", "status");

-- CreateIndex
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_orgId_employeeCode_key" ON "User"("orgId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Attendance_orgId_date_idx" ON "Attendance"("orgId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_date_key" ON "Attendance"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_webhookToken_key" ON "Integration"("webhookToken");

-- CreateIndex
CREATE INDEX "Integration_orgId_type_idx" ON "Integration"("orgId", "type");

-- CreateIndex
CREATE INDEX "Integration_type_externalAccountId_idx" ON "Integration"("type", "externalAccountId");

-- CreateIndex
CREATE INDEX "WebhookEvent_orgId_status_idx" ON "WebhookEvent"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_externalId_key" ON "WebhookEvent"("source", "externalId");

-- CreateIndex
CREATE INDEX "Lead_orgId_status_idx" ON "Lead"("orgId", "status");

-- CreateIndex
CREATE INDEX "Lead_orgId_assignedToId_idx" ON "Lead"("orgId", "assignedToId");

-- CreateIndex
CREATE INDEX "Lead_orgId_phone_idx" ON "Lead"("orgId", "phone");

-- CreateIndex
CREATE INDEX "Lead_orgId_createdAt_idx" ON "Lead"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_adSourceId_idx" ON "Lead"("adSourceId");

-- CreateIndex
CREATE INDEX "Lead_importBatchId_idx" ON "Lead"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_orgId_source_sourceLeadId_key" ON "Lead"("orgId", "source", "sourceLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadAdAttribution_leadId_key" ON "LeadAdAttribution"("leadId");

-- CreateIndex
CREATE INDEX "LeadAdAttribution_adId_idx" ON "LeadAdAttribution"("adId");

-- CreateIndex
CREATE INDEX "LeadAdAttribution_campaignId_idx" ON "LeadAdAttribution"("campaignId");

-- CreateIndex
CREATE INDEX "LeadAssignment_leadId_idx" ON "LeadAssignment"("leadId");

-- CreateIndex
CREATE INDEX "LeadAssignment_orgId_toUserId_createdAt_idx" ON "LeadAssignment"("orgId", "toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadActivityLog_leadId_createdAt_idx" ON "LeadActivityLog"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "FollowUp_orgId_userId_nextFollowUpAt_idx" ON "FollowUp"("orgId", "userId", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "FollowUp_leadId_idx" ON "FollowUp"("leadId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_pushedAt_createdAt_idx" ON "notifications"("pushedAt", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_taskId_idx" ON "notifications"("taskId");

-- CreateIndex
CREATE INDEX "notifications_leadId_idx" ON "notifications"("leadId");

-- CreateIndex
CREATE INDEX "user_audit_logs_performedById_idx" ON "user_audit_logs"("performedById");

-- CreateIndex
CREATE INDEX "user_audit_logs_targetUserId_idx" ON "user_audit_logs"("targetUserId");

-- CreateIndex
CREATE INDEX "organization_audit_logs_orgId_idx" ON "organization_audit_logs"("orgId");

-- CreateIndex
CREATE INDEX "organization_audit_logs_performedById_idx" ON "organization_audit_logs"("performedById");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_integrations_orgId_key" ON "whatsapp_integrations"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_integrations_phoneNumberId_key" ON "whatsapp_integrations"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_integrations_webhookSlug_key" ON "whatsapp_integrations"("webhookSlug");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_waMessageId_key" ON "whatsapp_messages"("waMessageId");

-- CreateIndex
CREATE INDEX "whatsapp_messages_orgId_leadId_idx" ON "whatsapp_messages"("orgId", "leadId");

-- CreateIndex
CREATE INDEX "whatsapp_messages_leadId_createdAt_idx" ON "whatsapp_messages"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "whatsapp_messages_integrationId_idx" ON "whatsapp_messages"("integrationId");

-- CreateIndex
CREATE INDEX "whatsapp_webhook_events_orgId_receivedAt_idx" ON "whatsapp_webhook_events"("orgId", "receivedAt");

-- CreateIndex
CREATE INDEX "whatsapp_webhook_events_processingStatus_receivedAt_idx" ON "whatsapp_webhook_events"("processingStatus", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_ad_sources_orgId_adId_key" ON "whatsapp_ad_sources"("orgId", "adId");

-- CreateIndex
CREATE INDEX "whatsapp_thread_reads_leadId_idx" ON "whatsapp_thread_reads"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "verification_tokens_userId_idx" ON "verification_tokens"("userId");

-- CreateIndex
CREATE INDEX "verification_tokens_orgId_idx" ON "verification_tokens"("orgId");

-- CreateIndex
CREATE INDEX "password_reset_otps_userId_idx" ON "password_reset_otps"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "lead_import_batches_orgId_createdAt_idx" ON "lead_import_batches"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_import_batches_status_idx" ON "lead_import_batches"("status");

-- CreateIndex
CREATE INDEX "lead_import_collaborators_managerId_idx" ON "lead_import_collaborators"("managerId");

-- CreateIndex
CREATE INDEX "leave_requests_orgId_status_idx" ON "leave_requests"("orgId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_userId_idx" ON "leave_requests"("userId");

-- CreateIndex
CREATE INDEX "targets_orgId_periodYear_periodMonth_idx" ON "targets"("orgId", "periodYear", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "targets_userId_periodYear_periodMonth_key" ON "targets"("userId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "employee_activities_orgId_occurredAt_idx" ON "employee_activities"("orgId", "occurredAt");

-- CreateIndex
CREATE INDEX "employee_activities_userId_occurredAt_idx" ON "employee_activities"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "employee_activities_leadId_idx" ON "employee_activities"("leadId");

-- CreateIndex
CREATE INDEX "tasks_orgId_idx" ON "tasks"("orgId");

-- CreateIndex
CREATE INDEX "tasks_userId_status_dueAt_idx" ON "tasks"("userId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_createdById_userId_idx" ON "tasks"("createdById", "userId");

-- CreateIndex
CREATE INDEX "tasks_leadId_idx" ON "tasks"("leadId");

-- CreateIndex
CREATE INDEX "task_reminders_remindAt_firedAt_idx" ON "task_reminders"("remindAt", "firedAt");

-- CreateIndex
CREATE INDEX "task_reminders_taskId_idx" ON "task_reminders"("taskId");

-- AddForeignKey
ALTER TABLE "OrgSettings" ADD CONSTRAINT "OrgSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_previousLeadId_fkey" FOREIGN KEY ("previousLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_adSourceId_fkey" FOREIGN KEY ("adSourceId") REFERENCES "whatsapp_ad_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "lead_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAdAttribution" ADD CONSTRAINT "LeadAdAttribution_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivityLog" ADD CONSTRAINT "LeadActivityLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivityLog" ADD CONSTRAINT "LeadActivityLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivityLog" ADD CONSTRAINT "LeadActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_audit_logs" ADD CONSTRAINT "user_audit_logs_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_audit_logs" ADD CONSTRAINT "user_audit_logs_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_audit_logs" ADD CONSTRAINT "organization_audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_audit_logs" ADD CONSTRAINT "organization_audit_logs_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_integrations" ADD CONSTRAINT "whatsapp_integrations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "whatsapp_integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "whatsapp_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_ad_sources" ADD CONSTRAINT "whatsapp_ad_sources_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_ad_sources" ADD CONSTRAINT "whatsapp_ad_sources_mappedById_fkey" FOREIGN KEY ("mappedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_thread_reads" ADD CONSTRAINT "whatsapp_thread_reads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_thread_reads" ADD CONSTRAINT "whatsapp_thread_reads_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_otps" ADD CONSTRAINT "password_reset_otps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_import_collaborators" ADD CONSTRAINT "lead_import_collaborators_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "lead_import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_import_collaborators" ADD CONSTRAINT "lead_import_collaborators_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_activities" ADD CONSTRAINT "employee_activities_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_activities" ADD CONSTRAINT "employee_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_activities" ADD CONSTRAINT "employee_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

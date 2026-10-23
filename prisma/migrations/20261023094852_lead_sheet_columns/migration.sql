-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "enquiredAt" TIMESTAMP(3),
ADD COLUMN     "feedback" TEXT,
ADD COLUMN     "requirementQty" TEXT;

-- CreateIndex
CREATE INDEX "Lead_orgId_enquiredAt_idx" ON "Lead"("orgId", "enquiredAt");

-- CreateIndex
CREATE INDEX "Lead_orgId_buyingFor_idx" ON "Lead"("orgId", "buyingFor");

-- CreateIndex
CREATE INDEX "Lead_orgId_requirementQty_idx" ON "Lead"("orgId", "requirementQty");

-- Backfill: leads that came in before these columns existed kept the answers in
-- customFields under the sheet's header — move them to the columns.
UPDATE "Lead"
SET "requirementQty" = "customFields" ->> '_आपकी_approx._requirement_कितनी_है?',
    "customFields" = NULLIF("customFields" - '_आपकी_approx._requirement_कितनी_है?', '{}'::jsonb)
WHERE "customFields" ? '_आपकी_approx._requirement_कितनी_है?';

UPDATE "Lead"
SET "feedback" = "customFields" ->> 'Feedback',
    "customFields" = NULLIF("customFields" - 'Feedback', '{}'::jsonb)
WHERE "customFields" ? 'Feedback' AND "feedback" IS NULL;

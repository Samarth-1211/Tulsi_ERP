-- One field each: Customer type → Buying For, Approx. Requirement → Requirement,
-- Remarks → Feedback, and one date (the enquiry date becomes the lead's date).

-- Customer type → Buying For, as readable text, where Buying For is empty.
UPDATE "Lead"
SET "buyingFor" = CASE "customerType"
    WHEN 'DEALER' THEN 'Dealer'
    WHEN 'RETAILER' THEN 'Retailer'
    WHEN 'CONTRACTOR' THEN 'Contractor'
    WHEN 'CARPENTER' THEN 'Carpenter'
    WHEN 'BUILDER' THEN 'Builder'
    WHEN 'INTERIOR_DESIGNER' THEN 'Interior designer'
    WHEN 'HOMEOWNER' THEN 'Homeowner'
    ELSE 'Other'
  END
WHERE "customerType" IS NOT NULL AND COALESCE("buyingFor", '') = '';

-- Approx. Requirement → Requirement (joined when both are filled).
UPDATE "Lead"
SET "requirementNotes" = CASE
    WHEN COALESCE("requirementNotes", '') = '' THEN "requirementQty"
    ELSE "requirementNotes" || ' · ' || "requirementQty"
  END
WHERE COALESCE("requirementQty", '') <> '';

-- Remarks (kept in customFields by Excel uploads) → Feedback.
UPDATE "Lead"
SET "feedback" = CASE
    WHEN COALESCE("feedback", '') = '' THEN "customFields" ->> 'remarks'
    ELSE "feedback" || ' · ' || ("customFields" ->> 'remarks')
  END,
  "customFields" = NULLIF("customFields" - 'remarks', '{}'::jsonb)
WHERE "customFields" ? 'remarks';

-- One date: a lead's date is when it came in — the enquiry date where a sheet gave an earlier one.
UPDATE "Lead" SET "createdAt" = "enquiredAt" WHERE "enquiredAt" IS NOT NULL AND "enquiredAt" < "createdAt";

-- DropIndex
DROP INDEX "Lead_orgId_enquiredAt_idx";

-- DropIndex
DROP INDEX "Lead_orgId_requirementQty_idx";

-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "customerType",
DROP COLUMN "enquiredAt",
DROP COLUMN "requirementQty";

-- DropEnum
DROP TYPE "CustomerType";

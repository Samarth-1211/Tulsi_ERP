-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "buyingFor" TEXT;

-- Backfill: leads that came in before the column existed kept the Meta question's
-- answer in customFields under its key — move it to the column.
UPDATE "Lead"
SET "buyingFor" = "customFields" ->> 'आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_',
    "customFields" = NULLIF("customFields" - 'आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_', '{}'::jsonb)
WHERE "customFields" ? 'आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_';

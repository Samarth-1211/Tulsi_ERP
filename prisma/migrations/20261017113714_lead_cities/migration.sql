-- CreateTable
CREATE TABLE "cities" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cities_orgId_key_key" ON "cities"("orgId", "key");

-- AddForeignKey
ALTER TABLE "cities" ADD CONSTRAINT "cities_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one row per distinct city already on a lead (first-seen spelling wins).
INSERT INTO "cities" ("id", "orgId", "name", "key")
SELECT gen_random_uuid()::text, "orgId", "name", "key"
FROM (
    SELECT DISTINCT ON ("orgId", lower(btrim("city")))
           "orgId", btrim("city") AS "name", lower(btrim("city")) AS "key"
    FROM "Lead"
    WHERE "city" IS NOT NULL AND btrim("city") <> ''
    ORDER BY "orgId", lower(btrim("city")), "createdAt"
) AS c;

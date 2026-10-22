-- CreateEnum
CREATE TYPE "CityGeoStatus" AS ENUM ('PENDING', 'FOUND', 'NOT_FOUND', 'MANUAL');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripLeadFilter" AS ENUM ('OPEN', 'CONVERTED', 'ALL');

-- AlterTable
ALTER TABLE "cities" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "geoAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "geoStatus" "CityGeoStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "geocodedAt" TIMESTAMP(3),
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION,
ADD COLUMN     "state" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "tripId" TEXT;

-- CreateTable
CREATE TABLE "trips" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tripDate" DATE,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "stops" JSONB NOT NULL,
    "corridorKm" INTEGER NOT NULL DEFAULT 20,
    "leadFilter" "TripLeadFilter" NOT NULL DEFAULT 'OPEN',
    "cityIds" TEXT[],
    "distanceKm" DOUBLE PRECISION,
    "durationMin" DOUBLE PRECISION,
    "routeSource" TEXT,
    "geometry" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_members" (
    "tripId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_members_pkey" PRIMARY KEY ("tripId","userId")
);

-- CreateIndex
CREATE INDEX "trips_orgId_createdById_idx" ON "trips"("orgId", "createdById");

-- CreateIndex
CREATE INDEX "trip_members_userId_idx" ON "trip_members"("userId");

-- CreateIndex
CREATE INDEX "cities_geoStatus_idx" ON "cities"("geoStatus");

-- CreateIndex
CREATE INDEX "tasks_tripId_idx" ON "tasks"("tripId");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "VehicleType" AS ENUM ('TWO_WHEELER', 'FOUR_WHEELER', 'OTHER');
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "VehicleProviderType" AS ENUM (
  'INDEPENDENT_WASHER',
  'SOCIETY_VENDOR',
  'MARKETPLACE_VENDOR'
);

CREATE TABLE "Vehicle" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "type" "VehicleType" NOT NULL,
  "registrationNumber" VARCHAR(32) NOT NULL,
  "registrationNumberNormalized" VARCHAR(32) NOT NULL,
  "make" VARCHAR(80),
  "model" VARCHAR(80),
  "lengthCm" DOUBLE PRECISION,
  "widthCm" DOUBLE PRECISION,
  "heightCm" DOUBLE PRECISION,
  "photoUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "locationName" VARCHAR(100),
  "address" VARCHAR(240),
  "city" VARCHAR(100),
  "postalCode" VARCHAR(24),
  "providerType" "VehicleProviderType",
  "providerName" VARCHAR(120),
  "assignedWasherName" VARCHAR(120),
  "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Vehicle_registrationNumberNormalized_check"
    CHECK (length("registrationNumberNormalized") >= 3),
  CONSTRAINT "Vehicle_dimensions_positive_check"
    CHECK (
      ("lengthCm" IS NULL OR "lengthCm" > 0) AND
      ("widthCm" IS NULL OR "widthCm" > 0) AND
      ("heightCm" IS NULL OR "heightCm" > 0)
    ),
  CONSTRAINT "Vehicle_assignedWasher_provider_check"
    CHECK (
      "assignedWasherName" IS NULL OR
      "providerType" IS NOT DISTINCT FROM 'SOCIETY_VENDOR'
    )
);

CREATE UNIQUE INDEX "Vehicle_registrationNumberNormalized_key"
  ON "Vehicle"("registrationNumberNormalized");
CREATE UNIQUE INDEX "Vehicle_id_accountId_key" ON "Vehicle"("id", "accountId");
CREATE INDEX "Vehicle_accountId_status_createdAt_idx"
  ON "Vehicle"("accountId", "status", "createdAt");

ALTER TABLE "Vehicle"
  ADD CONSTRAINT "Vehicle_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

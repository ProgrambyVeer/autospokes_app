-- CreateEnum
CREATE TYPE "MarketplaceCategory" AS ENUM ('GARAGE', 'DETAILING_CENTRE', 'MOBILE_DETAILER', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketplaceServiceCategory" AS ENUM ('EXTERIOR_WASH', 'INTERIOR_CLEANING', 'DETAILING', 'POLISH_AND_COATING', 'PERIODIC_SERVICE', 'REPAIR', 'TYRE_AND_WHEEL', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketplaceVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MarketplaceServiceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MarketplaceBookingStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'PROVIDER_REPORTED_COMPLETION', 'CUSTOMER_ACCEPTED', 'DISPUTED', 'SETTLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MarketplacePaymentStatus" AS ENUM ('RECORDED_UNVERIFIED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "MarketplacePaymentMethod" AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'OTHER');

-- CreateTable
CREATE TABLE "MarketplaceProfile" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "businessName" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "category" "MarketplaceCategory" NOT NULL,
    "contactPhone" VARCHAR(32) NOT NULL,
    "contactEmail" VARCHAR(254),
    "addressLine" VARCHAR(240),
    "city" VARCHAR(100),
    "postalCode" VARCHAR(24),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "serviceRadiusKm" INTEGER,
    "serviceAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supportedVehicleTypes" "VehicleType"[],
    "operatingHours" JSONB NOT NULL DEFAULT '{}',
    "logoUrl" VARCHAR(2048),
    "galleryUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verificationStatus" "MarketplaceVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MarketplaceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceService" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "category" "MarketplaceServiceCategory" NOT NULL,
    "vehicleTypes" "VehicleType"[],
    "pricePaise" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" "MarketplaceServiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "inclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "terms" VARCHAR(2000),
    "serviceAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MarketplaceService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceStaff" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "phoneNumber" VARCHAR(32),
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "available" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MarketplaceStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceBooking" (
    "id" UUID NOT NULL,
    "ownerAccountId" UUID NOT NULL,
    "vendorAccountId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "staffId" UUID,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "status" "MarketplaceBookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "vehicleRegistration" VARCHAR(32) NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "vehicleLabel" VARCHAR(160),
    "serviceName" VARCHAR(120) NOT NULL,
    "serviceDescription" VARCHAR(1000),
    "serviceCategory" "MarketplaceServiceCategory" NOT NULL,
    "serviceInclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceExclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceTerms" VARCHAR(2000),
    "servicePricePaise" INTEGER NOT NULL,
    "serviceDurationMinutes" INTEGER NOT NULL,
    "serviceVersion" INTEGER NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "windowEnd" TIMESTAMPTZ(6) NOT NULL,
    "serviceLocation" VARCHAR(240) NOT NULL,
    "accessNotes" VARCHAR(500),
    "rejectionReason" VARCHAR(500),
    "completionNotes" VARCHAR(1000),
    "completionEvidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disputeReason" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "completionReportedAt" TIMESTAMPTZ(6),
    "customerRespondedAt" TIMESTAMPTZ(6),
    "settledAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MarketplaceBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceBookingEvent" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "vendorAccountId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "fromStatus" "MarketplaceBookingStatus",
    "toStatus" "MarketplaceBookingStatus",
    "note" VARCHAR(1000),
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceBookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplacePayment" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "vendorAccountId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "method" "MarketplacePaymentMethod" NOT NULL,
    "reference" VARCHAR(120),
    "note" VARCHAR(500),
    "status" "MarketplacePaymentStatus" NOT NULL DEFAULT 'RECORDED_UNVERIFIED',
    "recordedBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplacePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceProfile_accountId_key" ON "MarketplaceProfile"("accountId");

-- CreateIndex
CREATE INDEX "MarketplaceProfile_city_idx" ON "MarketplaceProfile"("city");

-- CreateIndex
CREATE INDEX "MarketplaceService_accountId_status_createdAt_idx" ON "MarketplaceService"("accountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceService_status_category_idx" ON "MarketplaceService"("status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceService_id_accountId_key" ON "MarketplaceService"("id", "accountId");

-- CreateIndex
CREATE INDEX "MarketplaceStaff_accountId_active_idx" ON "MarketplaceStaff"("accountId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceStaff_id_accountId_key" ON "MarketplaceStaff"("id", "accountId");

-- CreateIndex
CREATE INDEX "MarketplaceBooking_vendorAccountId_status_windowStart_idx" ON "MarketplaceBooking"("vendorAccountId", "status", "windowStart");

-- CreateIndex
CREATE INDEX "MarketplaceBooking_ownerAccountId_status_createdAt_idx" ON "MarketplaceBooking"("ownerAccountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceBooking_staffId_idx" ON "MarketplaceBooking"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceBooking_ownerAccountId_idempotencyKey_key" ON "MarketplaceBooking"("ownerAccountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceBooking_id_vendorAccountId_key" ON "MarketplaceBooking"("id", "vendorAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceBooking_id_ownerAccountId_key" ON "MarketplaceBooking"("id", "ownerAccountId");

-- CreateIndex
CREATE INDEX "MarketplaceBookingEvent_bookingId_createdAt_idx" ON "MarketplaceBookingEvent"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplacePayment_bookingId_createdAt_idx" ON "MarketplacePayment"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "MarketplaceProfile" ADD CONSTRAINT "MarketplaceProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceService" ADD CONSTRAINT "MarketplaceService_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceStaff" ADD CONSTRAINT "MarketplaceStaff_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBooking" ADD CONSTRAINT "MarketplaceBooking_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBooking" ADD CONSTRAINT "MarketplaceBooking_vendorAccountId_fkey" FOREIGN KEY ("vendorAccountId") REFERENCES "Account"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBooking" ADD CONSTRAINT "MarketplaceBooking_vehicleId_ownerAccountId_fkey" FOREIGN KEY ("vehicleId", "ownerAccountId") REFERENCES "Vehicle"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBooking" ADD CONSTRAINT "MarketplaceBooking_serviceId_vendorAccountId_fkey" FOREIGN KEY ("serviceId", "vendorAccountId") REFERENCES "MarketplaceService"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBooking" ADD CONSTRAINT "MarketplaceBooking_staffId_vendorAccountId_fkey" FOREIGN KEY ("staffId", "vendorAccountId") REFERENCES "MarketplaceStaff"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBookingEvent" ADD CONSTRAINT "MarketplaceBookingEvent_bookingId_vendorAccountId_fkey" FOREIGN KEY ("bookingId", "vendorAccountId") REFERENCES "MarketplaceBooking"("id", "vendorAccountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplacePayment" ADD CONSTRAINT "MarketplacePayment_bookingId_vendorAccountId_fkey" FOREIGN KEY ("bookingId", "vendorAccountId") REFERENCES "MarketplaceBooking"("id", "vendorAccountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Integrity checks (additive; new tables only)
ALTER TABLE "MarketplaceProfile"
  ADD CONSTRAINT "MarketplaceProfile_location_pair_check"
    CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  ADD CONSTRAINT "MarketplaceProfile_coordinates_range_check"
    CHECK (("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)),
  ADD CONSTRAINT "MarketplaceProfile_radius_check"
    CHECK ("serviceRadiusKm" IS NULL OR ("serviceRadiusKm" BETWEEN 1 AND 200 AND "latitude" IS NOT NULL)),
  ADD CONSTRAINT "MarketplaceProfile_vehicle_types_check"
    CHECK (cardinality("supportedVehicleTypes") >= 1);

ALTER TABLE "MarketplaceService"
  ADD CONSTRAINT "MarketplaceService_price_check" CHECK ("pricePaise" BETWEEN 1 AND 100000000),
  ADD CONSTRAINT "MarketplaceService_duration_check" CHECK ("durationMinutes" BETWEEN 5 AND 1440),
  ADD CONSTRAINT "MarketplaceService_vehicle_types_check" CHECK (cardinality("vehicleTypes") >= 1),
  ADD CONSTRAINT "MarketplaceService_archived_check"
    CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL));

ALTER TABLE "MarketplaceBooking"
  ADD CONSTRAINT "MarketplaceBooking_window_check" CHECK ("windowEnd" > "windowStart"),
  ADD CONSTRAINT "MarketplaceBooking_price_check" CHECK ("servicePricePaise" > 0),
  ADD CONSTRAINT "MarketplaceBooking_rejection_reason_check"
    CHECK ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL),
  ADD CONSTRAINT "MarketplaceBooking_dispute_reason_check"
    CHECK ("status" <> 'DISPUTED' OR "disputeReason" IS NOT NULL),
  ADD CONSTRAINT "MarketplaceBooking_settlement_check"
    CHECK ("settledAt" IS NULL OR "status" IN ('SETTLED', 'CLOSED'));

ALTER TABLE "MarketplacePayment"
  ADD CONSTRAINT "MarketplacePayment_amount_check" CHECK ("amountPaise" > 0);

-- Agreed terms are immutable once a booking exists.
CREATE FUNCTION "marketplace_booking_snapshot_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."servicePricePaise" IS DISTINCT FROM OLD."servicePricePaise"
    OR NEW."serviceName" IS DISTINCT FROM OLD."serviceName"
    OR NEW."serviceTerms" IS DISTINCT FROM OLD."serviceTerms"
    OR NEW."serviceDurationMinutes" IS DISTINCT FROM OLD."serviceDurationMinutes"
    OR NEW."serviceInclusions" IS DISTINCT FROM OLD."serviceInclusions"
    OR NEW."serviceExclusions" IS DISTINCT FROM OLD."serviceExclusions"
    OR NEW."vehicleRegistration" IS DISTINCT FROM OLD."vehicleRegistration"
    OR NEW."ownerAccountId" IS DISTINCT FROM OLD."ownerAccountId"
    OR NEW."vendorAccountId" IS DISTINCT FROM OLD."vendorAccountId"
    OR NEW."vehicleId" IS DISTINCT FROM OLD."vehicleId"
    OR NEW."serviceId" IS DISTINCT FROM OLD."serviceId" THEN
    RAISE EXCEPTION 'Marketplace booking agreement fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketplaceBooking_snapshot_guard"
  BEFORE UPDATE ON "MarketplaceBooking"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_booking_snapshot_guard"();

-- History tables are append-only.
CREATE FUNCTION "marketplace_history_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be % (append-only history)', TG_TABLE_NAME, lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketplaceBookingEvent_append_only"
  BEFORE UPDATE OR DELETE ON "MarketplaceBookingEvent"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_history_guard"();

CREATE TRIGGER "MarketplacePayment_no_delete"
  BEFORE DELETE ON "MarketplacePayment"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_history_guard"();


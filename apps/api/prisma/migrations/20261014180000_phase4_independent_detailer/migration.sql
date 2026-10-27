-- CreateEnum
CREATE TYPE "WashActivity" AS ENUM ('EXTERIOR_WASH', 'INTERIOR_CLEANING', 'TYRE_POLISH');

-- CreateEnum
CREATE TYPE "TaskActivity" AS ENUM ('DUSTING', 'EXTERIOR_WASH', 'INTERIOR_CLEANING', 'TYRE_POLISH');

-- CreateEnum
CREATE TYPE "ScheduleFrequency" AS ENUM ('DAILY', 'SELECTED_DAYS');

-- CreateEnum
CREATE TYPE "DailyTaskStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'MISSED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DailyTaskException" AS ENUM ('VEHICLE_UNAVAILABLE', 'WASH_MISSED', 'DETAILER_ON_LEAVE');

-- CreateTable
CREATE TABLE "DetailerClient" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "phoneNumber" VARCHAR(16) NOT NULL,
    "notes" VARCHAR(500),
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DetailerClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetailerVehicle" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "type" "VehicleType" NOT NULL,
    "registrationNumber" VARCHAR(32) NOT NULL,
    "registrationNumberNormalized" VARCHAR(32) NOT NULL,
    "make" VARCHAR(80),
    "model" VARCHAR(80),
    "locationName" VARCHAR(100),
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DetailerVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WashSchedule" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "activity" "WashActivity" NOT NULL,
    "frequency" "ScheduleFrequency" NOT NULL,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WashSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyTask" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "scheduleId" UUID,
    "activity" "TaskActivity" NOT NULL,
    "taskDate" DATE NOT NULL,
    "status" "DailyTaskStatus" NOT NULL DEFAULT 'SCHEDULED',
    "exception" "DailyTaskException",
    "completedAt" TIMESTAMPTZ(6),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DailyTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DetailerClient_accountId_status_name_idx" ON "DetailerClient"("accountId", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DetailerClient_accountId_phoneNumber_key" ON "DetailerClient"("accountId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DetailerClient_id_accountId_key" ON "DetailerClient"("id", "accountId");

-- CreateIndex
CREATE INDEX "DetailerVehicle_clientId_accountId_idx" ON "DetailerVehicle"("clientId", "accountId");

-- CreateIndex
CREATE INDEX "DetailerVehicle_accountId_status_idx" ON "DetailerVehicle"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DetailerVehicle_accountId_registrationNumberNormalized_key" ON "DetailerVehicle"("accountId", "registrationNumberNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "DetailerVehicle_id_accountId_key" ON "DetailerVehicle"("id", "accountId");

-- CreateIndex
CREATE INDEX "WashSchedule_accountId_isActive_idx" ON "WashSchedule"("accountId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WashSchedule_vehicleId_activity_key" ON "WashSchedule"("vehicleId", "activity");

-- CreateIndex
CREATE UNIQUE INDEX "WashSchedule_id_accountId_key" ON "WashSchedule"("id", "accountId");

-- CreateIndex
CREATE INDEX "DailyTask_accountId_taskDate_idx" ON "DailyTask"("accountId", "taskDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTask_vehicleId_taskDate_activity_key" ON "DailyTask"("vehicleId", "taskDate", "activity");

-- AddForeignKey
ALTER TABLE "DetailerClient" ADD CONSTRAINT "DetailerClient_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetailerVehicle" ADD CONSTRAINT "DetailerVehicle_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetailerVehicle" ADD CONSTRAINT "DetailerVehicle_clientId_accountId_fkey" FOREIGN KEY ("clientId", "accountId") REFERENCES "DetailerClient"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WashSchedule" ADD CONSTRAINT "WashSchedule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WashSchedule" ADD CONSTRAINT "WashSchedule_vehicleId_accountId_fkey" FOREIGN KEY ("vehicleId", "accountId") REFERENCES "DetailerVehicle"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_vehicleId_accountId_fkey" FOREIGN KEY ("vehicleId", "accountId") REFERENCES "DetailerVehicle"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_scheduleId_accountId_fkey" FOREIGN KEY ("scheduleId", "accountId") REFERENCES "WashSchedule"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written integrity checks (not expressible in the Prisma datamodel). Additive only.
ALTER TABLE "DetailerClient"
  ADD CONSTRAINT "DetailerClient_phoneNumber_e164_check"
    CHECK ("phoneNumber" ~ '^\+91[6-9][0-9]{9}$'),
  ADD CONSTRAINT "DetailerClient_name_check"
    CHECK (length(btrim("name")) >= 1);

ALTER TABLE "DetailerVehicle"
  ADD CONSTRAINT "DetailerVehicle_registrationNumberNormalized_check"
    CHECK (
      length("registrationNumberNormalized") >= 3 AND
      "registrationNumberNormalized" = upper(
        regexp_replace(regexp_replace("registrationNumber", '[[:space:]]', '', 'g'), '-', '', 'g')
      )
    );

ALTER TABLE "WashSchedule"
  ADD CONSTRAINT "WashSchedule_weekdays_check"
    CHECK (
      "weekdays" IS NOT NULL AND
      "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7] AND
      (
        ("frequency" = 'DAILY' AND cardinality("weekdays") = 7) OR
        ("frequency" = 'SELECTED_DAYS' AND cardinality("weekdays") BETWEEN 1 AND 7)
      )
    ),
  ADD CONSTRAINT "WashSchedule_effective_dates_check"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

-- Exceptions disable normal activities, so an exception can only sit on a non-completed task.
-- A task is completed exactly when it has a completion time.
ALTER TABLE "DailyTask"
  ADD CONSTRAINT "DailyTask_exception_status_check"
    CHECK ("exception" IS NULL OR "status" IN ('MISSED', 'UNAVAILABLE')),
  ADD CONSTRAINT "DailyTask_completedAt_status_check"
    CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)),
  ADD CONSTRAINT "DailyTask_schedule_activity_check"
    CHECK (("activity" = 'DUSTING') = ("scheduleId" IS NULL));

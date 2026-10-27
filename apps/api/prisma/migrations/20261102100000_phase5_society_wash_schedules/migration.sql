CREATE TYPE "SocietyWashScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'STOPPED');

CREATE TABLE "SocietyWashSchedule" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "vehicleId" UUID NOT NULL,
  "activity" "SocietyTaskActivity" NOT NULL,
  "frequency" "ScheduleFrequency" NOT NULL,
  "weekdays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "status" "SocietyWashScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SocietyWashSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyWashSchedule_vehicleId_activity_key" UNIQUE ("vehicleId", "activity"),
  CONSTRAINT "SocietyWashSchedule_id_accountId_vehicleId_activity_key"
    UNIQUE ("id", "accountId", "vehicleId", "activity"),
  CONSTRAINT "SocietyWashSchedule_dates_check"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT "SocietyWashSchedule_weekdays_check"
    CHECK (
      cardinality("weekdays") <= 7
      AND array_position("weekdays", NULL) IS NULL
      AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
      AND (
        ("frequency" = 'DAILY' AND cardinality("weekdays") = 7)
        OR ("frequency" = 'SELECTED_DAYS' AND cardinality("weekdays") > 0)
      )
    ),
  CONSTRAINT "SocietyWashSchedule_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyWashSchedule_societyId_accountId_fkey"
    FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyWashSchedule_vehicleId_accountId_societyId_fkey"
    FOREIGN KEY ("vehicleId", "accountId", "societyId")
    REFERENCES "SocietyVehicle"("id", "accountId", "societyId") ON DELETE NO ACTION ON UPDATE CASCADE
);

ALTER TABLE "SocietyWashTask"
  ADD COLUMN "scheduleId" UUID;

ALTER TABLE "SocietyWashTask"
  ADD CONSTRAINT "SocietyWashTask_scheduleId_accountId_vehicleId_activity_fkey"
  FOREIGN KEY ("scheduleId", "accountId", "vehicleId", "activity")
  REFERENCES "SocietyWashSchedule"("id", "accountId", "vehicleId", "activity")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "SocietyWashSchedule_accountId_societyId_vehicleId_status_idx"
  ON "SocietyWashSchedule"("accountId", "societyId", "vehicleId", "status");
CREATE INDEX "SocietyWashSchedule_accountId_status_effectiveFrom_effectiveTo_idx"
  ON "SocietyWashSchedule"("accountId", "status", "effectiveFrom", "effectiveTo");

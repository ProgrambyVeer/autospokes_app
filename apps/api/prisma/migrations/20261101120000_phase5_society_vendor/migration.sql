-- Additive Society Vendor data model. This migration deliberately leaves
-- Owner Vehicle and Independent Detailer tables unchanged.

CREATE TYPE "SocietyStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "SocietyWasherStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "SocietyAttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LEAVE');
CREATE TYPE "SocietyTaskActivity" AS ENUM ('WASH', 'INTERIOR_CLEANING', 'TYRE_POLISH');
CREATE TYPE "SocietyTaskStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'MISSED', 'UNAVAILABLE');
CREATE TYPE "SocietyInvoiceStatus" AS ENUM ('ISSUED', 'VOID');
CREATE TYPE "SocietyPaymentMethod" AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'OTHER');
CREATE TYPE "SocietyDeductionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "SocietyExtraWorkStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "Society" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "address" VARCHAR(240),
  "status" "SocietyStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Society_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Society_id_accountId_key" UNIQUE ("id", "accountId"),
  CONSTRAINT "Society_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SocietyResident" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "phoneNumber" VARCHAR(16) NOT NULL,
  "unit" VARCHAR(40),
  "email" VARCHAR(254),
  "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SocietyResident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyResident_id_accountId_key" UNIQUE ("id", "accountId"),
  CONSTRAINT "SocietyResident_id_societyId_accountId_key" UNIQUE ("id", "societyId", "accountId"),
  CONSTRAINT "SocietyResident_societyId_accountId_phoneNumber_key" UNIQUE ("societyId", "accountId", "phoneNumber"),
  CONSTRAINT "SocietyResident_phoneNumber_e164_check" CHECK ("phoneNumber" ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT "SocietyResident_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyResident_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyWasher" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "phoneNumber" VARCHAR(16) NOT NULL,
  "ratePerTaskPaise" INTEGER NOT NULL DEFAULT 0,
  "status" "SocietyWasherStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SocietyWasher_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyWasher_id_societyId_accountId_key" UNIQUE ("id", "societyId", "accountId"),
  CONSTRAINT "SocietyWasher_societyId_accountId_phoneNumber_key" UNIQUE ("societyId", "accountId", "phoneNumber"),
  CONSTRAINT "SocietyWasher_phoneNumber_e164_check" CHECK ("phoneNumber" ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT "SocietyWasher_ratePerTaskPaise_check" CHECK ("ratePerTaskPaise" >= 0),
  CONSTRAINT "SocietyWasher_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyWasher_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyVehicle" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "residentId" UUID NOT NULL,
  "type" "VehicleType" NOT NULL,
  "registrationNumber" VARCHAR(32) NOT NULL,
  "registrationNumberNormalized" VARCHAR(32) NOT NULL,
  "monthlyRatePaise" INTEGER NOT NULL,
  "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SocietyVehicle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyVehicle_id_accountId_societyId_key" UNIQUE ("id", "accountId", "societyId"),
  CONSTRAINT "SocietyVehicle_id_residentId_societyId_accountId_key" UNIQUE ("id", "residentId", "societyId", "accountId"),
  CONSTRAINT "SocietyVehicle_accountId_registrationNumberNormalized_key" UNIQUE ("accountId", "registrationNumberNormalized"),
  CONSTRAINT "SocietyVehicle_registrationNormalized_check" CHECK (
    "registrationNumberNormalized" = upper(regexp_replace("registrationNumber", '[[:space:]-]+', '', 'g'))
  ),
  CONSTRAINT "SocietyVehicle_monthlyRatePaise_check" CHECK ("monthlyRatePaise" >= 0),
  CONSTRAINT "SocietyVehicle_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyVehicle_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyVehicle_residentId_societyId_accountId_fkey" FOREIGN KEY ("residentId", "societyId", "accountId") REFERENCES "SocietyResident"("id", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyWasherAssignment" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "vehicleId" UUID NOT NULL,
  "washerId" UUID NOT NULL,
  "startsAt" DATE NOT NULL,
  "endsAt" DATE,
  "assignedBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyWasherAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyWasherAssignment_id_accountId_vehicleId_washerId_key" UNIQUE ("id", "accountId", "vehicleId", "washerId"),
  CONSTRAINT "SocietyWasherAssignment_dates_check" CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt"),
  CONSTRAINT "SocietyWasherAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyWasherAssignment_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyWasherAssignment_vehicleId_accountId_societyId_fkey" FOREIGN KEY ("vehicleId", "accountId", "societyId") REFERENCES "SocietyVehicle"("id", "accountId", "societyId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyWasherAssignment_washerId_societyId_accountId_fkey" FOREIGN KEY ("washerId", "societyId", "accountId") REFERENCES "SocietyWasher"("id", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyAttendance" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "washerId" UUID NOT NULL,
  "workDate" DATE NOT NULL,
  "status" "SocietyAttendanceStatus" NOT NULL,
  "note" VARCHAR(500),
  "recordedBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SocietyAttendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyAttendance_washerId_workDate_key" UNIQUE ("washerId", "workDate"),
  CONSTRAINT "SocietyAttendance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyAttendance_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyAttendance_washerId_societyId_accountId_fkey" FOREIGN KEY ("washerId", "societyId", "accountId") REFERENCES "SocietyWasher"("id", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyWashTask" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "vehicleId" UUID NOT NULL,
  "assignmentId" UUID,
  "washerId" UUID,
  "activity" "SocietyTaskActivity" NOT NULL DEFAULT 'WASH',
  "taskDate" DATE NOT NULL,
  "status" "SocietyTaskStatus" NOT NULL DEFAULT 'SCHEDULED',
  "completedAt" TIMESTAMPTZ(6),
  "earningRatePaise" INTEGER,
  "note" VARCHAR(500),
  "completedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SocietyWashTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyWashTask_vehicleId_taskDate_activity_key" UNIQUE ("vehicleId", "taskDate", "activity"),
  CONSTRAINT "SocietyWashTask_earningRatePaise_check" CHECK ("earningRatePaise" IS NULL OR "earningRatePaise" >= 0),
  CONSTRAINT "SocietyWashTask_assignmentWasher_check" CHECK (("assignmentId" IS NULL) = ("washerId" IS NULL)),
  CONSTRAINT "SocietyWashTask_earningRequiresCompletedAssignment_check" CHECK ("earningRatePaise" IS NULL OR ("status" = 'COMPLETED' AND "assignmentId" IS NOT NULL)),
  CONSTRAINT "SocietyWashTask_completionTimestamp_check" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)),
  CONSTRAINT "SocietyWashTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyWashTask_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyWashTask_vehicleId_accountId_societyId_fkey" FOREIGN KEY ("vehicleId", "accountId", "societyId") REFERENCES "SocietyVehicle"("id", "accountId", "societyId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyWashTask_assignmentId_accountId_vehicleId_washerId_fkey" FOREIGN KEY ("assignmentId", "accountId", "vehicleId", "washerId") REFERENCES "SocietyWasherAssignment"("id", "accountId", "vehicleId", "washerId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyInvoice" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "residentId" UUID NOT NULL,
  "monthStart" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "totalPaise" INTEGER NOT NULL,
  "status" "SocietyInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyInvoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyInvoice_residentId_monthStart_key" UNIQUE ("residentId", "monthStart"),
  CONSTRAINT "SocietyInvoice_id_accountId_key" UNIQUE ("id", "accountId"),
  CONSTRAINT "SocietyInvoice_totalPaise_check" CHECK ("totalPaise" >= 0),
  CONSTRAINT "SocietyInvoice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyInvoice_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyInvoice_residentId_societyId_accountId_fkey" FOREIGN KEY ("residentId", "societyId", "accountId") REFERENCES "SocietyResident"("id", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyInvoiceLine" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "vehicleId" UUID,
  "description" VARCHAR(180) NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyInvoiceLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyInvoiceLine_invoiceId_vehicleId_key" UNIQUE ("invoiceId", "vehicleId"),
  CONSTRAINT "SocietyInvoiceLine_amountPaise_check" CHECK ("amountPaise" >= 0),
  CONSTRAINT "SocietyInvoiceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyInvoiceLine_invoiceId_accountId_fkey" FOREIGN KEY ("invoiceId", "accountId") REFERENCES "SocietyInvoice"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SocietyPayment" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "method" "SocietyPaymentMethod" NOT NULL,
  "reference" VARCHAR(120),
  "note" VARCHAR(500),
  "recordedBy" UUID NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyPayment_amountPaise_check" CHECK ("amountPaise" > 0),
  CONSTRAINT "SocietyPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyPayment_invoiceId_accountId_fkey" FOREIGN KEY ("invoiceId", "accountId") REFERENCES "SocietyInvoice"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyPaymentReminder" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "note" VARCHAR(500),
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyPaymentReminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyPaymentReminder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyPaymentReminder_invoiceId_accountId_fkey" FOREIGN KEY ("invoiceId", "accountId") REFERENCES "SocietyInvoice"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyWasherDeduction" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "washerId" UUID NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "status" "SocietyDeductionStatus" NOT NULL DEFAULT 'PENDING',
  "decisionReason" VARCHAR(500),
  "requestedBy" UUID NOT NULL,
  "decidedBy" UUID,
  "decidedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyWasherDeduction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyWasherDeduction_amountPaise_check" CHECK ("amountPaise" > 0),
  CONSTRAINT "SocietyWasherDeduction_decision_check" CHECK (
    ("status" = 'PENDING' AND "decidedBy" IS NULL AND "decidedAt" IS NULL AND "decisionReason" IS NULL)
    OR
    ("status" <> 'PENDING' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionReason" IS NOT NULL)
  ),
  CONSTRAINT "SocietyWasherDeduction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyWasherDeduction_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyWasherDeduction_washerId_societyId_accountId_fkey" FOREIGN KEY ("washerId", "societyId", "accountId") REFERENCES "SocietyWasher"("id", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "SocietyExtraWork" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "societyId" UUID NOT NULL,
  "residentId" UUID NOT NULL,
  "vehicleId" UUID NOT NULL,
  "description" VARCHAR(180) NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "residentApproverName" VARCHAR(100) NOT NULL,
  "consentNote" VARCHAR(500) NOT NULL,
  "status" "SocietyExtraWorkStatus" NOT NULL DEFAULT 'PENDING',
  "decisionReason" VARCHAR(500),
  "requestedBy" UUID NOT NULL,
  "decidedBy" UUID,
  "decidedAt" TIMESTAMPTZ(6),
  "workDate" DATE NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocietyExtraWork_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocietyExtraWork_amountPaise_check" CHECK ("amountPaise" >= 0),
  CONSTRAINT "SocietyExtraWork_decision_check" CHECK (
    ("status" = 'PENDING' AND "decidedBy" IS NULL AND "decidedAt" IS NULL AND "decisionReason" IS NULL)
    OR
    ("status" <> 'PENDING' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionReason" IS NOT NULL)
  ),
  CONSTRAINT "SocietyExtraWork_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocietyExtraWork_societyId_accountId_fkey" FOREIGN KEY ("societyId", "accountId") REFERENCES "Society"("id", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyExtraWork_residentId_societyId_accountId_fkey" FOREIGN KEY ("residentId", "societyId", "accountId") REFERENCES "SocietyResident"("id", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "SocietyExtraWork_vehicleId_residentId_societyId_accountId_fkey" FOREIGN KEY ("vehicleId", "residentId", "societyId", "accountId") REFERENCES "SocietyVehicle"("id", "residentId", "societyId", "accountId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE INDEX "Society_accountId_status_name_idx" ON "Society"("accountId", "status", "name");
CREATE INDEX "SocietyResident_accountId_societyId_status_name_idx" ON "SocietyResident"("accountId", "societyId", "status", "name");
CREATE INDEX "SocietyWasher_accountId_societyId_status_name_idx" ON "SocietyWasher"("accountId", "societyId", "status", "name");
CREATE INDEX "SocietyVehicle_accountId_societyId_residentId_status_idx" ON "SocietyVehicle"("accountId", "societyId", "residentId", "status");
CREATE INDEX "SocietyWasherAssignment_accountId_societyId_vehicleId_endsAt_idx" ON "SocietyWasherAssignment"("accountId", "societyId", "vehicleId", "endsAt");
CREATE INDEX "SocietyWasherAssignment_accountId_societyId_washerId_startsAt_idx" ON "SocietyWasherAssignment"("accountId", "societyId", "washerId", "startsAt");
CREATE UNIQUE INDEX "SocietyWasherAssignment_active_vehicle_key" ON "SocietyWasherAssignment"("accountId", "vehicleId") WHERE "endsAt" IS NULL;
CREATE INDEX "SocietyAttendance_accountId_societyId_workDate_idx" ON "SocietyAttendance"("accountId", "societyId", "workDate");
CREATE INDEX "SocietyWashTask_accountId_societyId_taskDate_status_idx" ON "SocietyWashTask"("accountId", "societyId", "taskDate", "status");
CREATE INDEX "SocietyWashTask_accountId_societyId_washerId_taskDate_idx" ON "SocietyWashTask"("accountId", "societyId", "washerId", "taskDate");
CREATE INDEX "SocietyInvoice_accountId_societyId_monthStart_status_idx" ON "SocietyInvoice"("accountId", "societyId", "monthStart", "status");
CREATE INDEX "SocietyInvoiceLine_accountId_invoiceId_idx" ON "SocietyInvoiceLine"("accountId", "invoiceId");
CREATE INDEX "SocietyPayment_accountId_invoiceId_receivedAt_idx" ON "SocietyPayment"("accountId", "invoiceId", "receivedAt");
CREATE INDEX "SocietyPaymentReminder_accountId_invoiceId_createdAt_idx" ON "SocietyPaymentReminder"("accountId", "invoiceId", "createdAt");
CREATE INDEX "SocietyWasherDeduction_accountId_societyId_washerId_status_idx" ON "SocietyWasherDeduction"("accountId", "societyId", "washerId", "status");
CREATE INDEX "SocietyExtraWork_accountId_societyId_status_workDate_idx" ON "SocietyExtraWork"("accountId", "societyId", "status", "workDate");

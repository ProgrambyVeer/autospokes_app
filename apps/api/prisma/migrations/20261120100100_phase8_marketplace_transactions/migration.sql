-- Phase 8: payments lifecycle, disputes, settlement, cancellation and refunds. Additive only.
CREATE TYPE "MarketplaceDisputeStatus" AS ENUM ('OPEN', 'RESPONDED', 'RESOLVED');
CREATE TYPE "MarketplaceDisputeOutcome" AS ENUM ('UPHELD_COMPLETION', 'REWORK_REQUIRED', 'CANCELLED_NO_CHARGE');
CREATE TYPE "MarketplaceDisputeEntryKind" AS ENUM ('OPENED', 'VENDOR_RESPONSE', 'RESOLVED');
CREATE TYPE "MarketplaceRefundStatus" AS ENUM ('APPROVED_PENDING_EXTERNAL_TRANSFER', 'CONFIRMED_EXTERNALLY');
CREATE TYPE "MarketplaceCancellationKind" AS ENUM ('OWNER_CANCELLED', 'VENDOR_CANCELLED', 'OWNER_NO_SHOW', 'VENDOR_NO_SHOW');

ALTER TABLE "MarketplacePayment" ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'INR',
ADD COLUMN     "failedAt" TIMESTAMPTZ(6),
ADD COLUMN     "failedBy" UUID,
ADD COLUMN     "failureReason" VARCHAR(500),
ADD COLUMN     "idempotencyKey" VARCHAR(80),
ADD COLUMN     "verificationEvidence" JSONB,
ADD COLUMN     "verificationSource" VARCHAR(40),
ADD COLUMN     "verifiedAt" TIMESTAMPTZ(6),
ADD COLUMN     "verifiedBy" UUID;

CREATE TABLE "MarketplaceDispute" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "vendorAccountId" UUID NOT NULL,
    "ownerAccountId" UUID NOT NULL,
    "status" "MarketplaceDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "category" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "description" VARCHAR(2000),
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openedBy" UUID NOT NULL,
    "outcome" "MarketplaceDisputeOutcome",
    "resolutionRationale" VARCHAR(2000),
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MarketplaceDispute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceDisputeEntry" (
    "id" UUID NOT NULL,
    "disputeId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "kind" "MarketplaceDisputeEntryKind" NOT NULL,
    "actorId" UUID NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceDisputeEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceSettlement" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "vendorAccountId" UUID NOT NULL,
    "agreedPricePaise" INTEGER NOT NULL,
    "verifiedPaidPaise" INTEGER NOT NULL,
    "settledBy" UUID NOT NULL,
    "note" VARCHAR(500),
    "externalTransfer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceSettlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceCancellation" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "vendorAccountId" UUID NOT NULL,
    "kind" "MarketplaceCancellationKind" NOT NULL,
    "initiatorId" UUID NOT NULL,
    "initiatorRole" "UserRole" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "policyKey" VARCHAR(60) NOT NULL,
    "policyVersion" VARCHAR(20) NOT NULL,
    "feePaise" INTEGER NOT NULL DEFAULT 0,
    "fromStatus" "MarketplaceBookingStatus" NOT NULL,
    "unrefundedPaidPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceCancellation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceRefund" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" "MarketplaceRefundStatus" NOT NULL DEFAULT 'APPROVED_PENDING_EXTERNAL_TRANSFER',
    "reason" VARCHAR(500) NOT NULL,
    "approvedBy" UUID NOT NULL,
    "confirmedBy" UUID,
    "confirmedAt" TIMESTAMPTZ(6),
    "evidenceReference" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceRefund_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MarketplaceDispute_bookingId_createdAt_idx" ON "MarketplaceDispute"("bookingId", "createdAt");
CREATE INDEX "MarketplaceDispute_status_createdAt_idx" ON "MarketplaceDispute"("status", "createdAt");
CREATE UNIQUE INDEX "MarketplaceDispute_id_bookingId_key" ON "MarketplaceDispute"("id", "bookingId");
CREATE INDEX "MarketplaceDisputeEntry_disputeId_createdAt_idx" ON "MarketplaceDisputeEntry"("disputeId", "createdAt");
CREATE UNIQUE INDEX "MarketplaceSettlement_bookingId_key" ON "MarketplaceSettlement"("bookingId");
CREATE UNIQUE INDEX "MarketplaceCancellation_bookingId_key" ON "MarketplaceCancellation"("bookingId");
CREATE UNIQUE INDEX "MarketplaceRefund_paymentId_key" ON "MarketplaceRefund"("paymentId");
CREATE INDEX "MarketplaceRefund_bookingId_idx" ON "MarketplaceRefund"("bookingId");
CREATE UNIQUE INDEX "MarketplacePayment_bookingId_idempotencyKey_key" ON "MarketplacePayment"("bookingId", "idempotencyKey");

ALTER TABLE "MarketplaceDispute" ADD CONSTRAINT "MarketplaceDispute_bookingId_vendorAccountId_fkey" FOREIGN KEY ("bookingId", "vendorAccountId") REFERENCES "MarketplaceBooking"("id", "vendorAccountId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MarketplaceDisputeEntry" ADD CONSTRAINT "MarketplaceDisputeEntry_disputeId_bookingId_fkey" FOREIGN KEY ("disputeId", "bookingId") REFERENCES "MarketplaceDispute"("id", "bookingId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MarketplaceSettlement" ADD CONSTRAINT "MarketplaceSettlement_bookingId_vendorAccountId_fkey" FOREIGN KEY ("bookingId", "vendorAccountId") REFERENCES "MarketplaceBooking"("id", "vendorAccountId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MarketplaceCancellation" ADD CONSTRAINT "MarketplaceCancellation_bookingId_vendorAccountId_fkey" FOREIGN KEY ("bookingId", "vendorAccountId") REFERENCES "MarketplaceBooking"("id", "vendorAccountId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRefund" ADD CONSTRAINT "MarketplaceRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "MarketplacePayment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MarketplacePayment"
  ADD CONSTRAINT "MarketplacePayment_currency_check" CHECK ("currency" = 'INR'),
  ADD CONSTRAINT "MarketplacePayment_verified_check"
    CHECK ("status" NOT IN ('VERIFIED', 'REFUNDED') OR ("verifiedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL)),
  ADD CONSTRAINT "MarketplacePayment_failed_check"
    CHECK ("status" <> 'FAILED' OR ("failedAt" IS NOT NULL AND "failureReason" IS NOT NULL));

ALTER TABLE "MarketplaceDispute"
  ADD CONSTRAINT "MarketplaceDispute_resolution_check"
    CHECK ("status" <> 'RESOLVED' OR ("outcome" IS NOT NULL AND "resolutionRationale" IS NOT NULL AND "resolvedBy" IS NOT NULL AND "resolvedAt" IS NOT NULL));

ALTER TABLE "MarketplaceSettlement"
  ADD CONSTRAINT "MarketplaceSettlement_amounts_check"
    CHECK ("agreedPricePaise" > 0 AND "verifiedPaidPaise" >= "agreedPricePaise"),
  ADD CONSTRAINT "MarketplaceSettlement_internal_only_check" CHECK ("externalTransfer" = false);

ALTER TABLE "MarketplaceCancellation"
  ADD CONSTRAINT "MarketplaceCancellation_no_fee_check" CHECK ("feePaise" = 0),
  ADD CONSTRAINT "MarketplaceCancellation_unrefunded_check" CHECK ("unrefundedPaidPaise" >= 0);

ALTER TABLE "MarketplaceRefund"
  ADD CONSTRAINT "MarketplaceRefund_amount_check" CHECK ("amountPaise" > 0),
  ADD CONSTRAINT "MarketplaceRefund_confirmed_check"
    CHECK ("status" <> 'CONFIRMED_EXTERNALLY' OR ("confirmedAt" IS NOT NULL AND "confirmedBy" IS NOT NULL AND "evidenceReference" IS NOT NULL));

-- A resolved dispute is a permanent decision record.
CREATE FUNCTION "marketplace_dispute_resolved_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MarketplaceDispute rows cannot be deleted (append-only history)';
  END IF;
  IF OLD."status" = 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved marketplace dispute cannot be modified';
  END IF;
  IF NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."evidenceUrls" IS DISTINCT FROM OLD."evidenceUrls"
    OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
    OR NEW."openedBy" IS DISTINCT FROM OLD."openedBy" THEN
    RAISE EXCEPTION 'Marketplace dispute claims are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketplaceDispute_guard"
  BEFORE UPDATE OR DELETE ON "MarketplaceDispute"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_dispute_resolved_guard"();

CREATE TRIGGER "MarketplaceDisputeEntry_append_only"
  BEFORE UPDATE OR DELETE ON "MarketplaceDisputeEntry"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_history_guard"();

CREATE TRIGGER "MarketplaceSettlement_append_only"
  BEFORE UPDATE OR DELETE ON "MarketplaceSettlement"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_history_guard"();

CREATE TRIGGER "MarketplaceCancellation_append_only"
  BEFORE UPDATE OR DELETE ON "MarketplaceCancellation"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_history_guard"();

CREATE TRIGGER "MarketplaceRefund_no_delete"
  BEFORE DELETE ON "MarketplaceRefund"
  FOR EACH ROW EXECUTE FUNCTION "marketplace_history_guard"();

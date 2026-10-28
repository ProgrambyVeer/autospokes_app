-- A withdrawn dispute is a closed record just like a resolved one: it can no longer change, and its claim
-- fields stay immutable. No data is modified or removed; only the guard function body is replaced.
CREATE OR REPLACE FUNCTION "marketplace_dispute_resolved_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MarketplaceDispute rows cannot be deleted (append-only history)';
  END IF;
  IF OLD."status" IN ('RESOLVED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'A closed marketplace dispute cannot be modified';
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

-- A withdrawn dispute never carries a resolution outcome.
ALTER TABLE "MarketplaceDispute"
  ADD CONSTRAINT "MarketplaceDispute_withdrawn_check"
    CHECK ("status" <> 'WITHDRAWN' OR "outcome" IS NULL);

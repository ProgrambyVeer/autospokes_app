-- Additive only. New enum values are committed here so the next migration can rely on them.
ALTER TYPE "MarketplaceDisputeStatus" ADD VALUE 'WITHDRAWN';
ALTER TYPE "MarketplaceDisputeEntryKind" ADD VALUE 'WITHDRAWN';
ALTER TYPE "MarketplaceCancellationKind" ADD VALUE 'DISPUTE_RESOLUTION';

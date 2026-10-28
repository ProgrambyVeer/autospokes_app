-- Additive only. New enum values are committed here so the next migration can use them.
ALTER TYPE "MarketplaceBookingStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "MarketplacePaymentStatus" ADD VALUE 'FAILED';
ALTER TYPE "MarketplacePaymentStatus" ADD VALUE 'REFUNDED';

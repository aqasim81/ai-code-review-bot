-- The running attempt now renews its claim periodically, so the column holds
-- the last time the owner showed it was alive, not when it started. A review
-- is stale when its claim was not renewed for the stale cutoff.
ALTER TABLE "reviews" RENAME COLUMN "processingStartedAt" TO "claimRenewedAt";

-- Record which queue job owns a PROCESSING review, when it started and a
-- per-attempt claim token. A retry of the same job, or any job after a stale
-- cutoff, can reclaim the review; an attempt whose token no longer matches
-- stops writing.
ALTER TABLE "reviews" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedByJobId" TEXT,
ADD COLUMN     "processingStartedAt" TIMESTAMP(3);

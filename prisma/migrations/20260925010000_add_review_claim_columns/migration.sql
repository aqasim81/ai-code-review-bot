-- Record which queue job owns a PROCESSING review and when it started, so a
-- retry of the same job, or any job after a stale cutoff, can reclaim it.
ALTER TABLE "reviews" ADD COLUMN     "claimedByJobId" TEXT,
ADD COLUMN     "processingStartedAt" TIMESTAMP(3);

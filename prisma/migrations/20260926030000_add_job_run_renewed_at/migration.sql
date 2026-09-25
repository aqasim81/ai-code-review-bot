-- When the run that owns a job record last showed it was alive. The run sets
-- it on claim and renews it while it works; a record not renewed past the
-- stale cutoff lost its run and is closed as FAILED by the worker's sweep.
ALTER TABLE "jobs" ADD COLUMN     "runRenewedAt" TIMESTAMP(3);

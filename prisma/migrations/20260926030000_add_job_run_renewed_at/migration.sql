-- When the run that owns a job record last showed it was alive. The run sets
-- it on claim and renews it while it works; a record not renewed past the
-- stale cutoff lost its run and is closed as FAILED by the worker's sweep.
ALTER TABLE "jobs" ADD COLUMN     "runRenewedAt" TIMESTAMP(3);

-- Unfinished records from before renewals count from their creation, so ones
-- already stuck are closed by the sweep. Records a worker still on the old
-- code creates later keep a null value and are never swept, so a deploy that
-- overlaps old and new workers cannot fail a run the old worker is running.
UPDATE "jobs" SET "runRenewedAt" = "createdAt"
WHERE "status" IN ('QUEUED', 'PROCESSING') AND "runRenewedAt" IS NULL;

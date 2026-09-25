-- Repositories removed from an installation are kept with a removal time, so
-- a review job queued before the removal cannot bring them back.
ALTER TABLE "repositories" ADD COLUMN "removedAt" TIMESTAMP(3);

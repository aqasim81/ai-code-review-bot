-- A per-run token on each job record. Every run of a queue job claims the
-- record with a new token, and status writes only apply while the token is
-- still current, so a run that lost its queue lock cannot overwrite the
-- status written by the run that replaced it.
ALTER TABLE "jobs" ADD COLUMN     "runToken" TEXT;

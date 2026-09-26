-- A review belongs to one pull request's commit (#124). Two pull requests
-- from the same branch share head commits, and each gets its own review. The
-- old key was stricter, so existing rows cannot conflict.
DROP INDEX "reviews_repositoryId_commitSha_key";
CREATE UNIQUE INDEX "reviews_repositoryId_pullRequestNumber_commitSha_key" ON "reviews"("repositoryId", "pullRequestNumber", "commitSha");

-- When GitHub reported the repository's name, so a job queued before a
-- rename cannot write the old name back (#127).
ALTER TABLE "repositories" ADD COLUMN     "fullNameSeenAt" TIMESTAMP(3);

-- When GitHub reported the commit as the pull request's head, which orders
-- push-review bases by push rather than by when reviews finished (#128); the
-- files a review counted as reviewed and the settings it ran with, so a push
-- review picks up what earlier reviews left out (#129).
ALTER TABLE "reviews" ADD COLUMN     "coveredFilePaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "headSeenAt" TIMESTAMP(3),
ADD COLUMN     "settingsFingerprint" TEXT;

-- Existing reviews were created when their job ran, the closest record of
-- when their commit was pushed. Their null fingerprint makes the next push
-- review of each pull request a full one.
UPDATE "reviews" SET "headSeenAt" = "createdAt";

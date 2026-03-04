-- CreateIndex
CREATE INDEX "reviews_repositoryId_pullRequestNumber_status_createdAt_idx" ON "reviews"("repositoryId", "pullRequestNumber", "status", "createdAt");

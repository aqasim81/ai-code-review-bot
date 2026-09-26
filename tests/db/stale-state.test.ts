import { describe, expect, it } from "vitest";
import {
  claimExistingReview,
  createReviewRecord,
  failReview,
  findExistingReviewForPullRequestCommit,
  findOrCreateRepositoryForReview,
  findPushReviewBase,
  markReviewCompleted,
  saveReviewFindings,
} from "@/lib/db/queries";
import type { RepositoryId } from "@/types/branded";
import type { ReviewClaimRef } from "@/types/review";
import {
  createActiveRepository,
  GITHUB_INSTALLATION_ID,
  GITHUB_REPO_ID,
  testPrisma,
} from "./database";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const MINUTE_MS = 60_000;

async function createReview(
  repositoryId: RepositoryId,
  pullRequestNumber: number,
  commitSha: string,
  headSeenAt = new Date(),
): Promise<ReviewClaimRef> {
  const created = await createReviewRecord({
    repositoryId,
    pullRequestNumber,
    commitSha,
    claimedByJobId: `job-${pullRequestNumber}-${commitSha}`,
    headSeenAt,
  });
  if (!created.success || created.data === null) {
    throw new Error("could not create the review");
  }
  return created.data;
}

async function completeReview(
  claim: ReviewClaimRef,
  coveredFilePaths: readonly string[] = [],
): Promise<void> {
  await saveReviewFindings({
    ...claim,
    summary: "done",
    issuesFound: 0,
    comments: [],
    coveredFilePaths,
    settingsFingerprint: "fingerprint",
  });
  const completed = await markReviewCompleted(claim, 10);
  if (!completed.success || !completed.data) {
    throw new Error("could not complete the review");
  }
}

describe("reviews of one commit on two pull requests (#124)", () => {
  it("gives a second pull request at a reviewed commit its own review", async () => {
    const repositoryId = await createActiveRepository();
    await completeReview(await createReview(repositoryId, 10, COMMIT_A));

    const onOtherPullRequest = await findExistingReviewForPullRequestCommit(
      repositoryId,
      11,
      COMMIT_A,
    );
    const created = await createReviewRecord({
      repositoryId,
      pullRequestNumber: 11,
      commitSha: COMMIT_A,
      claimedByJobId: "job-11",
      headSeenAt: new Date(),
    });

    expect(onOtherPullRequest).toEqual({ success: true, data: null });
    expect(created.success && created.data !== null).toBe(true);
  });

  it("still lets only one job create the review of a pull request's commit", async () => {
    const repositoryId = await createActiveRepository();
    await createReview(repositoryId, 10, COMMIT_A);

    const second = await createReviewRecord({
      repositoryId,
      pullRequestNumber: 10,
      commitSha: COMMIT_A,
      claimedByJobId: "job-other",
      headSeenAt: new Date(),
    });

    expect(second).toEqual({ success: true, data: null });
  });

  it("never moves a review to another pull request when it is reclaimed", async () => {
    const repositoryId = await createActiveRepository();
    const claim = await createReview(repositoryId, 10, COMMIT_A);
    await failReview(claim, "model failed");

    const reclaimed = await claimExistingReview(claim.reviewId, {
      jobId: "job-retry",
      headSeenAt: new Date(),
      staleBefore: new Date(Date.now() - MINUTE_MS),
    });

    expect(reclaimed.success && reclaimed.data !== null).toBe(true);
    const row = await testPrisma.review.findUniqueOrThrow({
      where: { id: claim.reviewId },
    });
    expect(row.pullRequestNumber).toBe(10);
  });
});

describe("the repository name a review job writes (#127)", () => {
  // Both jobs are queued after the installation event that stored the name.
  const renamedAt = new Date(Date.now() + 60 * MINUTE_MS);
  const beforeRename = new Date(renamedAt.getTime() - 30 * MINUTE_MS);

  function lookUp(fullName: string, nameSeenAt: Date) {
    return findOrCreateRepositoryForReview({
      githubInstallationId: GITHUB_INSTALLATION_ID,
      githubRepoId: GITHUB_REPO_ID,
      fullName,
      nameSeenAt,
    });
  }

  it("keeps a newer name when a job queued before the rename retries", async () => {
    await createActiveRepository();
    await lookUp("octo-org/renamed", renamedAt);

    await lookUp("octo-org/repo", beforeRename);

    const row = await testPrisma.repository.findFirstOrThrow();
    expect(row.fullName).toBe("octo-org/renamed");
  });

  it("writes the name from a job queued after the one that wrote it", async () => {
    await createActiveRepository();
    await lookUp("octo-org/old", beforeRename);

    await lookUp("octo-org/renamed", renamedAt);

    const row = await testPrisma.repository.findFirstOrThrow();
    expect(row.fullName).toBe("octo-org/renamed");
  });
});

describe("the base of a push review (#128, #129)", () => {
  const pushedAt = new Date();

  function findBase() {
    return findPushReviewBase({
      githubInstallationId: GITHUB_INSTALLATION_ID,
      githubRepoId: GITHUB_REPO_ID,
      pullRequestNumber: 7,
    });
  }

  it("is the newest reviewed commit, not the review that finished last", async () => {
    const repositoryId = await createActiveRepository();
    const reviewOfA = await createReview(
      repositoryId,
      7,
      COMMIT_A,
      new Date(pushedAt.getTime() - 10 * MINUTE_MS),
    );
    const reviewOfB = await createReview(repositoryId, 7, COMMIT_B, pushedAt);
    await completeReview(reviewOfB);
    // A's retry finds its earlier post and completes after B.
    await completeReview(reviewOfA);

    const base = await findBase();

    expect(base.success && base.data?.commitSha).toBe(COMMIT_B);
  });

  it("carries the files the base review covered and its settings", async () => {
    const repositoryId = await createActiveRepository();
    await completeReview(await createReview(repositoryId, 7, COMMIT_A), [
      "src/a.ts",
      "src/b.ts",
    ]);

    const base = await findBase();

    expect(base).toEqual({
      success: true,
      data: {
        commitSha: COMMIT_A,
        coveredFilePaths: ["src/a.ts", "src/b.ts"],
        settingsFingerprint: "fingerprint",
      },
    });
  });
});

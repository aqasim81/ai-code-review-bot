import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JobStatus } from "@/generated/prisma/enums";
import {
  claimExistingReview,
  claimJobRecord,
  createJobRecord,
  createReviewRecord,
  failReview,
  failStaleReview,
  failUnfinishedJobRecord,
  markReviewCompleted,
  saveReviewFindings,
  updateJobRecord,
} from "@/lib/db/queries";
import type { ReviewClaimRef } from "@/types/review";
import { createActiveRepository, testPrisma } from "./database";

const HOUR_MS = 60 * 60 * 1000;

async function claimNewReview(): Promise<ReviewClaimRef> {
  const repositoryId = await createActiveRepository();
  const created = await createReviewRecord({
    repositoryId,
    pullRequestNumber: 7,
    commitSha: "abc123",
    claimedByJobId: "job-1",
  });
  if (!created.success || created.data === null) {
    throw new Error("could not create the review");
  }
  return created.data;
}

// A second attempt of the same queue job takes the review over, so the first
// attempt's claim token is no longer current.
async function takeOver(claim: ReviewClaimRef): Promise<ReviewClaimRef> {
  const reclaimed = await claimExistingReview(claim.reviewId, {
    jobId: "job-1",
    pullRequestNumber: 7,
    staleBefore: new Date(Date.now() - HOUR_MS),
  });
  if (!reclaimed.success || reclaimed.data === null) {
    throw new Error("could not reclaim the review");
  }
  return reclaimed.data;
}

async function reviewRow() {
  return testPrisma.review.findFirstOrThrow({ include: { comments: true } });
}

describe("claim-guarded review updates in Postgres", () => {
  it("ignores every write from an attempt whose claim was taken over", async () => {
    const oldClaim = await claimNewReview();
    const current = await takeOver(oldClaim);

    const writes = await Promise.all([
      saveReviewFindings({
        ...oldClaim,
        summary: "stale",
        issuesFound: 1,
        comments: [
          {
            filePath: "src/a.ts",
            lineNumber: 1,
            category: "BUGS",
            severity: "WARNING",
            message: "stale finding",
            suggestion: null,
            confidence: 0.9,
            githubCommentId: null,
          },
        ],
      }),
      markReviewCompleted(oldClaim, 10),
      failReview(oldClaim, "stale failure"),
    ]);

    expect(writes).toEqual(Array(3).fill({ success: true, data: false }));
    const row = await reviewRow();
    expect(row).toMatchObject({
      status: "PROCESSING",
      claimToken: current.claimToken,
      summary: null,
      comments: [],
    });
  });

  it("lets the current claim complete the review", async () => {
    const claim = await claimNewReview();

    expect(await markReviewCompleted(claim, 10)).toEqual({
      success: true,
      data: true,
    });
    expect((await reviewRow()).status).toBe("COMPLETED");
  });

  it("does not expire a review that started after the stale cutoff (#30)", async () => {
    const claim = await claimNewReview();

    const expired = await failStaleReview(
      claim.reviewId,
      new Date(Date.now() - HOUR_MS),
    );

    expect(expired).toEqual({ success: true, data: false });
    expect((await reviewRow()).status).toBe("PROCESSING");
  });

  it("expires a review that started before the stale cutoff and clears its claim", async () => {
    const claim = await claimNewReview();

    const expired = await failStaleReview(
      claim.reviewId,
      new Date(Date.now() + HOUR_MS),
    );

    expect(expired).toEqual({ success: true, data: true });
    expect(await reviewRow()).toMatchObject({
      status: "FAILED",
      claimToken: null,
    });
  });
});

describe("status-guarded job record updates in Postgres (#66)", () => {
  async function jobWithStatus(status: JobStatus): Promise<string> {
    const created = await createJobRecord({
      type: "review-pr",
      payload: { pullRequestNumber: 7 },
      initialStatus: "PROCESSING",
    });
    if (!created.success) throw new Error(created.error);
    if (status !== "PROCESSING") {
      await updateJobRecord(created.data, status, {
        lastError: status === "FAILED" ? "LLM_TIMEOUT" : undefined,
      });
    }
    return created.data.id;
  }

  it.each(["QUEUED", "PROCESSING"] as const)(
    "fails a %s record",
    async (status) => {
      const id = await jobWithStatus(status);

      const failed = await failUnfinishedJobRecord(id, {
        lastError: "job stalled more than allowable limit",
        attempts: 1,
      });

      expect(failed).toEqual({ success: true, data: true });
      const row = await testPrisma.job.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: "FAILED",
        lastError: "job stalled more than allowable limit",
      });
      expect(row.processedAt).not.toBeNull();
    },
  );

  it.each([
    ["COMPLETED", null],
    ["FAILED", "LLM_TIMEOUT"],
  ] as const)("leaves a %s record as it is", async (status, lastError) => {
    const id = await jobWithStatus(status);

    const failed = await failUnfinishedJobRecord(id, {
      lastError: "job stalled more than allowable limit",
      attempts: 3,
    });

    expect(failed).toEqual({ success: true, data: false });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status, lastError });
  });
});

describe("job record status writes fenced by the run token (#115)", () => {
  async function createRun() {
    const created = await createJobRecord({
      type: "review-pr",
      payload: { pullRequestNumber: 7 },
      initialStatus: "PROCESSING",
    });
    if (!created.success) throw new Error(created.error);
    return created.data;
  }

  async function claimRun(id: string) {
    const claimed = await claimJobRecord(id);
    if (!claimed.success || claimed.data === null) {
      throw new Error("claim failed");
    }
    return claimed.data;
  }

  it("ignores a write from a run that a later run replaced", async () => {
    const runA = await createRun();
    const runB = await claimRun(runA.id);
    await updateJobRecord(runB, "COMPLETED");

    const written = await updateJobRecord(runA, "FAILED", {
      lastError: "REVIEW_LLM_FAILED",
      attempts: 1,
    });

    expect(written).toEqual({ success: true, data: false });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id: runA.id } }),
    ).toMatchObject({ status: "COMPLETED", lastError: null });
  });

  it("lets a retry move a FAILED attempt's record to COMPLETED", async () => {
    const first = await createRun();
    await updateJobRecord(first, "FAILED", {
      lastError: "REVIEW_LLM_FAILED",
      attempts: 1,
    });

    const retry = await claimRun(first.id);
    const row = await testPrisma.job.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(row).toMatchObject({ status: "PROCESSING", processedAt: null });

    expect(await updateJobRecord(retry, "COMPLETED")).toEqual({
      success: true,
      data: true,
    });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("stops a still-running run from writing after the record was failed", async () => {
    const run = await createRun();
    await failUnfinishedJobRecord(run.id, {
      lastError: "job stalled more than allowable limit",
      attempts: 1,
    });

    expect(await updateJobRecord(run, "COMPLETED")).toEqual({
      success: true,
      data: false,
    });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "FAILED" });
  });

  it("returns null when claiming a record that no longer exists", async () => {
    expect(await claimJobRecord(randomUUID())).toEqual({
      success: true,
      data: null,
    });
  });
});

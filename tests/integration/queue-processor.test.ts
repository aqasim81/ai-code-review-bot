import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries");
vi.mock("@/lib/github/api");
vi.mock("@/lib/llm/client");
vi.mock("@/lib/review/engine");

import { type Job, UnrecoverableError } from "bullmq";
import {
  createJobRecord,
  findLastReviewedCommitSha,
  updateJobRecord,
} from "@/lib/db/queries";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import {
  calculateBackoffDelay,
  isFinalJobFailure,
  processReviewJob,
} from "@/lib/queue/processor";
import type { ReviewJobData } from "@/lib/queue/types";
import { executeReview } from "@/lib/review/engine";
import { err, ok } from "@/types/results";
import {
  createMockGitHubService,
  createMockLlmService,
  createReviewEngineResult,
} from "../helpers/factories";

function createMockJob(
  overrides?: Partial<Job<ReviewJobData>>,
): Job<ReviewJobData> {
  return {
    id: "job-123",
    attemptsMade: 0,
    data: {
      type: "review-pr",
      payload: {
        installationId: 12345,
        githubRepoId: 555,
        repositoryFullName: "test-owner/test-repo",
        pullRequestNumber: 42,
        commitSha: "abc123",
      },
    },
    updateData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Job<ReviewJobData>;
}

function createDeltaJob(
  overrides?: Partial<Job<ReviewJobData>>,
): Job<ReviewJobData> {
  return {
    id: "delta-job-123",
    attemptsMade: 0,
    data: {
      type: "review-pr-delta",
      payload: {
        installationId: 12345,
        githubRepoId: 555,
        repositoryFullName: "test-owner/test-repo",
        pullRequestNumber: 42,
        commitSha: "abc123",
      },
    },
    updateData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Job<ReviewJobData>;
}

function setupDefaultMocks() {
  const mockGithubService = createMockGitHubService();
  const mockLlmService = createMockLlmService();

  vi.mocked(createGitHubServiceFromEnv).mockReturnValue(mockGithubService);
  vi.mocked(createLlmClient).mockReturnValue(mockLlmService);
  vi.mocked(createJobRecord).mockResolvedValue(ok({ id: "db-job-1" }));
  vi.mocked(updateJobRecord).mockResolvedValue(ok(undefined));
  vi.mocked(executeReview).mockResolvedValue(ok(createReviewEngineResult()));
  vi.mocked(findLastReviewedCommitSha).mockResolvedValue(
    ok("last-reviewed-sha"),
  );

  return { mockGithubService, mockLlmService };
}

describe("processReviewJob", () => {
  let mocks: ReturnType<typeof setupDefaultMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = setupDefaultMocks();
  });

  it("processes a full review job end-to-end", async () => {
    const job = createMockJob();

    await processReviewJob(job);

    expect(createJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "review-pr",
        initialStatus: "PROCESSING",
      }),
    );
    expect(createGitHubServiceFromEnv).toHaveBeenCalledWith(12345);
    expect(executeReview).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 12345,
        githubRepoId: 555,
        repositoryFullName: "test-owner/test-repo",
        pullRequestNumber: 42,
        commitSha: "abc123",
        jobId: "job-123",
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
  });

  it("creates DB job record on first attempt and stores ID", async () => {
    const job = createMockJob();

    await processReviewJob(job);

    expect(createJobRecord).toHaveBeenCalledTimes(1);
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ dbJobId: "db-job-1" }),
    );
  });

  it("skips DB job creation on retry attempts (uses existing dbJobId)", async () => {
    const job = createMockJob({
      attemptsMade: 1,
      data: {
        type: "review-pr",
        payload: {
          installationId: 12345,
          githubRepoId: 555,
          repositoryFullName: "test-owner/test-repo",
          pullRequestNumber: 42,
          commitSha: "abc123",
        },
        dbJobId: "existing-db-job",
      },
    });

    await processReviewJob(job);

    expect(createJobRecord).not.toHaveBeenCalled();
    expect(updateJobRecord).toHaveBeenCalledWith(
      "existing-db-job",
      "COMPLETED",
    );
  });

  it("reuses the job record when a stalled job re-runs without an attempt counted", async () => {
    const job = createMockJob({
      attemptsMade: 0,
      data: {
        type: "review-pr",
        payload: {
          installationId: 12345,
          githubRepoId: 555,
          repositoryFullName: "test-owner/test-repo",
          pullRequestNumber: 42,
          commitSha: "abc123",
        },
        dbJobId: "existing-db-job",
      },
    });

    await processReviewJob(job);

    expect(createJobRecord).not.toHaveBeenCalled();
    expect(updateJobRecord).toHaveBeenCalledWith(
      "existing-db-job",
      "COMPLETED",
    );
  });

  it("creates the job record on a retry when the first attempt could not", async () => {
    const job = createMockJob({ attemptsMade: 1 });

    await processReviewJob(job);

    expect(createJobRecord).toHaveBeenCalledTimes(1);
    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
  });

  it("marks job completed when REVIEW_ALREADY_EXISTS", async () => {
    vi.mocked(executeReview).mockResolvedValue(err("REVIEW_ALREADY_EXISTS"));

    const job = createMockJob();

    await processReviewJob(job);

    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
  });

  it("marks job completed when the repository is not reviewable", async () => {
    vi.mocked(executeReview).mockResolvedValue(
      err("REVIEW_REPOSITORY_UNAVAILABLE"),
    );

    await processReviewJob(createMockJob());

    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
  });

  it("skips a job queued before repository IDs were added to the payload", async () => {
    const job = createMockJob({
      data: {
        type: "review-pr",
        payload: {
          installationId: 12345,
          repositoryFullName: "test-owner/test-repo",
          pullRequestNumber: 42,
          commitSha: "abc123",
        } as unknown as ReviewJobData["payload"],
      } as ReviewJobData,
    });

    await processReviewJob(job);

    expect(executeReview).not.toHaveBeenCalled();
    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
  });

  it("marks job completed when another attempt holds the review (REVIEW_CLAIM_LOST)", async () => {
    vi.mocked(executeReview).mockResolvedValue(err("REVIEW_CLAIM_LOST"));

    await processReviewJob(createMockJob());

    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
  });

  it("throws before recording anything when the job has no ID", async () => {
    await expect(
      processReviewJob(createMockJob({ id: undefined })),
    ).rejects.toThrow("no ID");
    expect(createJobRecord).not.toHaveBeenCalled();
    expect(executeReview).not.toHaveBeenCalled();
  });

  it("throws error and marks job failed on review failure", async () => {
    vi.mocked(executeReview).mockResolvedValue(err("REVIEW_LLM_FAILED"));

    const job = createMockJob();

    await expect(processReviewJob(job)).rejects.toThrow(
      "Review failed: REVIEW_LLM_FAILED",
    );
    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "FAILED", {
      lastError: "REVIEW_LLM_FAILED",
      attempts: 1,
    });
  });

  it.each([
    "REVIEW_DIFF_UNAVAILABLE",
    "REVIEW_LLM_REJECTED",
    "REVIEW_POST_REJECTED",
  ] as const)("fails the job without retrying on %s", async (code) => {
    vi.mocked(executeReview).mockResolvedValue(err(code));

    const failure = processReviewJob(createMockJob());

    await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(failure).rejects.toThrow(`Review failed: ${code}`);
    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "FAILED", {
      lastError: code,
      attempts: 1,
    });
  });

  it.each([
    "REVIEW_GITHUB_RATE_LIMITED",
    "REVIEW_LLM_FAILED",
    "REVIEW_DIFF_FETCH_FAILED",
  ] as const)("leaves %s retryable", async (code) => {
    vi.mocked(executeReview).mockResolvedValue(err(code));

    const failure = processReviewJob(createMockJob());

    await expect(failure).rejects.toThrow(`Review failed: ${code}`);
    await expect(failure).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("processes delta review job with file path filter", async () => {
    vi.mocked(mocks.mockGithubService.compareCommits).mockResolvedValue(
      ok({
        status: "ahead",
        files: [
          { filename: "src/changed.ts", status: "modified" },
          { filename: "src/also-changed.ts", status: "added" },
        ],
      }),
    );

    const job = createDeltaJob();

    await processReviewJob(job);

    expect(findLastReviewedCommitSha).toHaveBeenCalledWith({
      githubInstallationId: 12345,
      githubRepoId: 555,
      pullRequestNumber: 42,
    });
    expect(mocks.mockGithubService.compareCommits).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      "last-reviewed-sha",
      "abc123",
    );
    expect(executeReview).toHaveBeenCalledWith(
      expect.objectContaining({
        filePathFilter: ["src/changed.ts", "src/also-changed.ts"],
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reviews the whole pull request when no earlier review completed", async () => {
    vi.mocked(findLastReviewedCommitSha).mockResolvedValue(ok(null));

    await processReviewJob(createDeltaJob());

    expect(mocks.mockGithubService.compareCommits).not.toHaveBeenCalled();
    expect(executeReview).toHaveBeenCalledWith(
      expect.not.objectContaining({ filePathFilter: expect.anything() }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reviews the whole pull request when the last reviewed commit cannot be looked up", async () => {
    vi.mocked(findLastReviewedCommitSha).mockResolvedValue(err("DB down"));

    await processReviewJob(createDeltaJob());

    expect(mocks.mockGithubService.compareCommits).not.toHaveBeenCalled();
    expect(executeReview).toHaveBeenCalledWith(
      expect.not.objectContaining({ filePathFilter: expect.anything() }),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each(["behind", "diverged"] as const)(
    "reviews the whole pull request when head is %s the last reviewed commit",
    async (status) => {
      vi.mocked(mocks.mockGithubService.compareCommits).mockResolvedValue(
        ok({
          status,
          files: [{ filename: "src/changed.ts", status: "modified" }],
        }),
      );

      await processReviewJob(createDeltaJob());

      expect(executeReview).toHaveBeenCalledWith(
        expect.not.objectContaining({ filePathFilter: expect.anything() }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("skips the compare when the head commit was already reviewed", async () => {
    vi.mocked(findLastReviewedCommitSha).mockResolvedValue(ok("abc123"));

    await processReviewJob(createDeltaJob());

    expect(mocks.mockGithubService.compareCommits).not.toHaveBeenCalled();
    expect(executeReview).toHaveBeenCalledWith(
      expect.objectContaining({ filePathFilter: [] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to full review when delta comparison fails", async () => {
    vi.mocked(mocks.mockGithubService.compareCommits).mockResolvedValue(
      err("GITHUB_UNKNOWN_ERROR"),
    );

    const job = createDeltaJob();

    await processReviewJob(job);

    // Falls back to full review (no filePathFilter)
    expect(executeReview).toHaveBeenCalledWith(
      expect.not.objectContaining({ filePathFilter: expect.anything() }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to full review when delta file count exceeds threshold (50)", async () => {
    const manyFiles = Array.from({ length: 51 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      status: "modified" as const,
    }));
    vi.mocked(mocks.mockGithubService.compareCommits).mockResolvedValue(
      ok({ status: "ahead", files: manyFiles }),
    );

    const job = createDeltaJob();

    await processReviewJob(job);

    // Falls back to full review (no filePathFilter)
    expect(executeReview).toHaveBeenCalledWith(
      expect.not.objectContaining({ filePathFilter: expect.anything() }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("handles DB job record creation failure gracefully", async () => {
    vi.mocked(createJobRecord).mockResolvedValue(err("DB error"));

    const job = createMockJob();

    // Should still process the review successfully
    await processReviewJob(job);

    expect(executeReview).toHaveBeenCalled();
    // updateJobRecord won't be called with null dbJobId
  });
});

describe("calculateBackoffDelay", () => {
  it("returns 10s for first attempt", () => {
    expect(calculateBackoffDelay(1)).toBe(10_000);
  });

  it("returns 30s for second attempt", () => {
    expect(calculateBackoffDelay(2)).toBe(30_000);
  });

  it("returns 90s for third attempt", () => {
    expect(calculateBackoffDelay(3)).toBe(90_000);
  });

  it("follows exponential backoff pattern with multiplier 3", () => {
    const delay1 = calculateBackoffDelay(1);
    const delay2 = calculateBackoffDelay(2);
    const delay3 = calculateBackoffDelay(3);

    expect(delay2 / delay1).toBe(3);
    expect(delay3 / delay2).toBe(3);
  });
});

describe("calculateBackoffDelay for a GitHub rate limit", () => {
  // The backoff strategy receives the error processReviewJob threw.
  async function errorThrownFor(
    code: "REVIEW_GITHUB_RATE_LIMITED" | "REVIEW_LLM_FAILED",
  ): Promise<Error> {
    vi.clearAllMocks();
    setupDefaultMocks();
    vi.mocked(executeReview).mockResolvedValue(err(code));
    return processReviewJob(createMockJob()).then(
      () => new Error("expected the job to fail"),
      (error: Error) => error,
    );
  }

  it("waits 30 minutes before each retry so the attempts span the hourly reset", async () => {
    const rateLimited = await errorThrownFor("REVIEW_GITHUB_RATE_LIMITED");

    expect(calculateBackoffDelay(1, rateLimited)).toBe(30 * 60_000);
    expect(calculateBackoffDelay(2, rateLimited)).toBe(30 * 60_000);
  });

  it("keeps the short backoff for other failures", async () => {
    const failed = await errorThrownFor("REVIEW_LLM_FAILED");

    expect(calculateBackoffDelay(1, failed)).toBe(10_000);
  });
});

describe("isFinalJobFailure", () => {
  const job = (attemptsMade: number) => ({
    attemptsMade,
    opts: { attempts: 3 },
  });

  it("is final after the last attempt", () => {
    expect(isFinalJobFailure(job(3), new Error("boom"))).toBe(true);
  });

  it("is final when the failure cannot be retried, whatever the attempt", () => {
    expect(isFinalJobFailure(job(1), new UnrecoverableError("no"))).toBe(true);
  });

  it("is not final while attempts remain", () => {
    expect(isFinalJobFailure(job(1), new Error("boom"))).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries");
vi.mock("@/lib/github/api");
vi.mock("@/lib/llm/client");
vi.mock("@/lib/review/engine");

import type { Job } from "bullmq";
import { createJobRecord, updateJobRecord } from "@/lib/db/queries";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { calculateBackoffDelay, processReviewJob } from "@/lib/queue/processor";
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
        repositoryFullName: "test-owner/test-repo",
        pullRequestNumber: 42,
        commitSha: "abc123",
        previousCommitSha: "prev-sha",
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
        repositoryFullName: "test-owner/test-repo",
        pullRequestNumber: 42,
        commitSha: "abc123",
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

  it("marks job completed when REVIEW_ALREADY_EXISTS", async () => {
    vi.mocked(executeReview).mockResolvedValue(err("REVIEW_ALREADY_EXISTS"));

    const job = createMockJob();

    await processReviewJob(job);

    expect(updateJobRecord).toHaveBeenCalledWith("db-job-1", "COMPLETED");
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

  it("processes delta review job with file path filter", async () => {
    vi.mocked(mocks.mockGithubService.compareCommits).mockResolvedValue(
      ok({
        files: [
          { filename: "src/changed.ts", status: "modified" },
          { filename: "src/also-changed.ts", status: "added" },
        ],
      }),
    );

    const job = createDeltaJob();

    await processReviewJob(job);

    expect(mocks.mockGithubService.compareCommits).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      "prev-sha",
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
      ok({ files: manyFiles }),
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

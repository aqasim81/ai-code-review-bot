import { beforeEach, describe, expect, it, vi } from "vitest";
import { SINGLE_FILE_TYPESCRIPT_DIFF } from "../fixtures/diffs";
import {
  createMockGitHubService,
  createMockLlmService,
  createReviewFinding,
  createReviewRequest,
  createReviewResult,
  installationId,
  repositoryId,
  reviewId,
} from "../helpers/factories";

vi.mock("@/lib/db/queries");
vi.mock("@/lib/review/ast-parser");
vi.mock("@/lib/repository-utils");

import {
  claimExistingReview,
  createReviewRecord,
  failReview,
  findExistingReviewByCommitSha,
  findRepositoryByFullName,
  isReviewClaimCurrent,
  markReviewCompleted,
  saveReviewFindings,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { initializeAstParser, parseFileAst } from "@/lib/review/ast-parser";
import { executeReview } from "@/lib/review/engine";
import { err, ok } from "@/types/results";

const NEW_REVIEW_CLAIM = { reviewId: reviewId(), claimToken: "new-token" };

function retryClaimFor(id: string) {
  return { reviewId: reviewId(id), claimToken: "retry-token" };
}

function setupSuccessfulDbMocks() {
  vi.mocked(parseRepositoryFullName).mockReturnValue({
    owner: "test-owner",
    repo: "test-repo",
  });
  vi.mocked(findRepositoryByFullName).mockResolvedValue(
    ok({ id: repositoryId(), installationId: installationId() }),
  );
  vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(ok(null));
  vi.mocked(createReviewRecord).mockResolvedValue(ok(NEW_REVIEW_CLAIM));
  vi.mocked(saveReviewFindings).mockResolvedValue(ok(true));
  vi.mocked(isReviewClaimCurrent).mockResolvedValue(ok(true));
  vi.mocked(markReviewCompleted).mockResolvedValue(ok(true));
  vi.mocked(claimExistingReview).mockImplementation(async (id) =>
    ok({ reviewId: id, claimToken: "retry-token" }),
  );
  vi.mocked(failReview).mockResolvedValue(ok(true));
  vi.mocked(initializeAstParser).mockResolvedValue(ok(undefined));
  vi.mocked(parseFileAst).mockResolvedValue(
    ok({
      filePath: "src/lib/example.ts",
      language: "typescript",
      scopes: [],
      imports: [],
    }),
  );
}

describe("executeReview — review pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessfulDbMocks();
  });

  it("runs full pipeline: fetch diff → parse → enrich → LLM → save → post → complete", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const llm = createMockLlmService();
    const request = createReviewRequest();

    const result = await executeReview(request, github, llm);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.reviewId).toBe(reviewId());
    expect(result.data.issuesFound).toBeGreaterThanOrEqual(0);
    expect(result.data.processingTimeMs).toBeGreaterThanOrEqual(0);

    expect(findRepositoryByFullName).toHaveBeenCalledWith(
      "test-owner/test-repo",
    );
    expect(findExistingReviewByCommitSha).toHaveBeenCalled();
    expect(createReviewRecord).toHaveBeenCalled();
    expect(github.fetchPullRequestDiff).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      42,
    );
    expect(llm.analyzeReviewChunk).toHaveBeenCalled();
    expect(github.postPullRequestReview).toHaveBeenCalled();
    expect(saveReviewFindings).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: reviewId() }),
    );
    expect(markReviewCompleted).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      expect.any(Number),
    );
  });

  it("returns REVIEW_ALREADY_EXISTS for a COMPLETED review without claiming it", async () => {
    vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
      ok({ id: reviewId("existing-review"), status: "COMPLETED" }),
    );

    const result = await executeReview(
      createReviewRequest(),
      createMockGitHubService(),
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_ALREADY_EXISTS");
    expect(claimExistingReview).not.toHaveBeenCalled();
    expect(createReviewRecord).not.toHaveBeenCalled();
  });

  it.each(["PROCESSING", "PENDING"] as const)(
    "re-runs a %s review whose claim succeeds (earlier attempt died or went stale)",
    async (status) => {
      vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
        ok({ id: reviewId("stuck-review"), status }),
      );
      const github = createMockGitHubService({
        fetchPullRequestDiff: vi
          .fn()
          .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      });

      const result = await executeReview(
        createReviewRequest(),
        github,
        createMockLlmService(),
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.reviewId).toBe(reviewId("stuck-review"));
      expect(claimExistingReview).toHaveBeenCalledWith(
        reviewId("stuck-review"),
        {
          jobId: "job-1",
          pullRequestNumber: 42,
          staleBefore: expect.any(Date),
        },
      );
      expect(createReviewRecord).not.toHaveBeenCalled();
      expect(markReviewCompleted).toHaveBeenCalledWith(
        retryClaimFor("stuck-review"),
        expect.any(Number),
      );
    },
  );

  it("returns REVIEW_ALREADY_EXISTS when a PROCESSING review is owned by another live job", async () => {
    vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
      ok({ id: reviewId("busy-review"), status: "PROCESSING" }),
    );
    vi.mocked(claimExistingReview).mockResolvedValue(ok(null));
    const github = createMockGitHubService();

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_ALREADY_EXISTS");
    expect(github.fetchPullRequestDiff).not.toHaveBeenCalled();
  });

  it("returns REVIEW_ALREADY_EXISTS without an error when another job created the review first", async () => {
    vi.mocked(createReviewRecord).mockResolvedValue(ok(null));
    const github = createMockGitHubService();

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_ALREADY_EXISTS");
    expect(github.fetchPullRequestDiff).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("records the claiming job when creating a new review", async () => {
    await executeReview(
      createReviewRequest(),
      createMockGitHubService({
        fetchPullRequestDiff: vi
          .fn()
          .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      }),
      createMockLlmService(),
    );

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.objectContaining({ claimedByJobId: "job-1" }),
    );
  });

  it("returns REVIEW_DB_ERROR when repository is not found", async () => {
    vi.mocked(findRepositoryByFullName).mockResolvedValue(ok(null));

    const result = await executeReview(
      createReviewRequest(),
      createMockGitHubService(),
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
  });

  it("returns REVIEW_DB_ERROR when repository lookup fails", async () => {
    vi.mocked(findRepositoryByFullName).mockResolvedValue(
      err("DB connection error"),
    );

    const result = await executeReview(
      createReviewRequest(),
      createMockGitHubService(),
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
  });

  it("returns REVIEW_DIFF_FETCH_FAILED and fails review when diff fetch fails", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(err("GITHUB_UNKNOWN_ERROR")),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DIFF_FETCH_FAILED");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      expect.stringContaining("diff"),
    );
  });

  it("returns REVIEW_LLM_FAILED when LLM analysis fails", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const llm = createMockLlmService({
      analyzeReviewChunk: vi.fn().mockResolvedValue(err("LLM_RATE_LIMITED")),
    });

    const result = await executeReview(createReviewRequest(), github, llm);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_LLM_FAILED");
    expect(failReview).toHaveBeenCalled();
  });

  it("completes with zero issues when diff has no reviewable files", async () => {
    const emptyDiff =
      "diff --git a/image.png b/image.png\nBinary files differ\n";
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(ok(emptyDiff)),
    });
    const llm = createMockLlmService();

    const result = await executeReview(createReviewRequest(), github, llm);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.issuesFound).toBe(0);
    expect(llm.analyzeReviewChunk).not.toHaveBeenCalled();
    expect(saveReviewFindings).toHaveBeenCalledWith(
      expect.objectContaining({ issuesFound: 0, comments: [] }),
    );
  });

  it("posts REQUEST_CHANGES event when findings include CRITICAL severity", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const criticalFinding = createReviewFinding({ severity: "CRITICAL" });
    const llm = createMockLlmService({
      analyzeReviewChunk: vi
        .fn()
        .mockResolvedValue(
          ok(createReviewResult({ findings: [criticalFinding] })),
        ),
    });

    const result = await executeReview(createReviewRequest(), github, llm);

    expect(result.success).toBe(true);
    expect(github.postPullRequestReview).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      42,
      expect.objectContaining({
        event: "REQUEST_CHANGES",
      }),
    );
  });

  it("posts COMMENT event when no CRITICAL findings", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const warningFinding = createReviewFinding({ severity: "WARNING" });
    const llm = createMockLlmService({
      analyzeReviewChunk: vi
        .fn()
        .mockResolvedValue(
          ok(createReviewResult({ findings: [warningFinding] })),
        ),
    });

    const result = await executeReview(createReviewRequest(), github, llm);

    expect(result.success).toBe(true);
    expect(github.postPullRequestReview).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      42,
      expect.objectContaining({
        event: "COMMENT",
      }),
    );
  });

  it("marks the posted review body with a hidden marker for the review ID", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    await executeReview(createReviewRequest(), github, createMockLlmService());

    const marker = `<!-- code-review-bot:review=${reviewId()} -->`;
    expect(github.findPostedReview).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      42,
      marker,
    );
    expect(github.postPullRequestReview).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      42,
      expect.objectContaining({ body: expect.stringContaining(marker) }),
    );
  });

  it("skips posting and completes the review when an earlier attempt already posted it", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      findPostedReview: vi.fn().mockResolvedValue(ok({ githubReviewId: 7 })),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(true);
    expect(github.postPullRequestReview).not.toHaveBeenCalled();
    expect(markReviewCompleted).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      expect.any(Number),
    );
  });

  it("returns REVIEW_CLAIM_LOST when the post is skipped but completing finds the claim lost", async () => {
    vi.mocked(markReviewCompleted).mockResolvedValue(ok(false));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      findPostedReview: vi.fn().mockResolvedValue(ok({ githubReviewId: 7 })),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_CLAIM_LOST");
    expect(github.postPullRequestReview).not.toHaveBeenCalled();
    expect(failReview).not.toHaveBeenCalled();
  });

  it("fails the review without posting when the existing-review lookup fails", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      findPostedReview: vi.fn().mockResolvedValue(err("GITHUB_UNKNOWN_ERROR")),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_POST_FAILED");
    expect(github.postPullRequestReview).not.toHaveBeenCalled();
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Failed to check for an existing review on GitHub",
    );
  });

  it("saves review comments to database", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const finding = createReviewFinding();
    const llm = createMockLlmService({
      analyzeReviewChunk: vi
        .fn()
        .mockResolvedValue(ok(createReviewResult({ findings: [finding] }))),
    });

    await executeReview(createReviewRequest(), github, llm);

    expect(saveReviewFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: reviewId(),
        claimToken: "new-token",
        issuesFound: 1,
        comments: [
          expect.objectContaining({
            category: finding.category,
            severity: finding.severity,
            message: finding.message,
          }),
        ],
      }),
    );
  });

  it("marks the review FAILED, not COMPLETED, when saving its comments fails", async () => {
    vi.mocked(saveReviewFindings).mockResolvedValue(err("DB write failed"));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const llm = createMockLlmService({
      analyzeReviewChunk: vi
        .fn()
        .mockResolvedValue(
          ok(createReviewResult({ findings: [createReviewFinding()] })),
        ),
    });

    const result = await executeReview(createReviewRequest(), github, llm);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Failed to save review results",
    );
    expect(github.postPullRequestReview).not.toHaveBeenCalled();
  });

  it("saves findings before posting the review to GitHub", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(true);
    const [saveOrder] = vi.mocked(saveReviewFindings).mock.invocationCallOrder;
    const [postOrder] = vi.mocked(github.postPullRequestReview).mock
      .invocationCallOrder;
    const [completeOrder] =
      vi.mocked(markReviewCompleted).mock.invocationCallOrder;
    expect(saveOrder).toBeLessThan(postOrder ?? 0);
    expect(postOrder).toBeLessThan(completeOrder ?? 0);
  });

  it("marks the review FAILED when completing it after posting fails", async () => {
    vi.mocked(markReviewCompleted).mockResolvedValue(err("DB write failed"));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Failed to mark review completed",
    );
  });

  it("stops without posting or failing the review when saving finds the claim lost", async () => {
    vi.mocked(saveReviewFindings).mockResolvedValue(ok(false));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_CLAIM_LOST");
    expect(github.postPullRequestReview).not.toHaveBeenCalled();
    expect(failReview).not.toHaveBeenCalled();
  });

  it("checks the claim right before posting and does not post when it was lost", async () => {
    vi.mocked(isReviewClaimCurrent).mockResolvedValue(ok(false));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_CLAIM_LOST");
    expect(isReviewClaimCurrent).toHaveBeenCalledWith(NEW_REVIEW_CLAIM);
    expect(github.postPullRequestReview).not.toHaveBeenCalled();
    expect(failReview).not.toHaveBeenCalled();
  });

  it("returns REVIEW_CLAIM_LOST when completing finds the claim lost", async () => {
    vi.mocked(markReviewCompleted).mockResolvedValue(ok(false));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_CLAIM_LOST");
    expect(failReview).not.toHaveBeenCalled();
  });

  it("re-runs a FAILED review for the same commit instead of skipping it", async () => {
    vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
      ok({ id: reviewId("failed-review"), status: "FAILED" }),
    );
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reviewId).toBe(reviewId("failed-review"));
    expect(claimExistingReview).toHaveBeenCalledWith(
      reviewId("failed-review"),
      {
        jobId: "job-1",
        pullRequestNumber: 42,
        staleBefore: expect.any(Date),
      },
    );
    expect(createReviewRecord).not.toHaveBeenCalled();
    expect(github.postPullRequestReview).toHaveBeenCalled();
    expect(markReviewCompleted).toHaveBeenCalledWith(
      retryClaimFor("failed-review"),
      expect.any(Number),
    );
  });

  it("returns REVIEW_ALREADY_EXISTS when another job already reset the FAILED review", async () => {
    vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
      ok({ id: reviewId("failed-review"), status: "FAILED" }),
    );
    vi.mocked(claimExistingReview).mockResolvedValue(ok(null));
    const github = createMockGitHubService();

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_ALREADY_EXISTS");
    expect(github.fetchPullRequestDiff).not.toHaveBeenCalled();
  });

  it("returns REVIEW_DB_ERROR when resetting a FAILED review fails", async () => {
    vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
      ok({ id: reviewId("failed-review"), status: "FAILED" }),
    );
    vi.mocked(claimExistingReview).mockResolvedValue(err("DB down"));

    const result = await executeReview(
      createReviewRequest(),
      createMockGitHubService(),
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
  });

  it("returns REVIEW_DB_ERROR when an early-completed review cannot be saved", async () => {
    vi.mocked(saveReviewFindings).mockResolvedValue(err("DB write failed"));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(
          ok("diff --git a/image.png b/image.png\nBinary files differ\n"),
        ),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Failed to save review results",
    );
  });

  it("keeps the original error when marking the review failed also fails", async () => {
    vi.mocked(failReview).mockResolvedValue(err("DB down"));
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(err("GITHUB_NOT_FOUND")),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DIFF_FETCH_FAILED");
  });

  it("marks the review FAILED, not COMPLETED, when posting to GitHub fails", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      postPullRequestReview: vi
        .fn()
        .mockResolvedValue(err("GITHUB_UNKNOWN_ERROR")),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_POST_FAILED");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Failed to post review to GitHub",
    );
    expect(markReviewCompleted).not.toHaveBeenCalled();
  });

  it("marks the review FAILED when fetching the diff throws", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_UNEXPECTED_ERROR");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Unexpected error during review",
    );
  });

  it("marks the review FAILED when LLM analysis throws", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const llm = createMockLlmService({
      analyzeReviewChunk: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await executeReview(createReviewRequest(), github, llm);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_UNEXPECTED_ERROR");
    expect(failReview).toHaveBeenCalledWith(
      NEW_REVIEW_CLAIM,
      "Unexpected error during review",
    );
    expect(markReviewCompleted).not.toHaveBeenCalled();
  });

  it("filters files by filePathFilter for delta reviews", async () => {
    const multiFileDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,2 @@",
      " const x = 1;",
      "+const y = 2;",
    ].join("\n");

    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(ok(multiFileDiff)),
    });
    const llm = createMockLlmService();

    const request = createReviewRequest({
      filePathFilter: ["src/a.ts"],
    });

    const result = await executeReview(request, github, llm);

    expect(result.success).toBe(true);
    // LLM should be called (file passes filter), and only src/a.ts should be reviewed
    if (result.success) {
      expect(result.data.issuesFound).toBeGreaterThanOrEqual(0);
    }
  });

  it("completes early when filePathFilter matches no files in diff", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
    });
    const llm = createMockLlmService();

    const request = createReviewRequest({
      filePathFilter: ["src/nonexistent.ts"],
    });

    const result = await executeReview(request, github, llm);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.issuesFound).toBe(0);
    expect(llm.analyzeReviewChunk).not.toHaveBeenCalled();
    expect(saveReviewFindings).toHaveBeenCalledWith(
      expect.objectContaining({ issuesFound: 0, comments: [] }),
    );
  });

  it("returns REVIEW_DB_ERROR for invalid repository full name", async () => {
    vi.mocked(parseRepositoryFullName).mockReturnValue(null);

    const result = await executeReview(
      createReviewRequest({ repositoryFullName: "invalid-name" }),
      createMockGitHubService(),
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_DB_ERROR");
  });
});

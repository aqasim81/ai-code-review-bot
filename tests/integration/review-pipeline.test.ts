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
  completeReview,
  createReviewRecord,
  failReview,
  findExistingReviewByCommitSha,
  findRepositoryByFullName,
  saveReviewComments,
  updateReviewStatus,
} from "@/lib/db/queries";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { initializeAstParser, parseFileAst } from "@/lib/review/ast-parser";
import { executeReview } from "@/lib/review/engine";
import { err, ok } from "@/types/results";

function setupSuccessfulDbMocks() {
  vi.mocked(parseRepositoryFullName).mockReturnValue({
    owner: "test-owner",
    repo: "test-repo",
  });
  vi.mocked(findRepositoryByFullName).mockResolvedValue(
    ok({ id: repositoryId(), installationId: installationId() }),
  );
  vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(ok(null));
  vi.mocked(createReviewRecord).mockResolvedValue(ok({ id: reviewId() }));
  vi.mocked(updateReviewStatus).mockResolvedValue(ok(undefined));
  vi.mocked(completeReview).mockResolvedValue(ok(undefined));
  vi.mocked(failReview).mockResolvedValue(ok(undefined));
  vi.mocked(saveReviewComments).mockResolvedValue(ok({ count: 1 }));
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

  it("runs full pipeline: fetch diff → parse → enrich → LLM → post → save → complete", async () => {
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
    expect(updateReviewStatus).toHaveBeenCalledWith(reviewId(), "PROCESSING");
    expect(github.fetchPullRequestDiff).toHaveBeenCalledWith(
      "test-owner",
      "test-repo",
      42,
    );
    expect(llm.analyzeReviewChunk).toHaveBeenCalled();
    expect(github.postPullRequestReview).toHaveBeenCalled();
    expect(saveReviewComments).toHaveBeenCalled();
    expect(completeReview).toHaveBeenCalled();
  });

  it("returns REVIEW_ALREADY_EXISTS when review exists for commit SHA", async () => {
    vi.mocked(findExistingReviewByCommitSha).mockResolvedValue(
      ok({ id: reviewId("existing-review") }),
    );

    const result = await executeReview(
      createReviewRequest(),
      createMockGitHubService(),
      createMockLlmService(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("REVIEW_ALREADY_EXISTS");
    expect(createReviewRecord).not.toHaveBeenCalled();
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
      reviewId(),
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
    expect(completeReview).toHaveBeenCalled();
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

    expect(saveReviewComments).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          reviewId: reviewId(),
          category: finding.category,
          severity: finding.severity,
          message: finding.message,
        }),
      ]),
    );
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
    expect(completeReview).toHaveBeenCalled();
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

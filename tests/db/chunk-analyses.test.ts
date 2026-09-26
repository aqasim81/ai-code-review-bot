import { describe, expect, it, vi } from "vitest";
import {
  failReview,
  findChunkAnalyses,
  markReviewCompleted,
  saveChunkAnalysis,
} from "@/lib/db/queries";
import { executeReview } from "@/lib/review/engine";
import type { ReviewId } from "@/types/branded";
import { err, ok } from "@/types/results";
import type { ReviewChunk, ReviewClaimRef } from "@/types/review";
import {
  createMockGitHubService,
  createMockLlmService,
  createReviewFinding,
  createReviewRequest,
  createReviewResult,
  createReviewResultForChunk,
} from "../helpers/factories";
import {
  createActiveRepository,
  GITHUB_INSTALLATION_ID,
  GITHUB_REPO_ID,
  testPrisma,
} from "./database";

// The tree-sitter WASM grammar is not what this test is about.
vi.mock("@/lib/review/ast-parser", () => ({
  initializeAstParser: vi.fn(async () => ok(undefined)),
  parseFileAst: vi.fn(async () =>
    ok({ filePath: "", language: "typescript", scopes: [], imports: [] }),
  ),
}));

// A new file large enough (~24k estimated tokens) to fill a review chunk of
// its own, so three of them make three chunks.
function largeAddedFileDiff(filePath: string): string {
  const lineCount = 800;
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `+export const value${index} = "${"x".repeat(80)}";`,
  );
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...lines,
    "",
  ].join("\n");
}

const THREE_CHUNK_DIFF = ["src/a.ts", "src/b.ts", "src/c.ts"]
  .map(largeAddedFileDiff)
  .join("");

function reviewRequest(isFinalAttempt: boolean) {
  return createReviewRequest({
    installationId: GITHUB_INSTALLATION_ID,
    githubRepoId: GITHUB_REPO_ID,
    repositoryFullName: "octo-org/repo",
    isFinalAttempt,
  });
}

function githubServiceFor(commitSha: string) {
  return createMockGitHubService({
    fetchPullRequestDiff: vi.fn(async () => ok(THREE_CHUNK_DIFF)),
    fetchPullRequestHeadSha: vi.fn(async () => ok(commitSha)),
  });
}

/** Fails the third chunk it is sent, as a rate limit would. */
function modelRateLimitedAtThirdChunk() {
  let calls = 0;
  return createMockLlmService({
    analyzeReviewChunk: vi.fn(async (chunk: ReviewChunk) => {
      calls++;
      if (calls === 3) return err("LLM_RATE_LIMITED" as const);
      // A NUL would fail the jsonb write of the saved analysis.
      return ok(
        createReviewResultForChunk(chunk, { message: "nul\u0000here" }),
      );
    }),
  });
}

describe("a job retry after a chunk failed (#143)", () => {
  it("sends the model only the chunks that did not succeed before", async () => {
    await createActiveRepository();
    const firstAttempt = await executeReview(
      reviewRequest(false),
      githubServiceFor(reviewRequest(false).commitSha),
      modelRateLimitedAtThirdChunk(),
    );
    expect(firstAttempt).toEqual({
      success: false,
      error: "REVIEW_LLM_RATE_LIMITED",
    });

    const retryModel = createMockLlmService();
    const retry = await executeReview(
      reviewRequest(false),
      githubServiceFor(reviewRequest(false).commitSha),
      retryModel,
    );

    expect(retry.success).toBe(true);
    expect(retryModel.analyzeReviewChunk).toHaveBeenCalledTimes(1);
    const review = await testPrisma.review.findFirstOrThrow({
      include: { comments: true },
    });
    expect(review.status).toBe("COMPLETED");
    expect(review.comments.map((comment) => comment.filePath).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(review.comments.map((comment) => comment.message)).toContain(
      "nulhere",
    );
  });

  it("drops the saved analyses once the review is completed", async () => {
    await createActiveRepository();
    const request = reviewRequest(false);
    await executeReview(
      request,
      githubServiceFor(request.commitSha),
      modelRateLimitedAtThirdChunk(),
    );
    expect(await testPrisma.reviewChunkAnalysis.count()).toBe(2);

    await executeReview(
      request,
      githubServiceFor(request.commitSha),
      createMockLlmService(),
    );

    expect(await testPrisma.reviewChunkAnalysis.count()).toBe(0);
  });

  it("analyses every chunk again when the settings changed between attempts", async () => {
    const repositoryId = await createActiveRepository();
    const request = reviewRequest(false);
    await executeReview(
      request,
      githubServiceFor(request.commitSha),
      modelRateLimitedAtThirdChunk(),
    );
    await testPrisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { customInstructions: "Focus on error handling." } },
    });

    const retryModel = createMockLlmService();
    await executeReview(
      request,
      githubServiceFor(request.commitSha),
      retryModel,
    );

    expect(retryModel.analyzeReviewChunk).toHaveBeenCalledTimes(3);
  });
});

describe("saveChunkAnalysis and findChunkAnalyses", () => {
  async function createClaimedReview(): Promise<ReviewClaimRef> {
    const repositoryId = await createActiveRepository();
    const review = await testPrisma.review.create({
      data: {
        repositoryId,
        pullRequestNumber: 1,
        commitSha: "sha",
        status: "PROCESSING",
        claimToken: "token",
      },
    });
    return { reviewId: review.id as ReviewId, claimToken: "token" };
  }

  it("reads back what was saved, and a second save of the same chunk is a no-op", async () => {
    const claim = await createClaimedReview();
    const first = createReviewResult({
      findings: [createReviewFinding({ message: "first" })],
    });
    const second = createReviewResult({
      findings: [createReviewFinding({ message: "second" })],
    });

    expect(await saveChunkAnalysis(claim, "key-1", first)).toEqual(ok(true));
    expect(await saveChunkAnalysis(claim, "key-1", second)).toEqual(ok(true));

    const found = await findChunkAnalyses(claim.reviewId, ["key-1", "key-2"]);
    expect(found.success).toBe(true);
    if (!found.success) return;
    expect([...found.data.keys()]).toEqual(["key-1"]);
    expect(found.data.get("key-1")).toEqual(first);
  });

  it("keeps token counts within the column's range", async () => {
    const claim = await createClaimedReview();
    const result = createReviewResult({
      tokenUsage: { inputTokens: 2 ** 40, outputTokens: -5 },
    });

    expect(await saveChunkAnalysis(claim, "key", result)).toEqual(ok(true));
  });

  it("stores text with an unpaired surrogate, which jsonb rejects", async () => {
    const claim = await createClaimedReview();
    const result = createReviewResult({
      findings: [createReviewFinding({ message: "lone \ud800 surrogate" })],
    });

    expect(await saveChunkAnalysis(claim, "key", result)).toEqual(ok(true));
  });

  it("saves nothing for an attempt whose claim was lost, such as after the review completed", async () => {
    const claim = await createClaimedReview();
    await markReviewCompleted(claim, 10);

    expect(await saveChunkAnalysis(claim, "key", createReviewResult())).toEqual(
      ok(false),
    );
    expect(await testPrisma.reviewChunkAnalysis.count()).toBe(0);
  });

  it("keeps the analyses of a review failed before a retry, and drops them when none will come", async () => {
    const claim = await createClaimedReview();
    await saveChunkAnalysis(claim, "key", createReviewResult());
    await failReview(claim, "rate limited");
    expect(await testPrisma.reviewChunkAnalysis.count()).toBe(1);

    const retryClaim = { ...claim, claimToken: "retry" };
    await testPrisma.review.update({
      where: { id: claim.reviewId },
      data: { status: "PROCESSING", claimToken: "retry" },
    });
    await failReview(retryClaim, "rate limited", { dropChunkAnalyses: true });

    expect(await testPrisma.reviewChunkAnalysis.count()).toBe(0);
  });
});

describe("a review failed on the job's final attempt (#143)", () => {
  it("drops its chunk analyses, as no retry will reuse them", async () => {
    await createActiveRepository();
    const request = reviewRequest(true);
    const model = createMockLlmService({
      analyzeReviewChunk: vi.fn(async (chunk: ReviewChunk) =>
        ok(createReviewResultForChunk(chunk)),
      ),
    });
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn(async () => ok(THREE_CHUNK_DIFF)),
      fetchPullRequestHeadSha: vi.fn(async () => ok(request.commitSha)),
      postPullRequestReview: vi.fn(async () =>
        err("GITHUB_REQUEST_REJECTED" as const),
      ),
    });

    const result = await executeReview(request, github, model);

    expect(result).toEqual({ success: false, error: "REVIEW_POST_REJECTED" });
    expect(await testPrisma.reviewChunkAnalysis.count()).toBe(0);
  });
});

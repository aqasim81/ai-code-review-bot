import { afterEach, describe, expect, it, vi } from "vitest";
import { executeReview } from "@/lib/review/engine";
import { expireStaleReviews } from "@/lib/review/stale-reviews";
import { ok } from "@/types/results";
import type { ReviewResult } from "@/types/review";
import { SINGLE_FILE_TYPESCRIPT_DIFF } from "../fixtures/diffs";
import {
  createMockGitHubService,
  createMockLlmService,
  createReviewRequest,
  createReviewResult,
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
    ok({
      filePath: "src/lib/example.ts",
      language: "typescript",
      scopes: [],
      imports: [],
    }),
  ),
}));

const MINUTE_MS = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

async function realDelay(ms: number): Promise<void> {
  const { setTimeout: wait } = await vi.importActual<
    typeof import("node:timers/promises")
  >("node:timers/promises");
  await wait(ms);
}

describe("a review that runs past the stale cutoff (#114)", () => {
  it("is not expired by the sweep while its run is still working", async () => {
    await createActiveRepository();
    // Only the clock and intervals are faked; Prisma's own timers stay real.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });

    let finishModelCall: (result: ReviewResult) => void = () => {};
    let modelCalled = false;
    const llmService = createMockLlmService({
      analyzeReviewChunk: vi.fn(async () => {
        modelCalled = true;
        const result = await new Promise<ReviewResult>((resolve) => {
          finishModelCall = resolve;
        });
        return ok(result);
      }),
    });
    const request = createReviewRequest({
      installationId: GITHUB_INSTALLATION_ID,
      githubRepoId: GITHUB_REPO_ID,
      repositoryFullName: "octo-org/repo",
    });
    const githubService = createMockGitHubService({
      fetchPullRequestDiff: vi.fn(async () => ok(SINGLE_FILE_TYPESCRIPT_DIFF)),
      fetchPullRequestHeadSha: vi.fn(async () => ok(request.commitSha)),
    });

    const review = executeReview(request, githubService, llmService);
    while (!modelCalled) await realDelay(20);

    // A slow model call: 31 minutes pass, five at a time.
    for (let elapsed = 0; elapsed < 31; elapsed += 5) {
      await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
      await realDelay(100);
    }
    const sweep = await expireStaleReviews(Date.now());

    finishModelCall(createReviewResult());
    const result = await review;

    expect(sweep).toEqual({ success: true, data: { expiredCount: 0 } });
    expect(result.success).toBe(true);
    const row = await testPrisma.review.findFirstOrThrow();
    expect(row.status).toBe("COMPLETED");
  });
});

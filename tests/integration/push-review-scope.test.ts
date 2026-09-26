import { beforeEach, describe, expect, it, vi } from "vitest";
import { MULTI_FILE_DIFF, NON_REVIEWABLE_FILES_DIFF } from "../fixtures/diffs";
import {
  createMockGitHubService,
  createMockLlmService,
  createReviewRequest,
  createReviewResult,
  repositoryId,
  reviewId,
} from "../helpers/factories";

vi.mock("@/lib/db/queries");
vi.mock("@/lib/review/ast-parser");
vi.mock("@/lib/repository-utils");

import {
  createReviewRecord,
  findExistingReviewForPullRequestCommit,
  findOrCreateRepositoryForReview,
  isReviewClaimCurrent,
  markReviewCompleted,
  markReviewSuperseded,
  renewReviewClaim,
  saveReviewFindings,
} from "@/lib/db/queries";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { initializeAstParser } from "@/lib/review/ast-parser";
import { executeReview } from "@/lib/review/engine";
import { fingerprintReviewSettings } from "@/lib/review/settings-filter";
import { err, ok } from "@/types/results";
import type { ReviewChunk } from "@/types/review";
import { mergeWithDefaults } from "@/types/settings";

const CLAIM = { reviewId: reviewId(), claimToken: "token" };
const DEFAULT_FINGERPRINT = fingerprintReviewSettings(mergeWithDefaults({}));
const MULTI_FILE_PATHS = [
  "src/lib/auth.ts",
  "src/lib/handler.py",
  "src/main.go",
];

// A new file too large to share a review chunk with another one.
function largeAddedFileDiff(filePath: string, lineCount = 800): string {
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

function reviewedFilePaths(
  analyze: ReturnType<typeof createMockLlmService>["analyzeReviewChunk"],
): string[] {
  return vi
    .mocked(analyze)
    .mock.calls.flatMap(([chunk]: [ReviewChunk, unknown]) =>
      chunk.files.map((file) => file.filePath),
    )
    .sort();
}

function savedCoverage() {
  const [input] = vi.mocked(saveReviewFindings).mock.calls.at(-1) ?? [];
  return {
    coveredFilePaths: [...(input?.coveredFilePaths ?? [])].sort(),
    settingsFingerprint: input?.settingsFingerprint,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRepositoryFullName).mockReturnValue({
    owner: "test-owner",
    repo: "test-repo",
  });
  vi.mocked(findOrCreateRepositoryForReview).mockResolvedValue(
    ok({
      id: repositoryId(),
      isEnabled: true,
      settings: mergeWithDefaults({}),
    }),
  );
  vi.mocked(findExistingReviewForPullRequestCommit).mockResolvedValue(ok(null));
  vi.mocked(createReviewRecord).mockResolvedValue(ok(CLAIM));
  vi.mocked(saveReviewFindings).mockResolvedValue(ok(true));
  vi.mocked(isReviewClaimCurrent).mockResolvedValue(ok(true));
  vi.mocked(markReviewCompleted).mockResolvedValue(ok(true));
  vi.mocked(markReviewSuperseded).mockResolvedValue(ok(true));
  vi.mocked(renewReviewClaim).mockResolvedValue(ok(true));
  vi.mocked(initializeAstParser).mockResolvedValue(err("AST_INIT_FAILED"));
});

describe("executeReview — what a push review covers (#129)", () => {
  it("reviews changed files and files the base review did not cover", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(ok(MULTI_FILE_DIFF)),
    });
    const llm = createMockLlmService();

    const result = await executeReview(
      createReviewRequest({
        pushReviewBase: {
          changedFilePaths: ["src/lib/auth.ts"],
          // handler.py came in with a base-branch change, or its chunk failed.
          coveredFilePaths: ["src/lib/auth.ts", "src/main.go"],
          settingsFingerprint: DEFAULT_FINGERPRINT,
        },
      }),
      github,
      llm,
    );

    expect(result.success).toBe(true);
    expect(reviewedFilePaths(llm.analyzeReviewChunk)).toEqual([
      "src/lib/auth.ts",
      "src/lib/handler.py",
    ]);
    expect(savedCoverage()).toEqual({
      coveredFilePaths: MULTI_FILE_PATHS,
      settingsFingerprint: DEFAULT_FINGERPRINT,
    });
  });

  it("reviews the whole pull request when the settings changed since the base", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(ok(MULTI_FILE_DIFF)),
    });
    const llm = createMockLlmService();

    await executeReview(
      createReviewRequest({
        pushReviewBase: {
          changedFilePaths: [],
          coveredFilePaths: MULTI_FILE_PATHS,
          settingsFingerprint: "settings before a category was enabled",
        },
      }),
      github,
      llm,
    );

    expect(reviewedFilePaths(llm.analyzeReviewChunk)).toEqual(MULTI_FILE_PATHS);
  });

  it("leaves the files of a chunk that failed on the final attempt uncovered", async () => {
    const diff = `${largeAddedFileDiff("src/first.ts")}${largeAddedFileDiff("src/second.ts")}`;
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(ok(diff)),
    });
    const llm = createMockLlmService({
      analyzeReviewChunk: vi
        .fn()
        .mockResolvedValueOnce(ok(createReviewResult()))
        .mockResolvedValueOnce(err("LLM_TIMEOUT")),
    });

    const result = await executeReview(
      createReviewRequest({ isFinalAttempt: true }),
      github,
      llm,
    );

    expect(result.success).toBe(true);
    expect(savedCoverage().coveredFilePaths).toEqual(["src/first.ts"]);
  });
});

describe("executeReview — completing without analysis (#128)", () => {
  it("marks the review SUPERSEDED when the head moved, rather than COMPLETED", async () => {
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi
        .fn()
        .mockResolvedValue(ok(NON_REVIEWABLE_FILES_DIFF)),
      fetchPullRequestHeadSha: vi.fn().mockResolvedValue(ok("newer-commit")),
    });

    const result = await executeReview(
      createReviewRequest(),
      github,
      createMockLlmService(),
    );

    expect(result.success).toBe(true);
    expect(markReviewSuperseded).toHaveBeenCalled();
    expect(markReviewCompleted).not.toHaveBeenCalled();
  });
});

describe("executeReview — the time GitHub reported the commit (#127, #128)", () => {
  it("orders the repository name and the review by the event, not the run", async () => {
    const eventReceivedAt = new Date("2026-09-01T10:00:00Z");
    const github = createMockGitHubService({
      fetchPullRequestDiff: vi.fn().mockResolvedValue(ok(MULTI_FILE_DIFF)),
    });

    await executeReview(
      createReviewRequest({ eventReceivedAt }),
      github,
      createMockLlmService(),
    );

    expect(findOrCreateRepositoryForReview).toHaveBeenCalledWith(
      expect.objectContaining({ nameSeenAt: eventReceivedAt }),
    );
    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.objectContaining({ headSeenAt: eventReceivedAt }),
    );
  });
});

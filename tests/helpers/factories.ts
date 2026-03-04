import { vi } from "vitest";
import type { InstallationId, RepositoryId, ReviewId } from "@/types/branded";
import type {
  CommitComparisonResult,
  GitHubService,
  PostedReviewResult,
} from "@/types/github";
import type { LLMService } from "@/types/llm";
import { ok } from "@/types/results";
import type {
  AstFileContext,
  AstImport,
  AstScope,
  CommentMappingResult,
  DiffHunk,
  DiffLine,
  EnrichedHunk,
  FileReviewContext,
  MappedReviewComment,
  ParsedDiff,
  ParsedDiffFile,
  ReviewChunk,
  ReviewEngineResult,
  ReviewFinding,
  ReviewRequest,
  ReviewResult,
  UnmappedFinding,
} from "@/types/review";

// --- Diff types ---

export function createDiffLine(overrides?: Partial<DiffLine>): DiffLine {
  return {
    type: "added",
    content: 'const x = "hello";',
    newLineNumber: 1,
    oldLineNumber: null,
    ...overrides,
  };
}

export function createDiffHunk(overrides?: Partial<DiffHunk>): DiffHunk {
  return {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 5,
    header: "@@ -1,3 +1,5 @@",
    lines: [
      createDiffLine({
        type: "context",
        content: "// existing",
        newLineNumber: 1,
        oldLineNumber: 1,
      }),
      createDiffLine({
        type: "added",
        content: "const a = 1;",
        newLineNumber: 2,
        oldLineNumber: null,
      }),
      createDiffLine({
        type: "added",
        content: "const b = 2;",
        newLineNumber: 3,
        oldLineNumber: null,
      }),
      createDiffLine({
        type: "context",
        content: "// more existing",
        newLineNumber: 4,
        oldLineNumber: 2,
      }),
    ],
    ...overrides,
  };
}

export function createParsedDiffFile(
  overrides?: Partial<ParsedDiffFile>,
): ParsedDiffFile {
  return {
    filePath: "src/lib/example.ts",
    previousFilePath: null,
    changeType: "modified",
    language: "typescript",
    hunks: [createDiffHunk()],
    isBinary: false,
    ...overrides,
  };
}

export function createParsedDiff(overrides?: Partial<ParsedDiff>): ParsedDiff {
  return {
    files: [createParsedDiffFile()],
    ...overrides,
  };
}

// --- AST types ---

export function createAstScope(overrides?: Partial<AstScope>): AstScope {
  return {
    type: "function",
    name: "handleRequest",
    startLine: 1,
    endLine: 20,
    ...overrides,
  };
}

export function createAstImport(overrides?: Partial<AstImport>): AstImport {
  return {
    source: "@/lib/utils",
    specifiers: ["formatDate"],
    isDefault: false,
    ...overrides,
  };
}

export function createAstFileContext(
  overrides?: Partial<AstFileContext>,
): AstFileContext {
  return {
    filePath: "src/lib/example.ts",
    language: "typescript",
    scopes: [createAstScope()],
    imports: [createAstImport()],
    ...overrides,
  };
}

// --- Context Builder types ---

export function createEnrichedHunk(
  overrides?: Partial<EnrichedHunk>,
): EnrichedHunk {
  return {
    hunk: createDiffHunk(),
    enclosingScopes: [createAstScope()],
    ...overrides,
  };
}

export function createFileReviewContext(
  overrides?: Partial<FileReviewContext>,
): FileReviewContext {
  return {
    filePath: "src/lib/example.ts",
    language: "typescript",
    changeType: "modified",
    enrichedHunks: [createEnrichedHunk()],
    imports: [createAstImport()],
    fullFileContent: 'const x = "hello";\n',
    ...overrides,
  };
}

export function createReviewChunk(
  overrides?: Partial<ReviewChunk>,
): ReviewChunk {
  return {
    files: [createFileReviewContext()],
    estimatedTokenCount: 500,
    ...overrides,
  };
}

// --- LLM / Finding types ---

export function createReviewFinding(
  overrides?: Partial<ReviewFinding>,
): ReviewFinding {
  return {
    filePath: "src/lib/example.ts",
    lineNumber: 2,
    category: "BUGS",
    severity: "WARNING",
    message: "Potential null reference",
    suggestion: "Add null check before accessing property",
    confidence: 0.85,
    ...overrides,
  };
}

export function createReviewResult(
  overrides?: Partial<ReviewResult>,
): ReviewResult {
  return {
    findings: [createReviewFinding()],
    summary: "Found 1 issue",
    tokenUsage: { inputTokens: 1000, outputTokens: 200 },
    ...overrides,
  };
}

// --- Comment Mapper types ---

export function createMappedReviewComment(
  overrides?: Partial<MappedReviewComment>,
): MappedReviewComment {
  return {
    finding: createReviewFinding(),
    path: "src/lib/example.ts",
    line: 2,
    side: "RIGHT",
    formattedBody: "**Warning** | Bug Risk\n\nPotential null reference",
    ...overrides,
  };
}

export function createUnmappedFinding(
  overrides?: Partial<UnmappedFinding>,
): UnmappedFinding {
  return {
    finding: createReviewFinding(),
    reason: "Line not found in diff hunks",
    ...overrides,
  };
}

export function createCommentMappingResult(
  overrides?: Partial<CommentMappingResult>,
): CommentMappingResult {
  return {
    mappedComments: [createMappedReviewComment()],
    unmappedFindings: [],
    ...overrides,
  };
}

// --- Review Engine types ---

export function createReviewRequest(
  overrides?: Partial<ReviewRequest>,
): ReviewRequest {
  return {
    installationId: 12345,
    repositoryFullName: "test-owner/test-repo",
    pullRequestNumber: 42,
    commitSha: "abc123def456",
    ...overrides,
  };
}

export function createReviewEngineResult(
  overrides?: Partial<ReviewEngineResult>,
): ReviewEngineResult {
  return {
    reviewId: "test-review-id" as ReviewId,
    issuesFound: 1,
    processingTimeMs: 1500,
    summary: "Found 1 issue",
    ...overrides,
  };
}

// --- Service mocks ---

export function createMockGitHubService(
  overrides?: Partial<GitHubService>,
): GitHubService {
  return {
    fetchPullRequestDiff: vi
      .fn<GitHubService["fetchPullRequestDiff"]>()
      .mockResolvedValue(ok("diff --git a/file.ts b/file.ts\n")),
    fetchFileContent: vi
      .fn<GitHubService["fetchFileContent"]>()
      .mockResolvedValue(ok('const x = "hello";\n')),
    postPullRequestReview: vi
      .fn<GitHubService["postPullRequestReview"]>()
      .mockResolvedValue(
        ok({
          githubReviewId: 1,
          postedCommentCount: 1,
        } satisfies PostedReviewResult),
      ),
    compareCommits: vi.fn<GitHubService["compareCommits"]>().mockResolvedValue(
      ok({
        files: [{ filename: "src/lib/example.ts", status: "modified" }],
      } satisfies CommitComparisonResult),
    ),
    ...overrides,
  };
}

export function createMockLlmService(
  overrides?: Partial<LLMService>,
): LLMService {
  return {
    analyzeReviewChunk: vi
      .fn<LLMService["analyzeReviewChunk"]>()
      .mockResolvedValue(ok(createReviewResult())),
    ...overrides,
  };
}

// --- Branded type helpers ---

export function installationId(id = "test-installation-id"): InstallationId {
  return id as InstallationId;
}

export function repositoryId(id = "test-repository-id"): RepositoryId {
  return id as RepositoryId;
}

export function reviewId(id = "test-review-id"): ReviewId {
  return id as ReviewId;
}

import {
  completeReview,
  createReviewRecord,
  failReview,
  findExistingReviewByCommitSha,
  findRepositoryByFullName,
  saveReviewComments,
  updateReviewStatus,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { initializeAstParser, parseFileAst } from "@/lib/review/ast-parser";
import {
  buildReviewSummary,
  mapFindingsToGitHubComments,
} from "@/lib/review/comment-mapper";
import { buildReviewContext } from "@/lib/review/context-builder";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import type { RepositoryId, ReviewId } from "@/types/branded";
import type { ReviewEngineError } from "@/types/errors";
import type { GitHubService } from "@/types/github";
import type { LLMService } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  AstFileContext,
  ParsedDiff,
  ReviewChunk,
  ReviewEngineResult,
  ReviewFinding,
  ReviewRequest,
  SupportedLanguage,
} from "@/types/review";

const SUPPORTED_LANGUAGES = new Set<string>([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
]);

function isSupportedLanguage(language: string): language is SupportedLanguage {
  return SUPPORTED_LANGUAGES.has(language);
}

function parseRepositoryFullName(
  fullName: string,
): Result<{ owner: string; repo: string }, "REVIEW_DB_ERROR"> {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.error("Invalid repository full name", { fullName });
    return err("REVIEW_DB_ERROR");
  }
  return ok({ owner: parts[0], repo: parts[1] });
}

async function lookupRepositoryAndCheckIdempotency(
  repositoryFullName: string,
  commitSha: string,
): Promise<Result<{ repositoryId: RepositoryId }, ReviewEngineError>> {
  const repoResult = await findRepositoryByFullName(repositoryFullName);
  if (!repoResult.success) {
    logger.error("Failed to look up repository", {
      error: repoResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  if (!repoResult.data) {
    logger.error("Repository not found or disabled", {
      repository: repositoryFullName,
    });
    return err("REVIEW_DB_ERROR");
  }

  const existingResult = await findExistingReviewByCommitSha(
    repoResult.data.id,
    commitSha,
  );
  if (!existingResult.success) {
    logger.error("Idempotency check failed", {
      error: existingResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  if (existingResult.data) {
    logger.info("Review already exists for commit, skipping", {
      reviewId: existingResult.data.id,
      commitSha,
    });
    return err("REVIEW_ALREADY_EXISTS");
  }

  return ok({ repositoryId: repoResult.data.id });
}

async function fetchAndParseDiff(
  githubService: GitHubService,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: ReviewId,
): Promise<Result<ParsedDiff, ReviewEngineError>> {
  const diffResult = await githubService.fetchPullRequestDiff(
    owner,
    repo,
    pullNumber,
  );
  if (!diffResult.success) {
    logger.error("Failed to fetch diff", { error: diffResult.error });
    await failReview(reviewId, "Failed to fetch PR diff");
    return err("REVIEW_DIFF_FETCH_FAILED");
  }

  const parsedDiffResult = parseUnifiedDiff(diffResult.data);
  if (!parsedDiffResult.success) {
    logger.error("Failed to parse diff", {
      error: parsedDiffResult.error,
    });
    await failReview(reviewId, "Failed to parse PR diff");
    return err("REVIEW_DIFF_PARSE_FAILED");
  }

  return ok(parsedDiffResult.data);
}

async function fetchFileContentsForDiff(
  githubService: GitHubService,
  owner: string,
  repo: string,
  commitSha: string,
  filePaths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();

  const results = await Promise.allSettled(
    filePaths.map(async (filePath) => {
      const result = await githubService.fetchFileContent(
        owner,
        repo,
        filePath,
        commitSha,
      );
      if (result.success) {
        contents.set(filePath, result.data);
      } else {
        logger.warn("Failed to fetch file content, skipping AST enrichment", {
          filePath,
          error: result.error,
        });
      }
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Unexpected error fetching file content", {
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  return contents;
}

async function parseAstContextsForFiles(
  fileContents: ReadonlyMap<string, string>,
  filePaths: readonly { path: string; language: string | null }[],
): Promise<ReadonlyMap<string, AstFileContext>> {
  const astContexts = new Map<string, AstFileContext>();

  const initResult = await initializeAstParser();
  if (!initResult.success) {
    logger.warn("AST parser initialization failed, skipping AST enrichment", {
      error: initResult.error,
    });
    return astContexts;
  }

  for (const { path, language } of filePaths) {
    if (!language || !isSupportedLanguage(language)) continue;

    const content = fileContents.get(path);
    if (!content) continue;

    const result = await parseFileAst(content, language, path);
    if (result.success) {
      astContexts.set(path, result.data);
    } else {
      logger.warn("AST parsing failed for file, skipping enrichment", {
        filePath: path,
        language,
        error: result.error,
      });
    }
  }

  return astContexts;
}

async function enrichDiffWithContext(
  githubService: GitHubService,
  parsedDiff: ParsedDiff,
  owner: string,
  repo: string,
  commitSha: string,
): Promise<Result<readonly ReviewChunk[], "REVIEW_LLM_FAILED">> {
  const reviewableFiles = parsedDiff.files.filter(
    (f) => !f.isBinary && f.changeType !== "deleted",
  );

  const fileContents = await fetchFileContentsForDiff(
    githubService,
    owner,
    repo,
    commitSha,
    reviewableFiles.map((f) => f.filePath),
  );

  const fileLanguages = reviewableFiles.map((f) => ({
    path: f.filePath,
    language: f.language,
  }));
  const astContexts = await parseAstContextsForFiles(
    fileContents,
    fileLanguages,
  );

  const contextResult = buildReviewContext(
    parsedDiff,
    astContexts,
    fileContents,
  );
  if (!contextResult.success) {
    logger.warn("Context build returned no reviewable files", {
      error: contextResult.error,
    });
    return ok([]);
  }

  return ok(contextResult.data);
}

interface LlmAnalysisResult {
  readonly findings: ReviewFinding[];
  readonly summary: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

async function analyzeAllChunks(
  llmService: LLMService,
  chunks: readonly ReviewChunk[],
): Promise<Result<LlmAnalysisResult, "REVIEW_LLM_FAILED">> {
  const allFindings: ReviewFinding[] = [];
  const summaries: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const chunk of chunks) {
    const result = await llmService.analyzeReviewChunk(chunk);
    if (!result.success) {
      logger.error("LLM analysis failed for chunk", {
        error: result.error,
        fileCount: chunk.files.length,
      });
      return err("REVIEW_LLM_FAILED");
    }

    allFindings.push(...result.data.findings);
    if (result.data.summary) {
      summaries.push(result.data.summary);
    }
    totalInputTokens += result.data.tokenUsage.inputTokens;
    totalOutputTokens += result.data.tokenUsage.outputTokens;
  }

  const summary =
    summaries.length > 0
      ? summaries.join("\n\n")
      : "No significant issues found.";

  return ok({
    findings: allFindings,
    summary,
    totalInputTokens,
    totalOutputTokens,
  });
}

async function postAndSaveReviewResults(
  githubService: GitHubService,
  owner: string,
  repo: string,
  request: ReviewRequest,
  reviewId: ReviewId,
  findings: readonly ReviewFinding[],
  parsedDiff: ParsedDiff,
  llmSummary: string,
): Promise<void> {
  const mappingResult = mapFindingsToGitHubComments(findings, parsedDiff);
  const { mappedComments, unmappedFindings } = mappingResult.success
    ? mappingResult.data
    : { mappedComments: [] as const, unmappedFindings: [] as const };

  const reviewSummary = buildReviewSummary(
    llmSummary,
    mappedComments.length,
    unmappedFindings,
  );

  const reviewEvent = findings.some((f) => f.severity === "CRITICAL")
    ? "REQUEST_CHANGES"
    : "COMMENT";

  const postResult = await githubService.postPullRequestReview(
    owner,
    repo,
    request.pullRequestNumber,
    {
      commitSha: request.commitSha,
      body: reviewSummary,
      event: reviewEvent as "COMMENT" | "REQUEST_CHANGES",
      comments: mappedComments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.formattedBody,
      })),
    },
  );

  if (!postResult.success) {
    logger.error("Failed to post review to GitHub", {
      error: postResult.error,
    });
  } else {
    logger.info("Review posted to GitHub", {
      githubReviewId: postResult.data.githubReviewId,
      postedComments: postResult.data.postedCommentCount,
    });
  }

  const allFindingsForDb = [
    ...mappedComments.map((c) => c.finding),
    ...unmappedFindings.map((u) => u.finding),
  ];
  const saveResult = await saveReviewComments(
    allFindingsForDb.map((finding) => ({
      reviewId,
      filePath: finding.filePath,
      lineNumber: finding.lineNumber,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      suggestion: finding.suggestion ?? null,
      confidence: finding.confidence,
      githubCommentId: null,
    })),
  );

  if (!saveResult.success) {
    logger.error("Failed to save review comments to DB", {
      error: saveResult.error,
    });
  }
}

function buildEarlyResult(
  reviewId: ReviewId,
  startTime: number,
  summary: string,
): ReviewEngineResult {
  return {
    reviewId,
    issuesFound: 0,
    processingTimeMs: Date.now() - startTime,
    summary,
  };
}

export async function executeReview(
  request: ReviewRequest,
  githubService: GitHubService,
  llmService: LLMService,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const startTime = Date.now();

  const nameResult = parseRepositoryFullName(request.repositoryFullName);
  if (!nameResult.success) return nameResult;
  const { owner, repo } = nameResult.data;

  logger.info("Starting review", {
    repository: request.repositoryFullName,
    pullRequest: request.pullRequestNumber,
    commitSha: request.commitSha,
  });

  const lookupResult = await lookupRepositoryAndCheckIdempotency(
    request.repositoryFullName,
    request.commitSha,
  );
  if (!lookupResult.success) return lookupResult;
  const { repositoryId } = lookupResult.data;

  const createResult = await createReviewRecord({
    repositoryId,
    pullRequestNumber: request.pullRequestNumber,
    commitSha: request.commitSha,
  });
  if (!createResult.success) {
    logger.error("Failed to create review record", {
      error: createResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  const reviewId = createResult.data.id;

  const statusResult = await updateReviewStatus(reviewId, "PROCESSING");
  if (!statusResult.success) {
    logger.warn("Failed to update review to PROCESSING", {
      reviewId,
      error: statusResult.error,
    });
  }

  const diffResult = await fetchAndParseDiff(
    githubService,
    owner,
    repo,
    request.pullRequestNumber,
    reviewId,
  );
  if (!diffResult.success) return diffResult;
  const parsedDiff = diffResult.data;

  if (parsedDiff.files.length === 0) {
    const summary = "No reviewable files in this PR.";
    await completeReview({
      reviewId,
      summary,
      issuesFound: 0,
      processingTimeMs: Date.now() - startTime,
    });
    return ok(buildEarlyResult(reviewId, startTime, summary));
  }

  const chunks = await enrichDiffWithContext(
    githubService,
    parsedDiff,
    owner,
    repo,
    request.commitSha,
  );
  if (!chunks.success) {
    await failReview(reviewId, "Context enrichment failed");
    return err("REVIEW_LLM_FAILED");
  }
  if (chunks.data.length === 0) {
    const summary = "No reviewable content after filtering.";
    await completeReview({
      reviewId,
      summary,
      issuesFound: 0,
      processingTimeMs: Date.now() - startTime,
    });
    return ok(buildEarlyResult(reviewId, startTime, summary));
  }

  const llmResult = await analyzeAllChunks(llmService, chunks.data);
  if (!llmResult.success) {
    await failReview(reviewId, "LLM analysis failed");
    return err("REVIEW_LLM_FAILED");
  }

  logger.info("LLM analysis complete", {
    findingCount: llmResult.data.findings.length,
    inputTokens: llmResult.data.totalInputTokens,
    outputTokens: llmResult.data.totalOutputTokens,
  });

  await postAndSaveReviewResults(
    githubService,
    owner,
    repo,
    request,
    reviewId,
    llmResult.data.findings,
    parsedDiff,
    llmResult.data.summary,
  );

  const processingTimeMs = Date.now() - startTime;
  await completeReview({
    reviewId,
    summary: llmResult.data.summary,
    issuesFound: llmResult.data.findings.length,
    processingTimeMs,
  });

  logger.info("Review complete", {
    reviewId,
    issuesFound: llmResult.data.findings.length,
    processingTimeMs,
  });

  return ok({
    reviewId,
    issuesFound: llmResult.data.findings.length,
    processingTimeMs,
    summary: llmResult.data.summary,
  });
}

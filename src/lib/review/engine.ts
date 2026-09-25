import type { ReviewStatus } from "@/generated/prisma/enums";
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
import { buildReviewMarker } from "@/lib/github/review-marker";
import { logger } from "@/lib/logger";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { initializeAstParser, parseFileAst } from "@/lib/review/ast-parser";
import {
  buildReviewSummary,
  mapFindingsToGitHubComments,
} from "@/lib/review/comment-mapper";
import { buildReviewContext } from "@/lib/review/context-builder";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import { STALE_PROCESSING_REVIEW_MS } from "@/lib/review/stale-reviews";
import type { RepositoryId, ReviewId } from "@/types/branded";
import type { ReviewEngineError } from "@/types/errors";
import type { GitHubService, PullRequestReviewPayload } from "@/types/github";
import type { LLMService } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  AstFileContext,
  ParsedDiff,
  ReviewChunk,
  ReviewClaimRef,
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

function parseRepositoryFullNameAsResult(
  fullName: string,
): Result<{ owner: string; repo: string }, "REVIEW_DB_ERROR"> {
  const parsed = parseRepositoryFullName(fullName);
  if (parsed === null) {
    logger.error("Invalid repository full name", { fullName });
    return err("REVIEW_DB_ERROR");
  }
  return ok(parsed);
}

async function lookupRepository(
  repositoryFullName: string,
): Promise<Result<RepositoryId, ReviewEngineError>> {
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
  return ok(repoResult.data.id);
}

async function createNewReviewRecord(
  repositoryId: RepositoryId,
  request: ReviewRequest,
): Promise<Result<ReviewClaimRef, ReviewEngineError>> {
  const createResult = await createReviewRecord({
    repositoryId,
    pullRequestNumber: request.pullRequestNumber,
    commitSha: request.commitSha,
    claimedByJobId: request.jobId,
  });
  if (!createResult.success) {
    logger.error("Failed to create review record", {
      error: createResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  if (!createResult.data) {
    logger.info("Another job created the review first, skipping", {
      commitSha: request.commitSha,
      jobId: request.jobId,
    });
    return err("REVIEW_ALREADY_EXISTS");
  }
  return ok(createResult.data);
}

async function claimExistingReviewForRetry(
  existing: { id: ReviewId; status: ReviewStatus },
  request: ReviewRequest,
): Promise<Result<ReviewClaimRef, ReviewEngineError>> {
  const { commitSha, jobId, pullRequestNumber } = request;
  const reviewId = existing.id;
  const claimResult = await claimExistingReview(reviewId, {
    jobId,
    pullRequestNumber,
    staleBefore: new Date(Date.now() - STALE_PROCESSING_REVIEW_MS),
  });
  if (!claimResult.success) {
    logger.error("Failed to claim existing review", {
      reviewId,
      error: claimResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  if (!claimResult.data) {
    logger.info("Review is owned by another job, skipping", {
      reviewId,
      status: existing.status,
      commitSha,
    });
    return err("REVIEW_ALREADY_EXISTS");
  }
  logger.info("Re-running existing review", {
    reviewId,
    previousStatus: existing.status,
    commitSha,
    jobId,
  });
  return ok(claimResult.data);
}

/**
 * Returns the review to work on: a new PROCESSING review, or an existing
 * review for the same commit claimed for this job (FAILED, abandoned by an
 * earlier attempt of this job, or stale). A COMPLETED review, or one another
 * job still owns, means there is nothing to do.
 */
async function claimReviewRecord(
  repositoryId: RepositoryId,
  request: ReviewRequest,
): Promise<Result<ReviewClaimRef, ReviewEngineError>> {
  const existingResult = await findExistingReviewByCommitSha(
    repositoryId,
    request.commitSha,
  );
  if (!existingResult.success) {
    logger.error("Idempotency check failed", {
      error: existingResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }

  const existing = existingResult.data;
  if (!existing) return createNewReviewRecord(repositoryId, request);
  if (existing.status !== "COMPLETED") {
    return claimExistingReviewForRetry(existing, request);
  }

  logger.info("Review already exists for commit, skipping", {
    reviewId: existing.id,
    status: existing.status,
    commitSha: request.commitSha,
  });
  return err("REVIEW_ALREADY_EXISTS");
}

async function markReviewFailed(
  claim: ReviewClaimRef,
  reason: string,
): Promise<void> {
  const result = await failReview(claim, reason);
  if (!result.success) {
    logger.error("Failed to mark review as failed", {
      reviewId: claim.reviewId,
      reason,
      error: result.error,
    });
    return;
  }
  if (!result.data) {
    logger.warn("Review claim lost; leaving it to the current owner", {
      reviewId: claim.reviewId,
      reason,
    });
  }
}

function logClaimLost(claim: ReviewClaimRef, step: string): void {
  logger.warn("Review claim lost to another attempt, stopping", {
    reviewId: claim.reviewId,
    step,
  });
}

async function fetchAndParseDiff(
  githubService: GitHubService,
  owner: string,
  repo: string,
  pullNumber: number,
  claim: ReviewClaimRef,
): Promise<Result<ParsedDiff, ReviewEngineError>> {
  const diffResult = await githubService.fetchPullRequestDiff(
    owner,
    repo,
    pullNumber,
  );
  if (!diffResult.success) {
    logger.error("Failed to fetch diff", { error: diffResult.error });
    await markReviewFailed(claim, "Failed to fetch PR diff");
    return err("REVIEW_DIFF_FETCH_FAILED");
  }

  const parsedDiffResult = parseUnifiedDiff(diffResult.data);
  if (!parsedDiffResult.success) {
    logger.error("Failed to parse diff", {
      error: parsedDiffResult.error,
    });
    await markReviewFailed(claim, "Failed to parse PR diff");
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

function describeFindingCount(findingCount: number): string {
  if (findingCount === 0) return "No issues found in this review.";
  return `Found ${findingCount} issue${findingCount === 1 ? "" : "s"} in this review.`;
}

async function analyzeAllChunks(
  llmService: LLMService,
  chunks: readonly ReviewChunk[],
): Promise<Result<LlmAnalysisResult, "REVIEW_LLM_FAILED">> {
  const allFindings: ReviewFinding[] = [];
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
    totalInputTokens += result.data.tokenUsage.inputTokens;
    totalOutputTokens += result.data.tokenUsage.outputTokens;
  }

  return ok({
    findings: allFindings,
    summary: describeFindingCount(allFindings.length),
    totalInputTokens,
    totalOutputTokens,
  });
}

interface PreparedGitHubReview {
  readonly findingsToSave: readonly ReviewFinding[];
  readonly payload: PullRequestReviewPayload;
}

function prepareGitHubReview(
  commitSha: string,
  findings: readonly ReviewFinding[],
  parsedDiff: ParsedDiff,
  llmSummary: string,
): PreparedGitHubReview {
  const { mappedComments, unmappedFindings } = mapFindingsToGitHubComments(
    findings,
    parsedDiff,
  );

  const reviewEvent = findings.some((f) => f.severity === "CRITICAL")
    ? "REQUEST_CHANGES"
    : "COMMENT";

  return {
    findingsToSave: [
      ...mappedComments.map((c) => c.finding),
      ...unmappedFindings.map((u) => u.finding),
    ],
    payload: {
      commitSha,
      body: buildReviewSummary(
        llmSummary,
        mappedComments.length,
        unmappedFindings,
      ),
      event: reviewEvent,
      comments: mappedComments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.formattedBody,
      })),
    },
  };
}

async function ensureClaimIsCurrent(
  claim: ReviewClaimRef,
): Promise<Result<void, ReviewEngineError>> {
  const checkResult = await isReviewClaimCurrent(claim);
  if (!checkResult.success) {
    logger.error("Failed to check review claim before posting", {
      reviewId: claim.reviewId,
      error: checkResult.error,
    });
    await markReviewFailed(claim, "Failed to check review claim");
    return err("REVIEW_DB_ERROR");
  }
  if (!checkResult.data) {
    logClaimLost(claim, "post");
    return err("REVIEW_CLAIM_LOST");
  }
  return ok(undefined);
}

/**
 * Looks for this review on the PR from an earlier attempt: one whose post
 * reached GitHub even though the attempt then failed or was reclaimed.
 */
async function wasPostedByEarlierAttempt(
  context: ReviewStepsContext,
  marker: string,
): Promise<Result<boolean, ReviewEngineError>> {
  const { githubService, owner, repo, request, claim } = context;
  const lookupResult = await githubService.findPostedReview(
    owner,
    repo,
    request.pullRequestNumber,
    marker,
  );
  if (!lookupResult.success) {
    logger.error("Failed to check for an existing review on GitHub", {
      reviewId: claim.reviewId,
      error: lookupResult.error,
    });
    await markReviewFailed(
      claim,
      "Failed to check for an existing review on GitHub",
    );
    return err("REVIEW_POST_FAILED");
  }
  if (lookupResult.data) {
    logger.info("Review already posted by an earlier attempt, not reposting", {
      reviewId: claim.reviewId,
      githubReviewId: lookupResult.data.githubReviewId,
    });
  }
  return ok(lookupResult.data !== null);
}

async function postReviewToGitHub(
  context: ReviewStepsContext,
  payload: PullRequestReviewPayload,
): Promise<Result<void, ReviewEngineError>> {
  const { githubService, owner, repo, request, claim } = context;
  const claimCheck = await ensureClaimIsCurrent(claim);
  if (!claimCheck.success) return claimCheck;

  const marker = buildReviewMarker(claim.reviewId);
  const earlierPost = await wasPostedByEarlierAttempt(context, marker);
  if (!earlierPost.success) return earlierPost;
  if (earlierPost.data) return ok(undefined);

  const postResult = await githubService.postPullRequestReview(
    owner,
    repo,
    request.pullRequestNumber,
    { ...payload, body: `${payload.body}\n\n${marker}` },
  );

  if (!postResult.success) {
    logger.error("Failed to post review to GitHub", {
      reviewId: claim.reviewId,
      error: postResult.error,
    });
    await markReviewFailed(claim, "Failed to post review to GitHub");
    return err("REVIEW_POST_FAILED");
  }

  logger.info("Review posted to GitHub", {
    githubReviewId: postResult.data.githubReviewId,
    postedComments: postResult.data.postedCommentCount,
  });
  return ok(undefined);
}

async function saveFindingsOrFailReview(
  claim: ReviewClaimRef,
  summary: string,
  findings: readonly ReviewFinding[],
): Promise<Result<void, ReviewEngineError>> {
  const saveResult = await saveReviewFindings({
    ...claim,
    summary,
    issuesFound: findings.length,
    comments: findings.map((finding) => ({
      filePath: finding.filePath,
      lineNumber: finding.lineNumber,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      suggestion: finding.suggestion ?? null,
      confidence: finding.confidence,
      githubCommentId: null,
    })),
  });
  if (!saveResult.success) {
    logger.error("Failed to save review results", {
      reviewId: claim.reviewId,
      error: saveResult.error,
    });
    await markReviewFailed(claim, "Failed to save review results");
    return err("REVIEW_DB_ERROR");
  }
  if (!saveResult.data) {
    logClaimLost(claim, "save");
    return err("REVIEW_CLAIM_LOST");
  }
  return ok(undefined);
}

async function completeReviewOrFail(
  claim: ReviewClaimRef,
  startTime: number,
): Promise<Result<number, ReviewEngineError>> {
  const processingTimeMs = Date.now() - startTime;
  const completeResult = await markReviewCompleted(claim, processingTimeMs);
  if (!completeResult.success) {
    logger.error("Failed to mark review completed", {
      reviewId: claim.reviewId,
      error: completeResult.error,
    });
    await markReviewFailed(claim, "Failed to mark review completed");
    return err("REVIEW_DB_ERROR");
  }
  if (!completeResult.data) {
    logClaimLost(claim, "complete");
    return err("REVIEW_CLAIM_LOST");
  }
  return ok(processingTimeMs);
}

async function completeReviewEarly(
  claim: ReviewClaimRef,
  startTime: number,
  summary: string,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const saveResult = await saveFindingsOrFailReview(claim, summary, []);
  if (!saveResult.success) return saveResult;
  const completeResult = await completeReviewOrFail(claim, startTime);
  if (!completeResult.success) return completeResult;
  return ok({
    reviewId: claim.reviewId,
    issuesFound: 0,
    processingTimeMs: completeResult.data,
    summary,
  });
}

interface ReviewStepsContext {
  readonly claim: ReviewClaimRef;
  readonly request: ReviewRequest;
  readonly owner: string;
  readonly repo: string;
  readonly githubService: GitHubService;
  readonly llmService: LLMService;
  readonly startTime: number;
}

async function runReviewSteps(
  context: ReviewStepsContext,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const { claim, request, owner, repo, githubService, startTime } = context;

  const diffResult = await fetchAndParseDiff(
    githubService,
    owner,
    repo,
    request.pullRequestNumber,
    claim,
  );
  if (!diffResult.success) return diffResult;

  const filterPaths = request.filePathFilter;
  const parsedDiff: ParsedDiff = filterPaths
    ? {
        files: diffResult.data.files.filter((f) =>
          filterPaths.includes(f.filePath),
        ),
      }
    : diffResult.data;

  if (parsedDiff.files.length === 0) {
    return completeReviewEarly(
      claim,
      startTime,
      "No reviewable files in this PR.",
    );
  }

  const chunks = await enrichDiffWithContext(
    githubService,
    parsedDiff,
    owner,
    repo,
    request.commitSha,
  );
  if (!chunks.success) {
    await markReviewFailed(claim, "Context enrichment failed");
    return err("REVIEW_LLM_FAILED");
  }
  if (chunks.data.length === 0) {
    return completeReviewEarly(
      claim,
      startTime,
      "No reviewable content after filtering.",
    );
  }

  return analyzeSaveAndPostReview(context, chunks.data, parsedDiff);
}

async function analyzeSaveAndPostReview(
  context: ReviewStepsContext,
  chunks: readonly ReviewChunk[],
  parsedDiff: ParsedDiff,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const { claim, request, llmService, startTime } = context;
  const { reviewId } = claim;

  const llmResult = await analyzeAllChunks(llmService, chunks);
  if (!llmResult.success) {
    await markReviewFailed(claim, "LLM analysis failed");
    return err("REVIEW_LLM_FAILED");
  }
  const { findings, summary } = llmResult.data;

  logger.info("LLM analysis complete", {
    findingCount: findings.length,
    inputTokens: llmResult.data.totalInputTokens,
    outputTokens: llmResult.data.totalOutputTokens,
  });

  const review = prepareGitHubReview(
    request.commitSha,
    findings,
    parsedDiff,
    summary,
  );

  const saveResult = await saveFindingsOrFailReview(
    claim,
    summary,
    review.findingsToSave,
  );
  if (!saveResult.success) return saveResult;

  const postResult = await postReviewToGitHub(context, review.payload);
  if (!postResult.success) return postResult;

  const completeResult = await completeReviewOrFail(claim, startTime);
  if (!completeResult.success) return completeResult;

  logger.info("Review complete", {
    reviewId,
    issuesFound: findings.length,
    processingTimeMs: completeResult.data,
  });

  return ok({
    reviewId,
    issuesFound: findings.length,
    processingTimeMs: completeResult.data,
    summary,
  });
}

async function runReviewStepsWithFailureGuard(
  context: ReviewStepsContext,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  try {
    return await runReviewSteps(context);
  } catch (error) {
    logger.error("Unexpected error during review", {
      reviewId: context.claim.reviewId,
      repository: context.request.repositoryFullName,
      pullRequest: context.request.pullRequestNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    await markReviewFailed(context.claim, "Unexpected error during review");
    return err("REVIEW_UNEXPECTED_ERROR");
  }
}

export async function executeReview(
  request: ReviewRequest,
  githubService: GitHubService,
  llmService: LLMService,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const startTime = Date.now();

  const nameResult = parseRepositoryFullNameAsResult(
    request.repositoryFullName,
  );
  if (!nameResult.success) return nameResult;
  const { owner, repo } = nameResult.data;

  logger.info("Starting review", {
    repository: request.repositoryFullName,
    pullRequest: request.pullRequestNumber,
    commitSha: request.commitSha,
  });

  const repositoryResult = await lookupRepository(request.repositoryFullName);
  if (!repositoryResult.success) return repositoryResult;

  const claimResult = await claimReviewRecord(repositoryResult.data, request);
  if (!claimResult.success) return claimResult;

  return runReviewStepsWithFailureGuard({
    claim: claimResult.data,
    request,
    owner,
    repo,
    githubService,
    llmService,
    startTime,
  });
}

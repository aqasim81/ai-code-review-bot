import type { ReviewStatus } from "@/generated/prisma/enums";
import {
  claimExistingReview,
  createReviewRecord,
  failReview,
  findExistingReviewByCommitSha,
  findOrCreateRepositoryForReview,
  isReviewClaimCurrent,
  markReviewCompleted,
  markReviewSuperseded,
  renewReviewClaim,
  saveReviewFindings,
} from "@/lib/db/queries";
import { describeError } from "@/lib/errors";
import { buildReviewMarker } from "@/lib/github/review-marker";
import { startHeartbeat } from "@/lib/heartbeat";
import { logger } from "@/lib/logger";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { initializeAstParser, parseFileAst } from "@/lib/review/ast-parser";
import {
  buildReviewSummary,
  mapFindingsToGitHubComments,
} from "@/lib/review/comment-mapper";
import {
  buildReviewContext,
  filterReviewableFiles,
} from "@/lib/review/context-builder";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import {
  createExcludedPathMatcher,
  filterFindingsBySettings,
} from "@/lib/review/settings-filter";
import {
  REVIEW_CLAIM_RENEWAL_INTERVAL_MS,
  STALE_PROCESSING_REVIEW_MS,
} from "@/lib/review/stale-reviews";
import type { RepositoryId, ReviewId } from "@/types/branded";
import type { GitHubError, ReviewEngineError } from "@/types/errors";
import type { GitHubService, PullRequestReviewPayload } from "@/types/github";
import type { LLMError, LLMService, ReviewPromptOptions } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  AstFileContext,
  ParsedDiff,
  ParsedDiffFile,
  ReviewChunk,
  ReviewClaimRef,
  ReviewContext,
  ReviewEngineResult,
  ReviewFinding,
  ReviewRequest,
} from "@/types/review";
import type { RepositorySettings } from "@/types/settings";

interface ReviewedRepository {
  readonly repositoryId: RepositoryId;
  readonly settings: Required<RepositorySettings>;
}

async function lookupRepository(
  request: ReviewRequest,
): Promise<Result<ReviewedRepository, ReviewEngineError>> {
  const repoResult = await findOrCreateRepositoryForReview({
    githubInstallationId: request.installationId,
    githubRepoId: request.githubRepoId,
    fullName: request.repositoryFullName,
  });
  if (!repoResult.success) {
    logger.error("Failed to look up repository", {
      error: repoResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  if (!repoResult.data) {
    // Also covers a missed installation.created webhook, so keep it visible.
    logger.warn("Repository not reviewable, skipping", {
      repository: request.repositoryFullName,
      githubInstallationId: request.installationId,
      reason: "installation unknown or inactive, or repository removed",
    });
    return err("REVIEW_REPOSITORY_UNAVAILABLE");
  }
  if (!repoResult.data.isEnabled) {
    logger.info("Reviews are disabled for this repository, skipping", {
      repository: request.repositoryFullName,
    });
    return err("REVIEW_REPOSITORY_UNAVAILABLE");
  }
  return ok({
    repositoryId: repoResult.data.id,
    settings: repoResult.data.settings,
  });
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

/**
 * Why a review step stopped. Every failure but a lost claim marks the review
 * FAILED with `reason`; a lost claim leaves the review to its current owner.
 */
type StepFailure =
  | { readonly code: "REVIEW_CLAIM_LOST" }
  | {
      readonly code: Exclude<ReviewEngineError, "REVIEW_CLAIM_LOST">;
      readonly reason: string;
    };

function stepFailed(
  code: Exclude<ReviewEngineError, "REVIEW_CLAIM_LOST">,
  reason: string,
): Result<never, StepFailure> {
  return err({ code, reason });
}

function claimLost(
  claim: ReviewClaimRef,
  step: string,
): Result<never, StepFailure> {
  logger.warn("Review claim lost to another attempt, stopping", {
    reviewId: claim.reviewId,
    step,
  });
  return err({ code: "REVIEW_CLAIM_LOST" });
}

const GITHUB_STEP_ERRORS = {
  diff: {
    rejected: "REVIEW_DIFF_UNAVAILABLE",
    retryable: "REVIEW_DIFF_FETCH_FAILED",
  },
  post: { rejected: "REVIEW_POST_REJECTED", retryable: "REVIEW_POST_FAILED" },
} as const satisfies Record<
  string,
  { rejected: ReviewEngineError; retryable: ReviewEngineError }
>;

/**
 * Keeps why a GitHub call failed, so the queue can tell a failure no retry can
 * fix from a rate limit and from one worth retrying soon.
 */
function reviewErrorForGitHubFailure(
  error: GitHubError,
  step: keyof typeof GITHUB_STEP_ERRORS,
): Exclude<ReviewEngineError, "REVIEW_CLAIM_LOST"> {
  if (error === "GITHUB_RATE_LIMITED") return "REVIEW_GITHUB_RATE_LIMITED";
  if (error === "GITHUB_INSTALLATION_UNAVAILABLE") {
    return "REVIEW_REPOSITORY_UNAVAILABLE";
  }
  if (
    error === "GITHUB_NOT_FOUND" ||
    error === "GITHUB_FORBIDDEN" ||
    error === "GITHUB_REQUEST_REJECTED"
  ) {
    return GITHUB_STEP_ERRORS[step].rejected;
  }
  return GITHUB_STEP_ERRORS[step].retryable;
}

// The model refused the request itself; no retry can fix it.
const REJECTED_LLM_ERRORS: ReadonlySet<LLMError> = new Set([
  "LLM_API_KEY_MISSING",
  "LLM_AUTH_FAILED",
  "LLM_BAD_REQUEST",
  "LLM_CONTEXT_TOO_LONG",
]);

// Rejections that fail every chunk alike, so there is no point going on.
const CREDENTIAL_LLM_ERRORS: ReadonlySet<LLMError> = new Set([
  "LLM_API_KEY_MISSING",
  "LLM_AUTH_FAILED",
]);

async function fetchAndParseDiff(
  githubService: GitHubService,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<Result<ParsedDiff, StepFailure>> {
  const diffResult = await githubService.fetchPullRequestDiff(
    owner,
    repo,
    pullNumber,
  );
  if (!diffResult.success) {
    logger.error("Failed to fetch diff", { error: diffResult.error });
    return stepFailed(
      reviewErrorForGitHubFailure(diffResult.error, "diff"),
      "Failed to fetch PR diff",
    );
  }

  const parsedDiffResult = parseUnifiedDiff(diffResult.data);
  if (!parsedDiffResult.success) {
    logger.error("Failed to parse diff", {
      error: parsedDiffResult.error,
    });
    return stepFailed("REVIEW_DIFF_PARSE_FAILED", "Failed to parse PR diff");
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
        error: describeError(result.reason),
      });
    }
  }

  return contents;
}

async function parseAstContextsForFiles(
  fileContents: ReadonlyMap<string, string>,
  files: readonly ParsedDiffFile[],
): Promise<ReadonlyMap<string, AstFileContext>> {
  const astContexts = new Map<string, AstFileContext>();

  const initResult = await initializeAstParser();
  if (!initResult.success) {
    logger.warn("AST parser initialization failed, skipping AST enrichment", {
      error: initResult.error,
    });
    return astContexts;
  }

  for (const { filePath: path, language } of files) {
    if (!language) continue;

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
): Promise<ReviewContext> {
  // Only files the AST parser can read need their full content.
  const parseableFiles = filterReviewableFiles(parsedDiff.files).filter(
    (f) => f.language !== null,
  );

  const fileContents = await fetchFileContentsForDiff(
    githubService,
    owner,
    repo,
    commitSha,
    parseableFiles.map((f) => f.filePath),
  );
  const astContexts = await parseAstContextsForFiles(
    fileContents,
    parseableFiles,
  );

  const reviewContext = buildReviewContext(parsedDiff, astContexts);
  if (reviewContext.oversizedFilePaths.length > 0) {
    logger.warn("Skipping files too large to review", {
      filePaths: reviewContext.oversizedFilePaths,
    });
  }
  return reviewContext;
}

interface LlmAnalysisResult {
  readonly findings: ReviewFinding[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** Files of chunks whose analysis failed while the rest succeeded. */
  readonly unanalyzedFilePaths: readonly string[];
  /** Files of chunks whose reply was cut off at the output limit. */
  readonly truncatedFilePaths: readonly string[];
}

const MAX_LISTED_FILES = 10;

/** A summary note naming files, or null when there are none. */
function describeFilesNote(
  reason: string,
  filePaths: readonly string[],
): string | null {
  if (filePaths.length === 0) return null;
  const listed = filePaths
    .slice(0, MAX_LISTED_FILES)
    .map((filePath) => `\`${filePath}\``)
    .join(", ");
  const more = filePaths.length - MAX_LISTED_FILES;
  const suffix = more > 0 ? ` and ${more} more` : "";
  return `${reason}: ${listed}${suffix}.`;
}

function describeFindingCount(findingCount: number): string {
  if (findingCount === 0) return "No issues found in this review.";
  return `Found ${findingCount} issue${findingCount === 1 ? "" : "s"} in this review.`;
}

function llmAnalysisFailed(
  errors: readonly LLMError[],
): Result<never, StepFailure> {
  return stepFailed(
    errors.every((error) => REJECTED_LLM_ERRORS.has(error))
      ? "REVIEW_LLM_REJECTED"
      : "REVIEW_LLM_FAILED",
    "LLM analysis failed",
  );
}

/**
 * Whether the review should stop at a failed chunk rather than go on without
 * it: the credentials are bad (every chunk fails alike), or a retry of the
 * whole job may still succeed.
 */
function shouldStopAtFailedChunk(
  error: LLMError,
  isFinalAttempt: boolean,
): boolean {
  if (CREDENTIAL_LLM_ERRORS.has(error)) return true;
  return !REJECTED_LLM_ERRORS.has(error) && !isFinalAttempt;
}

async function analyzeAllChunks(
  llmService: LLMService,
  chunks: readonly ReviewChunk[],
  promptOptions: ReviewPromptOptions,
  isFinalAttempt: boolean,
): Promise<Result<LlmAnalysisResult, StepFailure>> {
  const allFindings: ReviewFinding[] = [];
  const failedChunkErrors: LLMError[] = [];
  const unanalyzedFilePaths: string[] = [];
  const truncatedFilePaths: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const chunk of chunks) {
    const result = await llmService.analyzeReviewChunk(chunk, promptOptions);
    if (!result.success) {
      const filePaths = chunk.files.map((file) => file.filePath);
      logger.error("LLM analysis failed for chunk", {
        error: result.error,
        filePaths,
      });
      if (shouldStopAtFailedChunk(result.error, isFinalAttempt)) {
        return llmAnalysisFailed([result.error]);
      }
      failedChunkErrors.push(result.error);
      unanalyzedFilePaths.push(...filePaths);
      continue;
    }

    allFindings.push(...result.data.findings);
    if (result.data.truncated) {
      truncatedFilePaths.push(...chunk.files.map((file) => file.filePath));
    }
    totalInputTokens += result.data.tokenUsage.inputTokens;
    totalOutputTokens += result.data.tokenUsage.outputTokens;
  }

  if (failedChunkErrors.length === chunks.length) {
    return llmAnalysisFailed(failedChunkErrors);
  }
  return ok({
    findings: allFindings,
    totalInputTokens,
    totalOutputTokens,
    unanalyzedFilePaths,
    truncatedFilePaths,
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
  summaryText: string,
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
        summaryText,
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

/**
 * Turns the result of a write guarded by the claim into a step result: a
 * database error fails the review, a lost claim stops it.
 */
function requireClaimedWrite(
  result: Result<boolean, string>,
  claim: ReviewClaimRef,
  step: string,
  failureMessage: string,
): Result<void, StepFailure> {
  if (!result.success) {
    logger.error(failureMessage, {
      reviewId: claim.reviewId,
      error: result.error,
    });
    return stepFailed("REVIEW_DB_ERROR", failureMessage);
  }
  return result.data ? ok(undefined) : claimLost(claim, step);
}

/**
 * Looks for this review on the PR from an earlier attempt: one whose post
 * reached GitHub even though the attempt then failed or was reclaimed.
 */
async function wasPostedByEarlierAttempt(
  context: ReviewStepsContext,
  marker: string,
): Promise<Result<boolean, StepFailure>> {
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
    return stepFailed(
      reviewErrorForGitHubFailure(lookupResult.error, "post"),
      "Failed to check for an existing review on GitHub",
    );
  }
  if (lookupResult.data) {
    logger.info("Review already posted by an earlier attempt, not reposting", {
      reviewId: claim.reviewId,
      githubReviewId: lookupResult.data.githubReviewId,
    });
  }
  return ok(lookupResult.data !== null);
}

/**
 * Whether the review's commit is still the pull request's head. A delayed job
 * can run after newer pushes, and its review must not be posted then.
 */
async function isCommitStillHead(
  context: ReviewStepsContext,
): Promise<Result<boolean, StepFailure>> {
  const { githubService, owner, repo, request, claim } = context;
  const headResult = await githubService.fetchPullRequestHeadSha(
    owner,
    repo,
    request.pullRequestNumber,
  );
  if (!headResult.success) {
    logger.error("Failed to fetch the pull request head", {
      reviewId: claim.reviewId,
      error: headResult.error,
    });
    return stepFailed(
      reviewErrorForGitHubFailure(headResult.error, "post"),
      "Failed to fetch the pull request head",
    );
  }
  if (headResult.data !== request.commitSha) {
    logger.info("Newer commits were pushed, not posting the review", {
      reviewId: claim.reviewId,
      commitSha: request.commitSha,
      headSha: headResult.data,
    });
    return ok(false);
  }
  return ok(true);
}

type PostOutcome = "posted" | "superseded";

async function postReviewToGitHub(
  context: ReviewStepsContext,
  payload: PullRequestReviewPayload,
): Promise<Result<PostOutcome, StepFailure>> {
  const { githubService, owner, repo, request, claim } = context;
  const claimCheck = requireClaimedWrite(
    await isReviewClaimCurrent(claim),
    claim,
    "post",
    "Failed to check review claim",
  );
  if (!claimCheck.success) return claimCheck;

  const marker = buildReviewMarker(claim.reviewId);
  const earlierPost = await wasPostedByEarlierAttempt(context, marker);
  if (!earlierPost.success) return earlierPost;
  if (earlierPost.data) return ok("posted");

  const headCheck = await isCommitStillHead(context);
  if (!headCheck.success) return headCheck;
  if (!headCheck.data) return ok("superseded");

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
    return stepFailed(
      reviewErrorForGitHubFailure(postResult.error, "post"),
      "Failed to post review to GitHub",
    );
  }

  logger.info("Review posted to GitHub", {
    githubReviewId: postResult.data.githubReviewId,
    postedComments: postResult.data.postedCommentCount,
  });
  return ok("posted");
}

const SUPERSEDED_SUMMARY =
  "Not posted: newer commits were pushed to the pull request.";

async function completeSupersededReview(
  claim: ReviewClaimRef,
  startTime: number,
): Promise<Result<ReviewEngineResult, StepFailure>> {
  const processingTimeMs = Date.now() - startTime;
  const writeResult = requireClaimedWrite(
    await markReviewSuperseded(claim, SUPERSEDED_SUMMARY, processingTimeMs),
    claim,
    "supersede",
    "Failed to mark review superseded",
  );
  if (!writeResult.success) return writeResult;
  return ok({
    reviewId: claim.reviewId,
    issuesFound: 0,
    processingTimeMs,
    summary: SUPERSEDED_SUMMARY,
  });
}

async function saveFindingsOrFailReview(
  claim: ReviewClaimRef,
  summary: string,
  findings: readonly ReviewFinding[],
): Promise<Result<void, StepFailure>> {
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
  return requireClaimedWrite(
    saveResult,
    claim,
    "save",
    "Failed to save review results",
  );
}

async function completeReviewOrFail(
  claim: ReviewClaimRef,
  startTime: number,
): Promise<Result<number, StepFailure>> {
  const processingTimeMs = Date.now() - startTime;
  const completeResult = requireClaimedWrite(
    await markReviewCompleted(claim, processingTimeMs),
    claim,
    "complete",
    "Failed to mark review completed",
  );
  if (!completeResult.success) return completeResult;
  return ok(processingTimeMs);
}

async function completeReviewEarly(
  claim: ReviewClaimRef,
  startTime: number,
  summary: string,
): Promise<Result<ReviewEngineResult, StepFailure>> {
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
  readonly settings: Required<RepositorySettings>;
  readonly startTime: number;
}

async function runReviewSteps(
  context: ReviewStepsContext,
): Promise<Result<ReviewEngineResult, StepFailure>> {
  const { claim, request, owner, repo, githubService, startTime } = context;

  const diffResult = await fetchAndParseDiff(
    githubService,
    owner,
    repo,
    request.pullRequestNumber,
  );
  if (!diffResult.success) return diffResult;

  const filterPaths = request.filePathFilter;
  const isExcluded = createExcludedPathMatcher(
    context.settings.excludePatterns,
  );
  const parsedDiff: ParsedDiff = {
    files: diffResult.data.files.filter(
      (f) =>
        (!filterPaths || filterPaths.includes(f.filePath)) &&
        !isExcluded(f.filePath),
    ),
  };

  if (parsedDiff.files.length === 0) {
    return completeReviewEarly(
      claim,
      startTime,
      "No reviewable files in this PR.",
    );
  }

  const { chunks, oversizedFilePaths } = await enrichDiffWithContext(
    githubService,
    parsedDiff,
    owner,
    repo,
    request.commitSha,
  );
  const oversizedNote = describeFilesNote(
    "Not reviewed because they are too large",
    oversizedFilePaths,
  );
  if (chunks.length === 0) {
    return completeReviewEarly(
      claim,
      startTime,
      oversizedNote ?? "No reviewable content after filtering.",
    );
  }

  return analyzeSaveAndPostReview(context, chunks, parsedDiff, oversizedNote);
}

async function analyzeSaveAndPostReview(
  context: ReviewStepsContext,
  chunks: readonly ReviewChunk[],
  parsedDiff: ParsedDiff,
  oversizedNote: string | null,
): Promise<Result<ReviewEngineResult, StepFailure>> {
  const { claim, request, llmService, settings, startTime } = context;
  const { reviewId } = claim;

  const llmResult = await analyzeAllChunks(
    llmService,
    chunks,
    {
      customInstructions: settings.customInstructions,
      enabledCategories: settings.enabledCategories,
    },
    request.isFinalAttempt,
  );
  if (!llmResult.success) return llmResult;
  const findings = filterFindingsBySettings(llmResult.data.findings, settings);
  const failedAnalysisNote = describeFilesNote(
    "Not reviewed because the analysis failed",
    llmResult.data.unanalyzedFilePaths,
  );
  const truncatedNote = describeFilesNote(
    "The review of these files may be incomplete because the analysis hit its output limit",
    llmResult.data.truncatedFilePaths,
  );
  const summary = [
    describeFindingCount(findings.length),
    oversizedNote,
    failedAnalysisNote,
    truncatedNote,
  ]
    .filter((note) => note !== null)
    .join("\n\n");

  logger.info("LLM analysis complete", {
    jobId: request.jobId,
    repository: request.repositoryFullName,
    findingCount: findings.length,
    droppedBySettings: llmResult.data.findings.length - findings.length,
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
  if (postResult.data === "superseded") {
    return completeSupersededReview(claim, startTime);
  }

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

/**
 * Renews the claim while the review runs, so a slow review (a large pull
 * request or a slow model) is never taken for an abandoned one and expired.
 */
function keepReviewClaimAlive(claim: ReviewClaimRef): () => void {
  return startHeartbeat(
    "review-claim",
    async () => {
      const renewResult = await renewReviewClaim(claim);
      if (!renewResult.success) {
        logger.warn("Failed to renew review claim", {
          reviewId: claim.reviewId,
          error: renewResult.error,
        });
      }
    },
    REVIEW_CLAIM_RENEWAL_INTERVAL_MS,
  );
}

async function runReviewStepsWithFailureGuard(
  context: ReviewStepsContext,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const stopRenewingClaim = keepReviewClaimAlive(context.claim);
  try {
    const result = await runReviewSteps(context);
    if (result.success) return result;
    if ("reason" in result.error) {
      await markReviewFailed(context.claim, result.error.reason);
    }
    return err(result.error.code);
  } catch (error) {
    logger.error("Unexpected error during review", {
      reviewId: context.claim.reviewId,
      repository: context.request.repositoryFullName,
      pullRequest: context.request.pullRequestNumber,
      error: describeError(error),
    });
    await markReviewFailed(context.claim, "Unexpected error during review");
    return err("REVIEW_UNEXPECTED_ERROR");
  } finally {
    stopRenewingClaim();
  }
}

export async function executeReview(
  request: ReviewRequest,
  githubService: GitHubService,
  llmService: LLMService,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const startTime = Date.now();

  const repositoryName = parseRepositoryFullName(request.repositoryFullName);
  if (repositoryName === null) {
    logger.error("Invalid repository full name", {
      fullName: request.repositoryFullName,
    });
    return err("REVIEW_DB_ERROR");
  }
  const { owner, repo } = repositoryName;

  logger.info("Starting review", {
    repository: request.repositoryFullName,
    pullRequest: request.pullRequestNumber,
    commitSha: request.commitSha,
  });

  const repositoryResult = await lookupRepository(request);
  if (!repositoryResult.success) return repositoryResult;

  const { repositoryId, settings } = repositoryResult.data;
  const claimResult = await claimReviewRecord(repositoryId, request);
  if (!claimResult.success) return claimResult;

  return runReviewStepsWithFailureGuard({
    claim: claimResult.data,
    request,
    owner,
    repo,
    githubService,
    llmService,
    settings,
    startTime,
  });
}

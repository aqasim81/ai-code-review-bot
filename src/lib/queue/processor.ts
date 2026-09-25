import { type Job, UnrecoverableError } from "bullmq";
import {
  createJobRecord,
  findLastReviewedCommitSha,
  updateJobRecord,
} from "@/lib/db/queries";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { logger } from "@/lib/logger";
import { reviewJobLogContext } from "@/lib/queue/producer";
import type { ReviewJobData, ReviewJobPayload } from "@/lib/queue/types";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { exponentialDelayMs } from "@/lib/retry";
import { executeReview } from "@/lib/review/engine";
import type { ReviewEngineError } from "@/types/errors";
import type { GitHubService } from "@/types/github";
import type { ReviewRequest } from "@/types/review";

const DELTA_FILE_THRESHOLD = 50;

// Outcomes where retrying cannot help and nothing failed: the review is done,
// another attempt owns it, or the repository is not reviewable.
const SKIPPED_REVIEW_ERRORS: ReadonlySet<ReviewEngineError> = new Set([
  "REVIEW_ALREADY_EXISTS",
  "REVIEW_CLAIM_LOST",
  "REVIEW_REPOSITORY_UNAVAILABLE",
]);

// Failures no retry can fix: GitHub or the model refused the request itself.
const UNRECOVERABLE_REVIEW_ERRORS: ReadonlySet<ReviewEngineError> = new Set([
  "REVIEW_DIFF_UNAVAILABLE",
  "REVIEW_LLM_REJECTED",
  "REVIEW_POST_REJECTED",
]);

// Names the error thrown for a rate-limited review, so the backoff strategy,
// which receives that error, can wait for the limit to reset.
const GITHUB_RATE_LIMITED_ERROR_NAME = "GitHubRateLimitedReviewError";

async function fetchChangedFilesForDelta(
  baseCommitSha: string,
  currentCommitSha: string,
  repositoryFullName: string,
  githubService: GitHubService,
): Promise<readonly string[] | null> {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (parsed === null) return null;

  const comparisonResult = await githubService.compareCommits(
    parsed.owner,
    parsed.repo,
    baseCommitSha,
    currentCommitSha,
  );

  if (!comparisonResult.success) {
    logger.warn("Failed to compare commits for delta review", {
      error: comparisonResult.error,
      repositoryFullName,
      baseSha: baseCommitSha,
      headSha: currentCommitSha,
    });
    return null;
  }

  // Three-dot compare only lists changes since the merge base. When head does
  // not build on the reviewed commit (a force-push rewrote or reset the
  // branch), changes can be missing from that list, so review everything.
  if (
    comparisonResult.data.status === "behind" ||
    comparisonResult.data.status === "diverged"
  ) {
    logger.info("Head does not build on the last reviewed commit", {
      status: comparisonResult.data.status,
      repositoryFullName,
    });
    return null;
  }

  const changedFiles = comparisonResult.data.files.map((f) => f.filename);

  if (changedFiles.length === 0) {
    return [];
  }

  if (changedFiles.length > DELTA_FILE_THRESHOLD) {
    logger.info("Delta file count exceeds threshold, using full review", {
      changedFileCount: changedFiles.length,
      threshold: DELTA_FILE_THRESHOLD,
    });
    return null;
  }

  return changedFiles;
}

async function getOrCreateDbJobId(
  job: Job<ReviewJobData>,
): Promise<string | null> {
  // Reuse the record whenever one was saved: a stalled job re-runs without
  // BullMQ counting an attempt, so attemptsMade alone is not a reliable signal.
  const existingId = job.data.dbJobId;
  if (typeof existingId === "string") return existingId;

  const { type, payload } = job.data;
  const result = await createJobRecord({
    type,
    payload: {
      installationId: payload.installationId,
      repositoryFullName: payload.repositoryFullName,
      pullRequestNumber: payload.pullRequestNumber,
      commitSha: payload.commitSha,
    },
    initialStatus: "PROCESSING",
  });

  if (!result.success) {
    logger.warn("Failed to create job record in database", {
      jobId: job.id,
      error: result.error,
    });
    return null;
  }

  const dbJobId = result.data.id;
  await job.updateData({ ...job.data, dbJobId });
  return dbJobId;
}

async function markJobCompleted(dbJobId: string | null): Promise<void> {
  if (dbJobId === null) return;
  const result = await updateJobRecord(dbJobId, "COMPLETED");
  if (!result.success) {
    logger.warn("Failed to mark job as completed in database", {
      dbJobId,
      error: result.error,
    });
  }
}

async function markJobFailed(
  dbJobId: string | null,
  errorCode: string,
  attemptsMade: number,
): Promise<void> {
  if (dbJobId === null) return;
  const result = await updateJobRecord(dbJobId, "FAILED", {
    lastError: errorCode,
    attempts: attemptsMade,
  });
  if (!result.success) {
    logger.warn("Failed to mark job as failed in database", {
      dbJobId,
      error: result.error,
    });
  }
}

/**
 * Limits a push review to files changed since the last completed review of
 * the pull request. Without one (the earlier review failed or never ran), the
 * whole pull request is reviewed.
 */
async function buildDeltaFilePathFilter(
  payload: ReviewJobPayload,
  githubService: GitHubService,
): Promise<readonly string[] | null> {
  const baseResult = await findLastReviewedCommitSha({
    githubInstallationId: payload.installationId,
    githubRepoId: payload.githubRepoId,
    pullRequestNumber: payload.pullRequestNumber,
  });
  if (!baseResult.success) {
    logger.warn("Failed to find the last reviewed commit, using full review", {
      error: baseResult.error,
      repositoryFullName: payload.repositoryFullName,
    });
    return null;
  }
  if (baseResult.data === null) {
    logger.info(
      "No completed review for this pull request, using full review",
      {
        repositoryFullName: payload.repositoryFullName,
        pullRequest: payload.pullRequestNumber,
      },
    );
    return null;
  }
  // Already reviewed at this commit; the engine will find that review.
  if (baseResult.data === payload.commitSha) return [];
  return fetchChangedFilesForDelta(
    baseResult.data,
    payload.commitSha,
    payload.repositoryFullName,
    githubService,
  );
}

async function buildReviewRequest(
  job: Job<ReviewJobData>,
  jobId: string,
  githubService: GitHubService,
): Promise<ReviewRequest> {
  const { type, payload } = job.data;
  const baseRequest: ReviewRequest = {
    installationId: payload.installationId,
    githubRepoId: payload.githubRepoId,
    repositoryFullName: payload.repositoryFullName,
    pullRequestNumber: payload.pullRequestNumber,
    commitSha: payload.commitSha,
    jobId,
  };

  if (type !== "review-pr-delta") return baseRequest;

  const filePathFilter = await buildDeltaFilePathFilter(payload, githubService);

  if (filePathFilter === null) {
    logger.info("Delta review: falling back to full review", {
      jobId: job.id,
    });
    return baseRequest;
  }

  if (filePathFilter.length === 0) {
    logger.info("Delta review: no files changed since last review", {
      jobId: job.id,
    });
  } else {
    logger.info("Delta review: filtering to changed files", {
      jobId: job.id,
      fileCount: filePathFilter.length,
    });
  }

  return { ...baseRequest, filePathFilter };
}

export async function processReviewJob(job: Job<ReviewJobData>): Promise<void> {
  const { payload } = job.data;
  const jobId = job.id;
  if (jobId === undefined) {
    throw new Error("Review job has no ID; cannot claim a review for it");
  }

  logger.info("Processing review job", {
    ...reviewJobLogContext(job.id, job.data),
    attempt: job.attemptsMade + 1,
  });

  const dbJobId = await getOrCreateDbJobId(job);

  // Jobs queued before the repository ID was added to the payload cannot be
  // matched to a repository safely; the next push or reopen queues a new one.
  if (typeof payload.githubRepoId !== "number") {
    logger.warn("Review job has no repository ID, skipping", {
      jobId: job.id,
    });
    await markJobCompleted(dbJobId);
    return;
  }

  const githubService = createGitHubServiceFromEnv(payload.installationId);
  const llmService = createLlmClient();
  const request = await buildReviewRequest(job, jobId, githubService);
  const result = await executeReview(request, githubService, llmService);

  if (result.success) {
    logger.info("Review job completed successfully", {
      jobId: job.id,
      reviewId: result.data.reviewId,
      issuesFound: result.data.issuesFound,
      processingTimeMs: result.data.processingTimeMs,
    });
    await markJobCompleted(dbJobId);
    return;
  }

  if (SKIPPED_REVIEW_ERRORS.has(result.error)) {
    logger.info("Review has nothing to do, skipping", {
      jobId: job.id,
      reason: result.error,
      commitSha: payload.commitSha,
    });
    await markJobCompleted(dbJobId);
    return;
  }

  logger.error("Review job failed", {
    ...reviewJobLogContext(job.id, job.data),
    error: result.error,
  });
  await markJobFailed(dbJobId, result.error, job.attemptsMade + 1);
  const message = `Review failed: ${result.error}`;
  if (UNRECOVERABLE_REVIEW_ERRORS.has(result.error)) {
    throw new UnrecoverableError(message);
  }
  if (result.error === "REVIEW_GITHUB_RATE_LIMITED") {
    throw Object.assign(new Error(message), {
      name: GITHUB_RATE_LIMITED_ERROR_NAME,
    });
  }
  throw new Error(message);
}

// GitHub's primary rate limit resets hourly; two 30-minute waits between the
// three attempts span a full window.
const GITHUB_RATE_LIMIT_RETRY_DELAY_MS = 30 * 60_000;

export function calculateBackoffDelay(
  attemptsMade: number,
  error?: Error,
): number {
  if (error?.name === GITHUB_RATE_LIMITED_ERROR_NAME) {
    return GITHUB_RATE_LIMIT_RETRY_DELAY_MS;
  }
  return exponentialDelayMs(10_000, 3, attemptsMade);
}

/**
 * A failed job gets no further attempts when it used its last one or threw
 * UnrecoverableError, which BullMQ fails without retrying.
 */
export function isFinalJobFailure(
  job: { readonly attemptsMade: number; readonly opts: { attempts?: number } },
  error: Error,
): boolean {
  if (error instanceof UnrecoverableError) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

import type { Job } from "bullmq";
import { createJobRecord, updateJobRecord } from "@/lib/db/queries";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { logger } from "@/lib/logger";
import type { DeltaReviewJobPayload, ReviewJobData } from "@/lib/queue/types";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { executeReview } from "@/lib/review/engine";
import type { GitHubService } from "@/types/github";
import type { ReviewRequest } from "@/types/review";

const DELTA_FILE_THRESHOLD = 50;

async function fetchChangedFilesForDelta(
  previousCommitSha: string,
  currentCommitSha: string,
  repositoryFullName: string,
  githubService: GitHubService,
): Promise<readonly string[] | null> {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (parsed === null) return null;

  const comparisonResult = await githubService.compareCommits(
    parsed.owner,
    parsed.repo,
    previousCommitSha,
    currentCommitSha,
  );

  if (!comparisonResult.success) {
    logger.warn("Failed to compare commits for delta review", {
      error: comparisonResult.error,
      repositoryFullName,
      baseSha: previousCommitSha,
      headSha: currentCommitSha,
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
  if (job.attemptsMade > 0) {
    const existingId = job.data.dbJobId;
    return typeof existingId === "string" ? existingId : null;
  }

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

function buildDeltaFilePathFilter(
  payload: DeltaReviewJobPayload,
  githubService: GitHubService,
): Promise<readonly string[] | null> {
  return fetchChangedFilesForDelta(
    payload.previousCommitSha,
    payload.commitSha,
    payload.repositoryFullName,
    githubService,
  );
}

async function buildReviewRequest(
  job: Job<ReviewJobData>,
  githubService: GitHubService,
): Promise<ReviewRequest> {
  const { type, payload } = job.data;
  const baseRequest: ReviewRequest = {
    installationId: payload.installationId,
    repositoryFullName: payload.repositoryFullName,
    pullRequestNumber: payload.pullRequestNumber,
    commitSha: payload.commitSha,
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
  const { type, payload } = job.data;

  logger.info("Processing review job", {
    jobId: job.id,
    type,
    repository: payload.repositoryFullName,
    pullRequest: payload.pullRequestNumber,
    attempt: job.attemptsMade + 1,
  });

  const dbJobId = await getOrCreateDbJobId(job);
  const githubService = createGitHubServiceFromEnv(payload.installationId);
  const llmService = createLlmClient();
  const request = await buildReviewRequest(job, githubService);
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

  if (result.error === "REVIEW_ALREADY_EXISTS") {
    logger.info("Review already exists for this commit, skipping", {
      jobId: job.id,
      commitSha: payload.commitSha,
    });
    await markJobCompleted(dbJobId);
    return;
  }

  logger.error("Review job failed", {
    jobId: job.id,
    error: result.error,
    repository: payload.repositoryFullName,
    pullRequest: payload.pullRequestNumber,
  });
  await markJobFailed(dbJobId, result.error, job.attemptsMade + 1);
  throw new Error(`Review failed: ${result.error}`);
}

export function calculateBackoffDelay(attemptsMade: number): number {
  const BASE_DELAY_MS = 10_000;
  const MULTIPLIER = 3;
  return BASE_DELAY_MS * MULTIPLIER ** (attemptsMade - 1);
}

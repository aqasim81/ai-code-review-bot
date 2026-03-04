import type { Job } from "bullmq";
import {
  createJobRecord,
  findLastReviewedCommitForPullRequest,
  updateJobRecord,
} from "@/lib/db/queries";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { logger } from "@/lib/logger";
import type { ReviewJobData } from "@/lib/queue/types";
import { parseRepositoryFullName } from "@/lib/repository-utils";
import { executeReview } from "@/lib/review/engine";
import type { GitHubService } from "@/types/github";
import type { ReviewRequest } from "@/types/review";

const DELTA_FILE_THRESHOLD = 50;

async function buildDeltaFilePathFilter(
  repositoryFullName: string,
  pullRequestNumber: number,
  currentCommitSha: string,
  githubService: GitHubService,
): Promise<readonly string[] | null> {
  const lastReviewResult = await findLastReviewedCommitForPullRequest(
    repositoryFullName,
    pullRequestNumber,
  );

  if (!lastReviewResult.success || lastReviewResult.data === null) {
    return null;
  }

  const lastReviewedSha = lastReviewResult.data.commitSha;
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (parsed === null) return null;

  const comparisonResult = await githubService.compareCommits(
    parsed.owner,
    parsed.repo,
    lastReviewedSha,
    currentCommitSha,
  );

  if (!comparisonResult.success) {
    logger.warn("Failed to compare commits for delta review", {
      error: comparisonResult.error,
      repositoryFullName,
      baseSha: lastReviewedSha,
      headSha: currentCommitSha,
    });
    return null;
  }

  const changedFiles = comparisonResult.data.files.map((file) => file.filename);

  if (changedFiles.length === 0) {
    return null;
  }

  if (changedFiles.length > DELTA_FILE_THRESHOLD) {
    logger.info(
      "Delta review file count exceeds threshold, using full review",
      {
        changedFileCount: changedFiles.length,
        threshold: DELTA_FILE_THRESHOLD,
      },
    );
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
  const jobRecordResult = await createJobRecord({
    type,
    payload: {
      installationId: payload.installationId,
      repositoryFullName: payload.repositoryFullName,
      pullRequestNumber: payload.pullRequestNumber,
      commitSha: payload.commitSha,
    },
    initialStatus: "PROCESSING",
  });

  if (!jobRecordResult.success) {
    logger.warn("Failed to create job record in database", {
      jobId: job.id,
      error: jobRecordResult.error,
    });
    return null;
  }

  const dbJobId = jobRecordResult.data.id;
  await job.updateData({ ...job.data, dbJobId });
  return dbJobId;
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

  let request: ReviewRequest = {
    installationId: payload.installationId,
    repositoryFullName: payload.repositoryFullName,
    pullRequestNumber: payload.pullRequestNumber,
    commitSha: payload.commitSha,
  };

  if (type === "review-pr-delta") {
    const filePathFilter = await buildDeltaFilePathFilter(
      payload.repositoryFullName,
      payload.pullRequestNumber,
      payload.commitSha,
      githubService,
    );

    if (filePathFilter !== null) {
      request = { ...request, filePathFilter };
      logger.info("Delta review: filtering to changed files", {
        jobId: job.id,
        fileCount: filePathFilter.length,
      });
    } else {
      logger.info("Delta review: falling back to full review", {
        jobId: job.id,
      });
    }
  }

  const result = await executeReview(request, githubService, llmService);

  if (result.success) {
    logger.info("Review job completed successfully", {
      jobId: job.id,
      reviewId: result.data.reviewId,
      issuesFound: result.data.issuesFound,
      processingTimeMs: result.data.processingTimeMs,
    });

    if (dbJobId !== null) {
      await updateJobRecord(dbJobId, "COMPLETED");
    }
  } else {
    if (result.error === "REVIEW_ALREADY_EXISTS") {
      logger.info("Review already exists for this commit, skipping", {
        jobId: job.id,
        commitSha: payload.commitSha,
      });

      if (dbJobId !== null) {
        await updateJobRecord(dbJobId, "COMPLETED");
      }
      return;
    }

    logger.error("Review job failed", {
      jobId: job.id,
      error: result.error,
      repository: payload.repositoryFullName,
      pullRequest: payload.pullRequestNumber,
    });

    if (dbJobId !== null) {
      await updateJobRecord(dbJobId, "FAILED", {
        lastError: result.error,
        attempts: job.attemptsMade + 1,
      });
    }

    throw new Error(`Review failed: ${result.error}`);
  }
}

export function calculateBackoffDelay(attemptsMade: number): number {
  const BASE_DELAY_MS = 10_000;
  const MULTIPLIER = 3;
  return BASE_DELAY_MS * MULTIPLIER ** (attemptsMade - 1);
}

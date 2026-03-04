import type { Job } from "bullmq";
import {
  createJobRecord,
  findLastReviewedCommitForPullRequest,
  updateJobRecord,
} from "@/lib/db/queries";
import { env } from "@/lib/env";
import type { GitHubAppCredentials } from "@/lib/github/api";
import { createGitHubService } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { logger } from "@/lib/logger";
import type { ReviewJobData } from "@/lib/queue/types";
import { executeReview } from "@/lib/review/engine";
import type { GitHubService } from "@/types/github";
import type { ReviewRequest } from "@/types/review";

const DELTA_FILE_THRESHOLD = 50;

function buildGitHubCredentials(): GitHubAppCredentials {
  return {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
  };
}

function parseRepositoryFullName(
  fullName: string,
): { owner: string; repo: string } | null {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

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

export async function processReviewJob(job: Job<ReviewJobData>): Promise<void> {
  const { type, payload } = job.data;

  logger.info("Processing review job", {
    jobId: job.id,
    type,
    repository: payload.repositoryFullName,
    pullRequest: payload.pullRequestNumber,
    attempt: job.attemptsMade + 1,
  });

  const jobRecordResult = await createJobRecord({
    type,
    payload: {
      installationId: payload.installationId,
      repositoryFullName: payload.repositoryFullName,
      pullRequestNumber: payload.pullRequestNumber,
      commitSha: payload.commitSha,
    },
  });

  if (!jobRecordResult.success) {
    logger.warn("Failed to create job record in database", {
      jobId: job.id,
      error: jobRecordResult.error,
    });
  }

  const credentials = buildGitHubCredentials();
  const githubService = createGitHubService(
    credentials,
    payload.installationId,
  );
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

    if (jobRecordResult.success) {
      await updateJobRecord(jobRecordResult.data.id, "COMPLETED");
    }
  } else {
    if (result.error === "REVIEW_ALREADY_EXISTS") {
      logger.info("Review already exists for this commit, skipping", {
        jobId: job.id,
        commitSha: payload.commitSha,
      });

      if (jobRecordResult.success) {
        await updateJobRecord(jobRecordResult.data.id, "COMPLETED");
      }
      return;
    }

    logger.error("Review job failed", {
      jobId: job.id,
      error: result.error,
      repository: payload.repositoryFullName,
      pullRequest: payload.pullRequestNumber,
    });

    if (jobRecordResult.success) {
      await updateJobRecord(jobRecordResult.data.id, "FAILED", {
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

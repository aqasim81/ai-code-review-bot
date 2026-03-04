import { Queue } from "bullmq";
import { logger } from "@/lib/logger";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import type {
  DeltaReviewJobPayload,
  ReviewJobData,
  ReviewJobPayload,
} from "@/lib/queue/types";
import { REVIEW_QUEUE_NAME } from "@/lib/queue/types";
import type { QueueError } from "@/types/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

let reviewQueue: Queue | null = null;

function getReviewQueue(): Queue {
  if (reviewQueue === null) {
    reviewQueue = new Queue(REVIEW_QUEUE_NAME, {
      connection: createValkeyConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "custom" },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return reviewQueue;
}

function buildDeterministicJobId(
  repositoryFullName: string,
  pullRequestNumber: number,
  commitSha: string,
): string {
  return `review-${repositoryFullName}-${pullRequestNumber}-${commitSha}`;
}

export async function enqueueReviewJob(
  payload: ReviewJobPayload,
): Promise<Result<{ jobId: string }, QueueError>> {
  const jobData: ReviewJobData = { type: "review-pr", payload };
  const jobId = buildDeterministicJobId(
    payload.repositoryFullName,
    payload.pullRequestNumber,
    payload.commitSha,
  );

  try {
    const job = await getReviewQueue().add("review-pr", jobData, { jobId });

    logger.info("Review job enqueued", {
      jobId: job.id,
      repository: payload.repositoryFullName,
      pullRequest: payload.pullRequestNumber,
      commitSha: payload.commitSha,
    });

    return ok({ jobId: job.id ?? jobId });
  } catch (error) {
    logger.error("Failed to enqueue review job", {
      error: error instanceof Error ? error.message : String(error),
      repository: payload.repositoryFullName,
    });
    return err("QUEUE_ENQUEUE_FAILED");
  }
}

export async function enqueueDeltaReviewJob(
  payload: DeltaReviewJobPayload,
): Promise<Result<{ jobId: string }, QueueError>> {
  const jobData: ReviewJobData = { type: "review-pr-delta", payload };
  const jobId = buildDeterministicJobId(
    payload.repositoryFullName,
    payload.pullRequestNumber,
    payload.commitSha,
  );

  try {
    const job = await getReviewQueue().add("review-pr-delta", jobData, {
      jobId,
    });

    logger.info("Delta review job enqueued", {
      jobId: job.id,
      repository: payload.repositoryFullName,
      pullRequest: payload.pullRequestNumber,
      commitSha: payload.commitSha,
      previousCommitSha: payload.previousCommitSha,
    });

    return ok({ jobId: job.id ?? jobId });
  } catch (error) {
    logger.error("Failed to enqueue delta review job", {
      error: error instanceof Error ? error.message : String(error),
      repository: payload.repositoryFullName,
    });
    return err("QUEUE_ENQUEUE_FAILED");
  }
}

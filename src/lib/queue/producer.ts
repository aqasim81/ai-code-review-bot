import { type DefaultJobOptions, type Job, Queue } from "bullmq";
import { describeError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import type { ReviewJobData, ReviewJobPayload } from "@/lib/queue/types";
import { REVIEW_QUEUE_NAME } from "@/lib/queue/types";
import type { QueueError } from "@/types/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

const globalForQueue = globalThis as unknown as {
  reviewQueue: Queue | undefined;
};

export const REVIEW_JOB_OPTIONS = {
  attempts: 3,
  // Custom backoff: 10s → 30s → 90s. The worker's backoff strategy is
  // calculateBackoffDelay (worker/review-worker.ts).
  backoff: { type: "custom" },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const satisfies DefaultJobOptions;

function getReviewQueue(): Queue {
  if (!globalForQueue.reviewQueue) {
    globalForQueue.reviewQueue = new Queue(REVIEW_QUEUE_NAME, {
      connection: createValkeyConnectionOptions(),
      defaultJobOptions: REVIEW_JOB_OPTIONS,
    });
  }
  return globalForQueue.reviewQueue;
}

// The job type goes after the commit SHA: a fixed-length hex SHA keeps the
// suffix unambiguous, while a prefix could collide with an owner such as
// "delta-x".
const JOB_ID_SUFFIX = {
  "review-pr": "full",
  "review-pr-delta": "delta",
} as const satisfies Record<ReviewJobData["type"], string>;

function buildDeterministicJobId(jobData: ReviewJobData): string {
  const { repositoryFullName, pullRequestNumber, commitSha } = jobData.payload;
  return `review-${repositoryFullName}-${pullRequestNumber}-${commitSha}-${JOB_ID_SUFFIX[jobData.type]}`;
}

/**
 * BullMQ ignores `add()` while a job with the same ID is kept, which would
 * swallow a reopen or redelivery that should reclaim a FAILED review. A job in
 * the failed set is removed so the new one can be added. A waiting, active,
 * delayed or completed job is kept and returned, so the caller can skip the
 * redelivery and say so in the logs.
 */
async function findLiveJobWithSameId(
  queue: Queue,
  jobId: string,
): Promise<Job | null> {
  const existingJob = await queue.getJob(jobId);
  if (!existingJob) return null;
  if (!(await existingJob.isFailed())) return existingJob;

  await existingJob.remove();
  logger.info("Removed failed review job so it can be re-triggered", {
    jobId,
  });
  return null;
}

/** The fields every log line about a review job carries. */
export function reviewJobLogContext(
  jobId: string | undefined,
  jobData: ReviewJobData,
): Record<string, unknown> {
  return {
    jobId,
    type: jobData.type,
    repository: jobData.payload.repositoryFullName,
    pullRequest: jobData.payload.pullRequestNumber,
  };
}

async function enqueueJob(
  jobData: ReviewJobData,
): Promise<Result<{ jobId: string }, QueueError>> {
  const jobId = buildDeterministicJobId(jobData);
  const logContext = {
    ...reviewJobLogContext(jobId, jobData),
    commitSha: jobData.payload.commitSha,
  };

  try {
    const queue = getReviewQueue();
    if (await findLiveJobWithSameId(queue, jobId)) {
      logger.info("Review job already queued or done, skipping", logContext);
      return ok({ jobId });
    }

    const job = await queue.add(jobData.type, jobData, { jobId });
    logger.info("Review job enqueued", logContext);
    return ok({ jobId: job.id ?? jobId });
  } catch (error) {
    logger.error("Failed to enqueue review job", {
      ...logContext,
      error: describeError(error),
    });
    return err("QUEUE_ENQUEUE_FAILED");
  }
}

export async function enqueueReviewJob(
  payload: ReviewJobPayload,
): Promise<Result<{ jobId: string }, QueueError>> {
  return enqueueJob({ type: "review-pr", payload });
}

export async function enqueueDeltaReviewJob(
  payload: ReviewJobPayload,
): Promise<Result<{ jobId: string }, QueueError>> {
  return enqueueJob({ type: "review-pr-delta", payload });
}

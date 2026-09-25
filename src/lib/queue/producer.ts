import { type Job, Queue } from "bullmq";
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

function getReviewQueue(): Queue {
  if (!globalForQueue.reviewQueue) {
    globalForQueue.reviewQueue = new Queue(REVIEW_QUEUE_NAME, {
      connection: createValkeyConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        // Custom backoff: 10s → 30s → 90s. Strategy defined in worker/index.ts via calculateBackoffDelay.
        backoff: { type: "custom" },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
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

async function enqueueJob(
  jobData: ReviewJobData,
): Promise<Result<{ jobId: string }, QueueError>> {
  const { payload } = jobData;
  const jobId = buildDeterministicJobId(jobData);
  const logContext = {
    jobId,
    type: jobData.type,
    repository: payload.repositoryFullName,
    pullRequest: payload.pullRequestNumber,
    commitSha: payload.commitSha,
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
      error: error instanceof Error ? error.message : String(error),
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

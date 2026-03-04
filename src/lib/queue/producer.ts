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

function buildDeterministicJobId(
  repositoryFullName: string,
  pullRequestNumber: number,
  commitSha: string,
): string {
  return `review-${repositoryFullName}-${pullRequestNumber}-${commitSha}`;
}

async function enqueueJob(
  jobData: ReviewJobData,
): Promise<Result<{ jobId: string }, QueueError>> {
  const { payload } = jobData;
  const jobId = buildDeterministicJobId(
    payload.repositoryFullName,
    payload.pullRequestNumber,
    payload.commitSha,
  );

  try {
    const job = await getReviewQueue().add(jobData.type, jobData, { jobId });

    logger.info("Review job enqueued", {
      jobId: job.id,
      type: jobData.type,
      repository: payload.repositoryFullName,
      pullRequest: payload.pullRequestNumber,
      commitSha: payload.commitSha,
    });

    return ok({ jobId: job.id ?? jobId });
  } catch (error) {
    logger.error("Failed to enqueue review job", {
      type: jobData.type,
      error: error instanceof Error ? error.message : String(error),
      repository: payload.repositoryFullName,
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
  payload: DeltaReviewJobPayload,
): Promise<Result<{ jobId: string }, QueueError>> {
  return enqueueJob({ type: "review-pr-delta", payload });
}

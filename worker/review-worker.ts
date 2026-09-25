import { type ConnectionOptions, type Job, type Queue, Worker } from "bullmq";
import { describeError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  calculateBackoffDelay,
  isFinalJobFailure,
  processReviewJob,
  recordFinalJobFailure,
} from "@/lib/queue/processor";
import { reviewJobLogContext } from "@/lib/queue/producer";
import type { ReviewJobData } from "@/lib/queue/types";

export const REVIEW_WORKER_CONCURRENCY = 3;

async function moveToDeadLetterQueue(
  deadLetterQueue: Queue,
  jobId: string | undefined,
  jobData: ReviewJobData,
  errorMessage: string,
): Promise<void> {
  try {
    await deadLetterQueue.add("dead-letter", {
      originalJobId: jobId,
      originalData: jobData,
      error: errorMessage,
      failedAt: new Date().toISOString(),
    });

    logger.error("Job moved to dead letter queue", {
      ...reviewJobLogContext(jobId, jobData),
      error: errorMessage,
    });
  } catch (dlqError) {
    logger.error("Failed to move job to dead letter queue", {
      jobId,
      error: describeError(dlqError),
    });
  }
}

function handleJobCompleted(job: Job<ReviewJobData>): void {
  logger.info("Job completed", reviewJobLogContext(job.id, job.data));
}

async function handleJobFailed(
  deadLetterQueue: Queue,
  job: Job<ReviewJobData> | undefined,
  error: Error,
): Promise<void> {
  if (!job) {
    logger.error("Job failed with no job reference", { error: error.message });
    return;
  }

  if (isFinalJobFailure(job, error)) {
    logger.error("Job permanently failed", {
      ...reviewJobLogContext(job.id, job.data),
      error: error.message,
      attemptsMade: job.attemptsMade,
    });
    await recordFinalJobFailure(job, error);
    await moveToDeadLetterQueue(
      deadLetterQueue,
      job.id,
      job.data,
      error.message,
    );
  } else {
    logger.warn("Job attempt failed, will retry", {
      ...reviewJobLogContext(job.id, job.data),
      error: error.message,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }
}

interface ReviewWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly queueName: string;
  readonly deadLetterQueue: Queue;
  readonly lockDurationMs: number;
  readonly stalledIntervalMs: number;
}

/**
 * A worker that runs review jobs from `queueName`. A job's final failure
 * closes its job record and moves it to the dead letter queue.
 */
export function createReviewWorker(
  options: ReviewWorkerOptions,
): Worker<ReviewJobData> {
  const worker = new Worker<ReviewJobData>(
    options.queueName,
    async (job) => {
      await processReviewJob(job);
    },
    {
      connection: options.connection,
      concurrency: REVIEW_WORKER_CONCURRENCY,
      lockDuration: options.lockDurationMs,
      stalledInterval: options.stalledIntervalMs,
      settings: {
        backoffStrategy: (
          attemptsMade: number,
          _type?: string,
          error?: Error,
        ) => calculateBackoffDelay(attemptsMade, error),
      },
    },
  );

  worker.on("completed", handleJobCompleted);
  worker.on("failed", (job, error) =>
    handleJobFailed(options.deadLetterQueue, job, error),
  );
  worker.on("stalled", (jobId) => logger.warn("Job stalled", { jobId }));
  worker.on("error", (error) =>
    logger.error("Worker error", { error: error.message }),
  );

  return worker;
}

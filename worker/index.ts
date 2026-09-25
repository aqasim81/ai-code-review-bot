import { type Job, Queue, Worker } from "bullmq";
import { describeError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import {
  calculateBackoffDelay,
  isFinalJobFailure,
  processReviewJob,
} from "@/lib/queue/processor";
import { reviewJobLogContext } from "@/lib/queue/producer";
import type { ReviewJobData } from "@/lib/queue/types";
import { DEAD_LETTER_QUEUE_NAME, REVIEW_QUEUE_NAME } from "@/lib/queue/types";
import { expireStaleReviews } from "@/lib/review/stale-reviews";

const CONCURRENCY = 3;
const STALE_INTERVAL_MS = 30_000;
const LOCK_DURATION_MS = 5 * 60 * 1000;
const STALE_REVIEW_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically expires reviews stuck unfinished past the stale cutoff. Safe to
 * run in every worker: each expiry is a guarded, per-review update.
 */
function startStaleReviewSweep(): NodeJS.Timeout {
  let sweepInProgress = false;
  const sweep = (): void => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    expireStaleReviews()
      .catch((error: unknown) => {
        logger.error("Stale review sweep crashed", {
          error: describeError(error),
        });
      })
      .finally(() => {
        sweepInProgress = false;
      });
  };
  sweep();
  return setInterval(sweep, STALE_REVIEW_SWEEP_INTERVAL_MS);
}

function createDeadLetterQueue(): Queue {
  return new Queue(DEAD_LETTER_QUEUE_NAME, {
    connection: createValkeyConnectionOptions(),
  });
}

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

function createReviewWorker(): {
  worker: Worker<ReviewJobData>;
  deadLetterQueue: Queue;
} {
  const connection = createValkeyConnectionOptions();
  const deadLetterQueue = createDeadLetterQueue();

  const worker = new Worker<ReviewJobData>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      await processReviewJob(job);
    },
    {
      connection,
      concurrency: CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALE_INTERVAL_MS,
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
    handleJobFailed(deadLetterQueue, job, error),
  );
  worker.on("stalled", (jobId) => logger.warn("Job stalled", { jobId }));
  worker.on("error", (error) =>
    logger.error("Worker error", { error: error.message }),
  );

  return { worker, deadLetterQueue };
}

async function main(): Promise<void> {
  logger.info("Starting review worker", {
    concurrency: CONCURRENCY,
    queue: REVIEW_QUEUE_NAME,
    lockDurationMs: LOCK_DURATION_MS,
    stalledIntervalMs: STALE_INTERVAL_MS,
  });

  const { worker, deadLetterQueue } = createReviewWorker();
  const staleReviewSweep = startStaleReviewSweep();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Received shutdown signal, closing worker", { signal });
    clearInterval(staleReviewSweep);
    try {
      await worker.close();
      await deadLetterQueue.close();
      logger.info("Worker closed gracefully");
    } catch (shutdownError) {
      logger.error("Shutdown failed", {
        error: describeError(shutdownError),
      });
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Review worker started and listening for jobs");
}

main().catch((error) => {
  logger.error("Worker failed to start", {
    error: describeError(error),
  });
  process.exit(1);
});

import { Queue, Worker } from "bullmq";
import { logger } from "@/lib/logger";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import { calculateBackoffDelay, processReviewJob } from "@/lib/queue/processor";
import type { ReviewJobData } from "@/lib/queue/types";
import { DEAD_LETTER_QUEUE_NAME, REVIEW_QUEUE_NAME } from "@/lib/queue/types";

const CONCURRENCY = 3;
const STALE_INTERVAL_MS = 30_000;
const LOCK_DURATION_MS = 5 * 60 * 1000;

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

    logger.error("Job moved to dead letter queue after exhausting retries", {
      jobId,
      repository: jobData.payload.repositoryFullName,
      pullRequest: jobData.payload.pullRequestNumber,
      error: errorMessage,
    });
  } catch (dlqError) {
    logger.error("Failed to move job to dead letter queue", {
      jobId,
      error: dlqError instanceof Error ? dlqError.message : String(dlqError),
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
        backoffStrategy: (attemptsMade: number) => {
          return calculateBackoffDelay(attemptsMade);
        },
      },
    },
  );

  worker.on("completed", (job) => {
    logger.info("Job completed", {
      jobId: job.id,
      name: job.name,
      repository: job.data.payload.repositoryFullName,
      pullRequest: job.data.payload.pullRequestNumber,
    });
  });

  worker.on("failed", async (job, error) => {
    if (!job) {
      logger.error("Job failed with no job reference", {
        error: error.message,
      });
      return;
    }

    const maxAttempts = job.opts.attempts ?? 3;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;

    if (isFinalAttempt) {
      logger.error("Job permanently failed after exhausting retries", {
        jobId: job.id,
        name: job.name,
        repository: job.data.payload.repositoryFullName,
        pullRequest: job.data.payload.pullRequestNumber,
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
        jobId: job.id,
        repository: job.data.payload.repositoryFullName,
        error: error.message,
        attemptsMade: job.attemptsMade,
        maxAttempts,
      });
    }
  });

  worker.on("stalled", (jobId) => {
    logger.warn("Job stalled", { jobId });
  });

  worker.on("error", (error) => {
    logger.error("Worker error", { error: error.message });
  });

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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Received shutdown signal, closing worker", { signal });
    await worker.close();
    await deadLetterQueue.close();
    logger.info("Worker closed gracefully");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  logger.info("Review worker started and listening for jobs");
}

main().catch((error) => {
  logger.error("Worker failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

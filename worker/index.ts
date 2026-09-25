import { Queue } from "bullmq";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import { expireAbandonedJobRecords } from "@/lib/queue/stale-job-records";
import { DEAD_LETTER_QUEUE_NAME, REVIEW_QUEUE_NAME } from "@/lib/queue/types";
import { expireStaleReviews } from "@/lib/review/stale-reviews";
import { createReviewWorker, REVIEW_WORKER_CONCURRENCY } from "./review-worker";

const STALE_INTERVAL_MS = 30_000;
const LOCK_DURATION_MS = 5 * 60 * 1000;
const STALE_RECORD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically expires reviews and job records left unfinished by a run that
 * stopped renewing them. Safe to run in every worker: each expiry is a
 * guarded, per-record update.
 */
function startStaleRecordSweep(): NodeJS.Timeout {
  let sweepInProgress = false;
  const sweep = (): void => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    expireStaleReviews()
      .then(() => expireAbandonedJobRecords())
      .catch((error: unknown) => {
        logger.error("Stale record sweep crashed", {
          error: describeError(error),
        });
      })
      .finally(() => {
        sweepInProgress = false;
      });
  };
  sweep();
  return setInterval(sweep, STALE_RECORD_SWEEP_INTERVAL_MS);
}

async function main(): Promise<void> {
  logger.info("Starting review worker", {
    concurrency: REVIEW_WORKER_CONCURRENCY,
    queue: REVIEW_QUEUE_NAME,
    lockDurationMs: LOCK_DURATION_MS,
    stalledIntervalMs: STALE_INTERVAL_MS,
    model: env.LLM_MODEL_ID,
  });

  const connection = createValkeyConnectionOptions();
  const deadLetterQueue = new Queue(DEAD_LETTER_QUEUE_NAME, { connection });
  const worker = createReviewWorker({
    connection,
    queueName: REVIEW_QUEUE_NAME,
    deadLetterQueue,
    lockDurationMs: LOCK_DURATION_MS,
    stalledIntervalMs: STALE_INTERVAL_MS,
  });
  const staleRecordSweep = startStaleRecordSweep();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Received shutdown signal, closing worker", { signal });
    clearInterval(staleRecordSweep);
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

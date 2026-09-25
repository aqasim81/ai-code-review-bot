import {
  failAbandonedJobRecord,
  findAbandonedJobRecordIds,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

/**
 * A job record not renewed for longer than this lost its run: the worker died,
 * or the run could not write the record's final status. The owning run renews
 * it every JOB_RECORD_RENEWAL_INTERVAL_MS while it works.
 */
export const ABANDONED_JOB_RECORD_MS = 30 * 60 * 1000;

/** Leaves room for several missed renewals before the cutoff. */
export const JOB_RECORD_RENEWAL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Renewal proves the process is alive, not that the job is progressing. A run
 * still going after this long is taken as hung and stops renewing.
 */
export const JOB_RECORD_MAX_RENEWAL_MS = 3 * 60 * 60 * 1000;

/**
 * Marks job records left unfinished by a run that stopped renewing them as
 * FAILED, so none stays PROCESSING for good. Handles one batch per call; the
 * worker runs it periodically.
 */
export async function expireAbandonedJobRecords(
  now: number = Date.now(),
): Promise<Result<{ expiredCount: number }, "JOB_RECORD_SWEEP_FAILED">> {
  const renewedBefore = new Date(now - ABANDONED_JOB_RECORD_MS);
  const abandonedResult = await findAbandonedJobRecordIds(renewedBefore);
  if (!abandonedResult.success) {
    logger.error("Failed to list abandoned job records", {
      error: abandonedResult.error,
    });
    return err("JOB_RECORD_SWEEP_FAILED");
  }

  let expiredCount = 0;
  for (const dbJobId of abandonedResult.data) {
    const failResult = await failAbandonedJobRecord(dbJobId, renewedBefore);
    if (!failResult.success) {
      logger.error("Failed to expire abandoned job record", {
        dbJobId,
        error: failResult.error,
      });
      continue;
    }
    if (failResult.data) expiredCount += 1;
  }

  if (expiredCount > 0) {
    logger.warn("Expired abandoned job records", { expiredCount });
  }
  return ok({ expiredCount });
}

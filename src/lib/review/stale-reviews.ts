import { failStaleReview, findStaleReviewIds } from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

/**
 * A review whose claim was not renewed for longer than this may be reclaimed by
 * any job, not just a retry of the job that claimed it, and is expired by the
 * sweep. The attempt that holds the claim renews it every
 * REVIEW_CLAIM_RENEWAL_INTERVAL_MS while it runs (up to
 * REVIEW_CLAIM_MAX_RENEWAL_MS), so a slow review is not taken for an abandoned
 * one; a review whose attempt died becomes stale after this long.
 */
export const STALE_PROCESSING_REVIEW_MS = 30 * 60 * 1000;

/** Leaves room for several missed renewals before the stale cutoff. */
export const REVIEW_CLAIM_RENEWAL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Renewal proves the process is alive, not that the review is progressing. A
 * run still going after this long is taken as hung: it stops renewing, and the
 * sweep expires its review once the stale cutoff passes.
 */
export const REVIEW_CLAIM_MAX_RENEWAL_MS = 3 * 60 * 60 * 1000;

/**
 * Marks reviews stuck unfinished past the stale cutoff as FAILED, so the
 * dashboard stops showing them as in progress and the next trigger for the
 * commit can claim them. Handles one batch per call; the worker runs it
 * periodically.
 */
export async function expireStaleReviews(
  now: number = Date.now(),
): Promise<Result<{ expiredCount: number }, "STALE_SWEEP_FAILED">> {
  const staleBefore = new Date(now - STALE_PROCESSING_REVIEW_MS);
  const staleResult = await findStaleReviewIds(staleBefore);
  if (!staleResult.success) {
    logger.error("Failed to list stale reviews", { error: staleResult.error });
    return err("STALE_SWEEP_FAILED");
  }

  let expiredCount = 0;
  for (const reviewId of staleResult.data) {
    const failResult = await failStaleReview(reviewId, staleBefore);
    if (!failResult.success) {
      logger.error("Failed to expire stale review", {
        reviewId,
        error: failResult.error,
      });
      continue;
    }
    if (failResult.data) expiredCount += 1;
  }

  if (expiredCount > 0) {
    logger.warn("Expired stale reviews", { expiredCount });
  }
  return ok({ expiredCount });
}

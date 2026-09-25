import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries");

import { failStaleReview, findStaleReviewIds } from "@/lib/db/queries";
import {
  expireStaleReviews,
  STALE_PROCESSING_REVIEW_MS,
} from "@/lib/review/stale-reviews";
import { err, ok } from "@/types/results";
import { reviewId } from "../../helpers/factories";

const NOW = new Date("2026-09-25T12:00:00Z").getTime();
const CUTOFF = new Date(NOW - STALE_PROCESSING_REVIEW_MS);

describe("expireStaleReviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(failStaleReview).mockResolvedValue(ok(true));
  });

  it("marks every stale review FAILED using the 30-minute cutoff", async () => {
    vi.mocked(findStaleReviewIds).mockResolvedValue(
      ok([reviewId("a"), reviewId("b")]),
    );

    const result = await expireStaleReviews(NOW);

    expect(result).toEqual({ success: true, data: { expiredCount: 2 } });
    expect(findStaleReviewIds).toHaveBeenCalledWith(CUTOFF);
    expect(failStaleReview).toHaveBeenCalledWith(reviewId("a"), CUTOFF);
    expect(failStaleReview).toHaveBeenCalledWith(reviewId("b"), CUTOFF);
  });

  it("does not count a review that was reclaimed before it could be expired", async () => {
    vi.mocked(findStaleReviewIds).mockResolvedValue(
      ok([reviewId("a"), reviewId("b")]),
    );
    vi.mocked(failStaleReview)
      .mockResolvedValueOnce(ok(false))
      .mockResolvedValueOnce(ok(true));

    const result = await expireStaleReviews(NOW);

    expect(result).toEqual({ success: true, data: { expiredCount: 1 } });
  });

  it("keeps going when expiring one review fails", async () => {
    vi.mocked(findStaleReviewIds).mockResolvedValue(
      ok([reviewId("a"), reviewId("b")]),
    );
    vi.mocked(failStaleReview)
      .mockResolvedValueOnce(err("DB down"))
      .mockResolvedValueOnce(ok(true));

    const result = await expireStaleReviews(NOW);

    expect(result).toEqual({ success: true, data: { expiredCount: 1 } });
    expect(failStaleReview).toHaveBeenCalledTimes(2);
  });

  it("returns an error when stale reviews cannot be listed", async () => {
    vi.mocked(findStaleReviewIds).mockResolvedValue(err("DB down"));

    const result = await expireStaleReviews(NOW);

    expect(result).toEqual({ success: false, error: "STALE_SWEEP_FAILED" });
    expect(failStaleReview).not.toHaveBeenCalled();
  });
});

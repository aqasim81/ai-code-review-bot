import type { ReviewId } from "@/types/branded";

/** A review as returned by the GitHub list-reviews endpoint (fields we use). */
export interface ListedPullRequestReview {
  readonly id: number;
  readonly body: string | null;
  readonly user: { readonly login: string; readonly type: string } | null;
}

/**
 * Hidden HTML comment appended to every posted review body. The review ID stays
 * the same across retries, so the marker identifies a review posted by any
 * earlier attempt.
 */
export function buildReviewMarker(reviewId: ReviewId): string {
  return `<!-- code-review-bot:review=${reviewId} -->`;
}

/**
 * Finds the review carrying the marker, written by the app's own bot account,
 * so nobody else can suppress a review by pasting the marker.
 */
export function selectReviewWithMarker(
  reviews: readonly ListedPullRequestReview[],
  marker: string,
  botLogin: string,
): { githubReviewId: number } | null {
  const match = reviews.find(
    (review) =>
      review.user?.login === botLogin &&
      review.body !== null &&
      review.body.includes(marker),
  );
  return match ? { githubReviewId: match.id } : null;
}

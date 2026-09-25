import { describe, expect, it } from "vitest";
import {
  buildReviewMarker,
  selectReviewWithMarker,
} from "@/lib/github/review-marker";
import { reviewId } from "../../helpers/factories";

const BOT_LOGIN = "test-bot[bot]";
const MARKER = buildReviewMarker(reviewId());

function listedReview(
  overrides: Partial<Parameters<typeof selectReviewWithMarker>[0][number]>,
) {
  return {
    id: 1,
    body: `Summary\n\n${MARKER}`,
    user: { login: BOT_LOGIN, type: "Bot" },
    ...overrides,
  };
}

describe("buildReviewMarker", () => {
  it("builds a hidden HTML comment carrying the review ID", () => {
    expect(buildReviewMarker(reviewId("abc"))).toBe(
      "<!-- code-review-bot:review=abc -->",
    );
  });
});

describe("selectReviewWithMarker", () => {
  it("returns the bot's review that carries the marker", () => {
    const reviews = [
      listedReview({ id: 1, body: "unrelated" }),
      listedReview({ id: 2 }),
    ];

    expect(selectReviewWithMarker(reviews, MARKER, BOT_LOGIN)).toEqual({
      githubReviewId: 2,
    });
  });

  it("ignores a review with the marker written by someone else", () => {
    const reviews = [
      listedReview({ user: { login: "some-user", type: "User" } }),
    ];

    expect(selectReviewWithMarker(reviews, MARKER, BOT_LOGIN)).toBeNull();
  });

  it("ignores reviews with no body or no author", () => {
    const reviews = [
      listedReview({ body: null }),
      listedReview({ user: null }),
    ];

    expect(selectReviewWithMarker(reviews, MARKER, BOT_LOGIN)).toBeNull();
  });

  it("does not match the marker of a different review", () => {
    const reviews = [
      listedReview({ body: buildReviewMarker(reviewId("other-review")) }),
    ];

    expect(selectReviewWithMarker(reviews, MARKER, BOT_LOGIN)).toBeNull();
  });
});

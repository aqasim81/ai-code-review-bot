# 0001. Save review findings before posting, and retry FAILED reviews in place

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The review engine (`src/lib/review/engine.ts`) posted the review to GitHub first and then saved
the findings and COMPLETED status in one transaction. If that save failed, the review was FAILED
in the database while its comments were already on the pull request (#16).

Retries did nothing: `reviews` has a unique key on `(repositoryId, commitSha)`, and the
idempotency check treated any existing review, including a FAILED one, as "already exists". The
BullMQ retry was recorded as completed without reviewing anything (#14). Making FAILED reviews
retryable with the old order would have allowed a retry to post the same comments twice.

## Decision

- The engine saves findings and summary with `saveReviewFindings` (one transaction; the review
  stays PROCESSING), then posts to GitHub, then sets COMPLETED with `markReviewCompleted`
  (a single-row update).
- `claimReviewRecord` handles an existing review for the same commit:
  - none → create a PROCESSING review;
  - FAILED → `resetFailedReviewForRetry` moves it back to PROCESSING and deletes the old comments
    in one transaction, guarded by `status = FAILED` so only one job can claim it;
  - PENDING, PROCESSING or COMPLETED → `REVIEW_ALREADY_EXISTS`.

## Consequences

- A failed save never leaves comments on the pull request, because nothing has been posted yet.
- Retries re-run FAILED reviews, including the LLM analysis.
- Known gap: if the post succeeds but `markReviewCompleted` then fails, the review is marked
  FAILED and a retry posts the comments a second time. The window is one single-row update
  after a successful network call.
- Known gap: a worker process killed mid-review leaves the review PROCESSING. Retries skip it.
- `githubCommentId` on review comments is still never filled in.

## Alternatives considered

- **Look up the bot's review on GitHub before posting on a retry.** This is fully idempotent,
  but it needs a new `GitHubService` method, an extra API call, and a reliable way to recognise
  the bot's own review.
- **Store `githubReviewId` right after posting and skip posting on a retry.** This needs a
  migration, and the retry re-runs the LLM, so the saved findings could differ from the posted ones.

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
  - none → create a PROCESSING review, recording the queue job ID (`claimedByJobId`) and
    `processingStartedAt`;
  - COMPLETED → `REVIEW_ALREADY_EXISTS`;
  - otherwise → `claimExistingReview` tries to take it over, in one transaction. The update is
    guarded so that it succeeds only when the review is FAILED; or PROCESSING under the same
    job ID; or PROCESSING or PENDING and started more than 30 minutes ago. It then records the
    new job and start time and the retrying job's pull request number, and clears old
    comments. If the claim does not match, another job owns the review → `REVIEW_ALREADY_EXISTS`.
    *(Added for #23.)* Job IDs are deterministic per repository, PR and commit, and BullMQ runs
    one attempt of a job at a time. A PROCESSING review under the same job ID therefore means
    the earlier attempt died, so the retry can reclaim it at once. The 30-minute cutoff is a
    backstop for reviews claimed by a different job.
- Every claim or create also sets a random `claimToken` (a fence). `saveReviewFindings`,
  `markReviewCompleted` and `failReview` only write while the review is PROCESSING with that
  token, and `isReviewClaimCurrent` is checked right before posting to GitHub. An attempt that
  finds its token replaced returns `REVIEW_CLAIM_LOST` and stops without writing; the processor
  records the job as completed. This matters because BullMQ does not stop a job that lost its
  lock. A retry may reclaim a review while the earlier attempt is still running, and the fence
  keeps the two from overwriting each other. *(Added for #23 and #25.)*
- `failReview` deletes the review's comments and resets `issuesFound` in the same transaction.
  The findings are saved before posting, so a FAILED review would otherwise show findings that
  may never have reached the pull request.

## Consequences

- A failed save never leaves comments on the pull request, because nothing has been posted yet.
- Retries re-run FAILED reviews, including the LLM analysis.
- Known gap: if the post succeeds but `markReviewCompleted` then fails, the review is marked
  FAILED and a retry posts the comments a second time. The window is one single-row update
  after a successful network call.
- Known gap: if GitHub accepts the review but the call then fails (a timeout or 5xx after the
  write), the review is marked FAILED and a retry posts the comments a second time.
- A review left PROCESSING by a killed worker or a failed `failReview` is reclaimed by the next
  attempt of the same job (#23).
- Known gap: the claim check before posting and the post itself are not atomic. An attempt that
  loses its claim in that short window can still post, so the pull request gets a second review.
- Known gap: if the owning job is dead but the review is not yet stale, a new job for the same
  commit is recorded as completed. Nothing reclaims the review until a job arrives after the
  30-minute cutoff.
- `githubCommentId` on review comments is still never filled in.

## Alternatives considered

- **Look up the bot's review on GitHub before posting on a retry.** This is fully idempotent,
  but it needs a new `GitHubService` method, an extra API call, and a reliable way to recognise
  the bot's own review.
- **Store `githubReviewId` right after posting and skip posting on a retry.** This needs a
  migration, and the retry re-runs the LLM, so the saved findings could differ from the posted ones.

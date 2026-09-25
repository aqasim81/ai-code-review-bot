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
    `processingStartedAt`. If another job creates it first, the insert hits the
    `(repositoryId, commitSha)` unique key; `createReviewRecord` maps Prisma's `P2002` to "already
    exists" and the job returns `REVIEW_ALREADY_EXISTS` instead of a database error (#24). The
    losing job does not re-check whether the winner's review has since become claimable; if the
    winner fails in those few milliseconds, its own retry reclaims the review;
  - COMPLETED → `REVIEW_ALREADY_EXISTS`;
  - otherwise → `claimExistingReview` tries to take it over, in one transaction. The update is
    guarded so that it succeeds only when the review is FAILED; or PROCESSING under the same
    job ID; or PROCESSING or PENDING and started more than 30 minutes ago. It then records the
    new job and start time and the retrying job's pull request number, and clears old
    comments. If the claim does not match, another job owns the review → `REVIEW_ALREADY_EXISTS`.
    *(Added for #23.)* Job IDs are deterministic per repository, PR, commit and job type (full or
    delta, added for #39), and BullMQ runs
    one attempt of a job at a time. A PROCESSING review under the same job ID therefore means
    the earlier attempt died or lost its BullMQ lock, so the retry can reclaim it at once; if
    the earlier attempt is still running, the claim token below stops it. The 30-minute cutoff
    is a backstop for reviews claimed by a different job.
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
- If the post succeeds but `markReviewCompleted` then fails, the retry finds the earlier post by
  its marker and completes the review without reposting (#22).
- A review left PROCESSING by a killed worker or a failed `failReview` is reclaimed by the next
  attempt of the same job (#23).
- Every posted review body ends with a hidden marker, `<!-- code-review-bot:review=<reviewId> -->`.
  The review ID stays the same across retries and reclaims. Before posting, the engine lists the
  PR's reviews (`GitHubService.findPostedReview`). If the app's bot account already posted one
  with this marker (the bot login `<slug>[bot]` is read once from `GET /app`, not from
  configuration, so a wrong `GITHUB_APP_SLUG` cannot make the lookup silently miss), the engine does not post again and marks the review COMPLETED. This covers
  a post that reached GitHub but reported failure, and an attempt that posted and was then
  reclaimed. If the lookup fails, the review is marked FAILED rather than risking a duplicate.
  *(Added for #22.)* When the post is skipped, the findings saved by the current attempt are
  kept; they can differ slightly from the ones in the earlier post.
- Known gap: two attempts that both run the lookup before either posts can still both post. The
  claim token does not prevent that. It is rare because a live review can only be taken over by
  a retry of the same job after it lost its BullMQ lock, or by another job after the 30-minute
  stale cutoff, and the two attempts would then have to reach the post within seconds of each
  other.
- The worker runs a sweep (`expireStaleReviews`, at startup and every 5 minutes) that marks
  reviews unfinished past the 30-minute cutoff as FAILED. It drops their saved findings and
  clears their claim token, so an attempt that is somehow still running can no longer write.
  Each expiry is a guarded, per-review update, so a review reclaimed at the same moment is left
  alone and running the sweep in several workers is safe. *(Added for #30.)*
- Known gap: if the owning job is dead but the review is not yet stale, a new job for the same
  commit is still recorded as completed and skipped; the sweep only marks the review FAILED once
  it passes the cutoff.
- Known gap: an expired review is not re-run automatically. The dashboard shows it as FAILED, and
  a reopen or webhook redelivery for the same commit reclaims it. A push creates a new head
  commit, and so a new review. Re-enqueueing from the sweep was left out to avoid retrying a
  review that keeps crashing the worker in a loop.
- BullMQ ignores `add()` while a job with the same ID is kept (the last 100 completed and 500
  failed jobs). Before enqueueing, the producer removes a job with the same ID if it is in the
  failed set, so a reopen or redelivery can reclaim a FAILED review. A waiting, active, delayed
  or completed job is kept, so redeliveries of the same event are still deduped and retries of
  one job keep their ID. If two re-triggers race, the loser may get an enqueue error; the
  winner's job runs. *(Added for #39.)*
- Known gap: a review can be FAILED while its job is completed, when the sweep expired it and
  the running attempt then stopped with `REVIEW_CLAIM_LOST`. A re-trigger of the same job type
  is then deduped until the job leaves the completed set; a trigger of the other type (a reopen
  after a delta review) still reclaims it.
- Known gap: an attempt that passes its pre-post claim check, posts, and is expired before it
  completes leaves the review FAILED with its findings deleted, although the review is on the
  PR. If the review is reclaimed later, the posted-review marker check stops a repost.
- `githubCommentId` on review comments is still never filled in.

## Alternatives considered

- **Look up the bot's review on GitHub before posting on a retry.** This is fully idempotent,
  but it needs a new `GitHubService` method, an extra API call, and a reliable way to recognise
  the bot's own review.
- **Store `githubReviewId` right after posting and skip posting on a retry.** This needs a
  migration, and the retry re-runs the LLM, so the saved findings could differ from the posted ones.

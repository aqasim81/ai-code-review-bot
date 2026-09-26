# 0002. Key reviews by pull request and commit, and order them by event time

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Reviews were unique on `(repositoryId, commitSha)`, so a second pull request at a reviewed
commit was never reviewed, and reclaiming a review could move it between pull requests (#124).
Several writes used the time a job *ran* as if it were the time of the event behind it: the
push-review base was the review that finished last (#128), and a retried job wrote the
repository name it was queued with over a newer one (#127). A push review looked only at files
changed since its base, so files the base left unreviewed stayed unreviewed (#129).

## Decision

- A review is unique on `(repositoryId, pullRequestNumber, commitSha)`.
- The event time is `job.timestamp`: when the job was added, kept across retries and delays.
  The processor passes it as `ReviewRequest.eventReceivedAt`.
- `reviews.headSeenAt` stores it (set on create and on claim). `findPushReviewBase` returns the
  COMPLETED review with the latest `headSeenAt`.
- `repositories.fullNameSeenAt` stores when GitHub reported the name. A write of the name is a
  guarded update that applies only over an older report.
- A review stores `coveredFilePaths` (the PR's files counted as reviewed at its commit) and a
  `settingsFingerprint` (categories, minimum severity, custom instructions). A push review looks
  at files changed since the base plus the PR's files the base did not cover. A different
  fingerprint means a full review.

## Consequences

- Pull requests sharing commits each get a review; a review never changes pull request.
- The base of a push review follows push order, whatever order reviews finish in.
- Failed chunks, files brought in by a base-branch change and files an exclude pattern kept out
  are reviewed by the next push review.
- Existing rows get `headSeenAt = createdAt` and no fingerprint, so each PR's first push review
  after the migration is a full one.
- Oversized and excluded files are never covered and are dropped again on every push review.

## Alternatives considered

- **Resolve the repository's current name from GitHub by ID on each job.** `GET
  /repositories/{id}` is not documented, and it adds a call per job.
- **Order bases by commit ancestry (compare API).** Exact, but one or more GitHub calls per
  candidate base.
- **Store only the unreviewed files of each review.** It misses files that enter the PR
  without a commit on its branch (a base-branch change) and files an exclude pattern kept out.

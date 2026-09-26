# 0003. Keep each chunk's analysis on its review until the review is completed

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

A review sends the pull request to the model in chunks. When a chunk fails with an error a
retry may fix (a rate limit, a timeout, a server error) on an attempt that isn't the job's last,
the engine fails the review and BullMQ retries the whole job. The retry started again from the
first chunk. It paid again for every chunk that had already succeeded, and the repeated input
tokens used up the per-minute limit that may have caused the failure (#143).

## Decision

- A chunk's successful analysis (findings, `truncated`, token usage) is saved in
  `review_chunk_analyses` against the review, keyed by `chunkKey`: a SHA-256 of the chunk, the
  prompt options (enabled categories and custom instructions) and the model ID. A later attempt
  reuses a saved analysis only when the request would be the same. A new push, a settings
  change or another model gives a new key.
- A retry claims the same review (ADR 0001), so it finds what earlier attempts saved. So does
  a re-trigger of a FAILED review.
- Only successes are saved. A failed chunk is sent again, since a retry may fix it. A reply
  cut off at the output limit is a success, so a retry reuses it (still marked truncated, so
  its files stay uncovered) rather than asking the model again.
- Findings on files outside the chunk are dropped before saving (#123), so a saved analysis
  holds only what would be kept.
- A save needs the attempt's current claim, and takes the review's row lock in the same
  transaction. An attempt that lost its claim can't save, and a save can't slip in after the
  review's completion has deleted its analyses.
- Reading or saving analyses is best effort. If the analyses can't be read, every chunk is
  analysed; if one can't be saved, the review goes on. Both are logged.
- `markReviewCompleted` and `markReviewSuperseded` delete the review's analyses in the same
  transaction. `claimExistingReview` keeps them, and so does `failReview`, except on the job's
  final attempt, when no retry will come.
- Stored findings are read back through a schema; a row that no longer parses is ignored and
  its chunk is analysed again. NUL is stripped from stored strings and unpaired surrogates are
  replaced, because jsonb rejects both; token counts are clamped to the integer column.
- Reused chunks count no tokens in the attempt's totals.

## Consequences

- A retry after a failure at chunk 9 of 10 sends two chunks, not ten.
- The key doesn't cover the prompt template. An analysis saved before a deploy that changed
  the prompt is reused by a retry after it.
- One extra read per review and one write per analysed chunk.
- A review that failed on an earlier attempt with an error no retry can fix, or that the
  sweep failed and that never ran again, keeps its analyses until it is re-run. A re-run by a
  new trigger reuses them.

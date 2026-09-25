# Review instructions (apply to every code review, human or automated)

## Passes
Tag every finding with its pass:
- **Bugs:** logic errors, broken edge cases, regressions, error paths, resource cleanup.
- **Security & privacy:** injection, auth and authorization gaps, secrets in code, PII in logs or fixtures.
- **Invariants:** anything that can break a rule listed under "## Invariants" in CLAUDE.md.
- **Compliance with intent:** the change matches its linked intent/spec/plan and phase; nothing unplanned slipped in.

## What Important means here
Important = breaks behaviour, leaks data, breaks an invariant, or contradicts the plan. Style and naming are nits.

## Cap the nits
At most five nits per review; summarise the rest as a count.

## Do not report
Anything the formatter, linter or type checker already enforces; generated files; lockfiles.

## Project-specific focus
- **Scope:** report bugs the diff introduces, and siblings of the fixed bug that the diff leaves unfixed. Do not audit unrelated code nearby; bug hunting happens in planned audits by kind of bug, so it produces a finite list.
- **Check each change against "Known mistakes to avoid" in CLAUDE.md:** NUL and range limits before a database write, status-guarded writes and a final status on every exit path, error classification on external calls, old-file vs new-file line numbers.
- **Risky modules:** `src/lib/queue/processor.ts`, `worker/index.ts` and `src/lib/review/engine.ts` (lifecycle and retries); `src/lib/github/api.ts` and `src/lib/llm/client.ts` (external error handling).
- **Fixes that create new risks:** a change that makes a failure permanent, adds a delay or changes a retry count must say what can now be lost or delayed.

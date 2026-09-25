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
<!-- Add what matters in review for this codebase: domain rules, risky modules, contracts consumers depend on. -->

# AI Code Review Bot

GitHub App that analyzes PRs using AST parsing + LLM analysis to post contextual review comments.

**Docs:** `plans/prd.md` (requirements) | `plans/implementation_plan.md` (build plan) | `plans/checklist.md` (progress) | `plans/phases/` (phase details)

## Status

**Phase 6: Testing & Polish** — Complete. All 6 phases done; now fixing bugs from GitHub Issues. 448 tests across 34 files (unit, integration, invariants) plus Playwright E2E. Coverage: 93% statements, 90% on review/, 97% on llm/.

Behaviour worth knowing that isn't obvious from one file:
- **Model:** set by `LLM_MODEL_ID`, default in `src/lib/env.ts`. The default model thinks by default and thinking counts toward the 16000-token output limit.
- **Repository settings** (categories, minimum severity, exclude globs, custom instructions) shape the prompt: it lists only enabled categories, and the settings filter drops the rest as a backstop. With every category enabled, the prompt must stay byte-for-byte equal to `tests/fixtures/default-system-prompt.txt`.
- **Partial reviews:** a chunk the model rejects, or one still failing on the job's final attempt (`ReviewRequest.isFinalAttempt`), is left out and named in the summary. A reply cut off at the output limit is noted in the summary too.
- **Superseded reviews:** before posting, the engine checks the PR head. A review of a replaced commit is `SUPERSEDED`: not posted, findings dropped, never a base for push (delta) reviews.
- **Final statuses:** a deleted or suspended installation (404/403 on the token request) skips the job. The worker's `failed` handler marks unfinished job records FAILED, because BullMQ fails a job that stalled too often without running the processor.

## Tech Stack

- **Core:** Node.js 22, Next.js 15 (App Router), TypeScript strict, pnpm
- **GitHub:** Octokit + Probot
- **Analysis:** tree-sitter (web-tree-sitter WASM), `@anthropic-ai/sdk`
- **Infra:** PostgreSQL + Prisma, BullMQ + Valkey, Biome (lint + format), Vitest + Playwright

## Code Quality

### Dead Code Policy (CRITICAL)
- NEVER write code that isn't immediately used in the same PR
- NEVER leave unused imports, helper functions "for later", or TODO placeholders
- If you remove/refactor, delete ALL orphaned code: functions, types, constants, files
- Before finishing: verify every export is imported, every function is called, every type is referenced. `pnpm knip` (in `validate` and CI) checks exports, files and dependencies; add an ignore to `knip.ts` only with a comment saying why

### TypeScript & Style
- `strict: true`, zero `any` — use `unknown` + type guards
- Discriminated unions over optional fields; branded types for domain IDs (`InstallationId`, `ReviewId`)
- `as const` for literals, `satisfies` for type-safe assignments; explicit types on public API signatures
- Functional style, pure functions, no classes (except stateful external resources like tree-sitter)
- Early returns over nested if/else; max ~30 lines per function
- Verbose naming: `parseUnifiedDiff` not `parseDiff`, `mapFindingToGitHubPosition` not `mapPosition`

### Error Handling
- Result pattern: `{ success: true, data } | { success: false, error }` — NEVER throw in business logic
- External API calls: try/catch at boundary → convert to Result
- Typed error codes: `type ReviewError = 'DIFF_FETCH_FAILED' | 'AST_PARSE_FAILED' | 'LLM_TIMEOUT' | ...`
- Structured error logging with context (jobId, repoName, prNumber)

### Biome Rules
- Biome for linting AND formatting (not ESLint/Prettier). Run `pnpm biome check --write` before commits
- Double quotes, semicolons, 2-space indent. No barrel files — import directly from source module
- No `console.log` in production code. Import ordering: external → internal absolute → relative

### Dependency Interfaces
- **GitHub API + LLM Client only**: define TypeScript interfaces (`GitHubService`, `LLMService`) in type files. Tests mock against the interface
- **Everything else** (Valkey, Prisma, BullMQ): use `vitest.mock()` directly — no interfaces needed

## Architecture

**Key rule:** `src/lib/` has ZERO Next.js imports — pure TypeScript business logic, fully testable without Next.js runtime.

**Data flow:**
```
Webhook → Route Handler → Validate Signature → Enqueue Job (BullMQ)
  → Worker: Fetch Diff → Parse AST → Build Context → Call LLM → Map Comments → Save Findings → Post Review → Mark Completed
```

**Database:** Prisma ORM exclusively. All queries through `src/lib/db/queries.ts`. Transactions for multi-table writes. Descriptive migration names.

## Environment Variables

- All config goes through `src/lib/env.ts` (Zod-validated) — never raw `process.env` in `src/`
- Import as: `import { env } from "@/lib/env"`
- Never hardcode secrets. `.env.example` is the only committed env file

## Testing

- **Test after implementation** in a separate session — don't mix with coding sessions
- **Unit (Vitest):** all `src/lib/` modules. **Integration (Vitest):** webhook→job, review engine e2e with mocked GitHub+LLM. **E2E (Playwright):** dashboard flows
- **Coverage:** 80%+ on `src/lib/review/` and `src/lib/llm/` (advisory). Critical paths only for components/routes
- Use interface-based mocks for GitHub API and LLM, `vitest.mock()` for everything else

## Git Workflow

- GitHub account `aqasim81`; remote uses the SSH alias `git@github-aqasim81:`. Branch: `feat/`, `fix/`, `chore/` prefix. Conventional commits
- Pre-commit: run `pnpm biome check` and `pnpm type-check`
- **No AI/LLM provider names anywhere** — no "Claude", "Anthropic", "AI-generated", "Co-Authored-By: Claude" in code, comments, commits, docs, prompts, or user-facing strings. Use generic names (`llmClient`, `LLMService`). Only exception: model ID strings in SDK calls. `plans/` directory is exempt

## Key Commands

```bash
pnpm validate         # All checks: lint + type-check + knip + test with coverage
pnpm knip             # Unused files, exports and dependencies (config: knip.ts)
pnpm dev              # Dev server
pnpm biome check --write  # Lint + format fix
pnpm type-check       # tsc --noEmit
pnpm test             # Vitest
```

## Session Workflow

1. Read this CLAUDE.md
2. Read `plans/checklist.md` for current progress
3. Read relevant phase file from `plans/phases/`
4. Check state: `git status`, recent commits
5. Implement in small chunks, commit after each working piece

## Invariants

1. `src/lib/` has zero Next.js imports (pure TypeScript business logic). Enforced by a Biome `noRestrictedImports` override.
2. Webhook signatures are validated before any job is enqueued.
3. All database access goes through `src/lib/db/queries.ts`. Enforced by a Biome `noRestrictedImports` override: only `src/lib/db/` may import the Prisma client, the generated client or `pg` (type-only enum imports from `@/generated/prisma/enums` are fine).
4. Business logic returns the Result type and never throws, except env validation at startup (`src/lib/env.ts`) and the queue processor, which throws so BullMQ retries; external calls are wrapped at the boundary. Enforced by `tests/invariants/no-throw.test.ts`, which scans `src/lib/`; any other throw needs a `// throw-ok: <where it is caught>` comment on the line before.
5. Configuration only through `src/lib/env.ts`; never raw `process.env` in `src/`. Enforced by Biome `noProcessEnv` (off only for `src/lib/env.ts`), a Biome ban on importing `process`/`node:process` in `src/`, and `tests/invariants/config-access.test.ts` for bracket and destructured access.
6. No AI or LLM provider names in code, comments, prompts or user-facing strings, except model IDs, the SDK dependency and its API-key env var. Enforced by `tests/invariants/provider-names.test.ts`, which scans source files in `src/` and `worker/` (including names inside identifiers). `tests/` is not scanned; that test has to name what it looks for.
7. No unused imports or variables (Biome, enforced in CI).

## Workflow
Workflow rules: `.claude/rules/ai-native-workflow.md` (local). Review policy: `REVIEW.md`.

## Known mistakes to avoid
(When the same mistake happens twice, add the correction here.)

- **Text Postgres rejects.** Text from outside (model output, webhook payloads, user input) can contain NUL (`\u0000`), which text and jsonb columns reject, failing the whole write. Strip or reject NUL before storing it (#67, #75).
- **Values outside a column's range.** Numbers from the model (line numbers, confidence) are checked against the column's range before saving; one bad value fails the whole review's save (#55).
- **Records left unfinished.** Every Job and Review status write is guarded by the current status. Every exit path (a returned error, a throw, a stall, an unrecoverable failure, a crash between two writes) leaves a final status (#13, #23, #30, #53, #66).
- **Errors treated alike.** Every external call (GitHub, the model, the queue) classifies its errors as retryable, rate-limited or permanent. A retry must be able to help (#14, #22, #54).
- **Old and new line numbers.** Diff line numbers are either old-file or new-file; never mix them in one format or one lookup (#50, #64).
- **Mocks confirm assumptions.** A test that mocks Postgres, BullMQ, GitHub or the model can't find these bugs. When a fix depends on how the real service behaves (what it rejects, how it fails), check the service's source or docs and cite it in the PR.

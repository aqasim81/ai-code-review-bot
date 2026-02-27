# AI Code Review Bot

GitHub App that analyzes PRs using AST parsing + LLM analysis to post contextual review comments.

**Docs:** `plans/prd.md` (requirements) | `plans/implementation_plan.md` (build plan) | `plans/checklist.md` (progress) | `plans/phases/` (phase details)

## Status

**Phase 2: Core Review Engine** — In Progress. Phase 1 complete. Diff parser and AST parser implemented; context builder, LLM integration, and comment mapper are next.

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
- Before finishing: verify every export is imported, every function is called, every type is referenced

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
  → Worker: Fetch Diff → Parse AST → Build Context → Call LLM → Map Comments → Post Review → Save to DB
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

- GitHub profile: `github-builder`. Branch: `feat/`, `fix/`, `chore/` prefix. Conventional commits
- Pre-commit: run `pnpm biome check` and `pnpm type-check`
- **No AI/LLM provider names anywhere** — no "Claude", "Anthropic", "AI-generated", "Co-Authored-By: Claude" in code, comments, commits, docs, prompts, or user-facing strings. Use generic names (`llmClient`, `LLMService`). Only exception: model ID strings in SDK calls. `plans/` directory is exempt

## Key Commands

```bash
pnpm validate         # All checks: lint + type-check + test with coverage
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

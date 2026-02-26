# AI Code Review Bot — CLAUDE.md

## Project Overview

A GitHub App that analyzes pull requests using AST parsing and LLM-powered analysis to post contextual, actionable review comments. Built with Next.js 15, TypeScript, and Claude API.

**Docs:** Read `plans/prd.md` for full requirements. Read `plans/implementation_plan.md` for phased build plan. See `plans/checklist.md` for implementation progress tracking and `plans/phases/` for individual phase details.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 |
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict mode, zero `any`) |
| GitHub integration | Octokit + Probot |
| AST parsing | tree-sitter (web-tree-sitter WASM) |
| LLM | Anthropic Claude API (`@anthropic-ai/sdk`) |
| Queue | BullMQ + Valkey |
| Database | PostgreSQL + Prisma ORM |
| Linting/Formatting | Biome |
| Testing | Vitest (unit/integration) + Playwright (E2E) |
| Package manager | pnpm |

## Code Quality Rules

### Dead Code Policy (CRITICAL)
- NEVER write code that isn't immediately used by something else in the same PR
- NEVER leave unused imports — if you remove usage, remove the import
- NEVER write helper functions "for later" — write them when they're needed
- NEVER leave TODO/FIXME comments as placeholders for unwritten code — either implement it now or don't write anything
- If you remove a feature or refactor, delete ALL orphaned code: functions, types, constants, files
- Before finishing any task, verify: every export is imported somewhere, every function is called, every type is referenced

### TypeScript Standards
- `strict: true` in tsconfig — no exceptions
- Zero `any` types — use `unknown` + type guards when the type is truly unknown
- Prefer discriminated unions over optional fields for state modeling
- Use `as const` for literal objects, `satisfies` for type-safe assignments
- All function parameters and return types explicitly typed (no inference for public APIs)
- Branded types for domain IDs (e.g., `InstallationId`, `ReviewId`) — not raw strings/numbers

### Code Style
- Functional style: pure functions wherever possible, minimize side effects
- Single responsibility: one module does one thing, one function does one thing
- No classes unless wrapping a stateful external resource (e.g., tree-sitter parser instance)
- Prefer early returns over nested if/else
- Max function length: ~30 lines. If longer, decompose
- Naming: verbose is better than clever. `parseUnifiedDiff` not `parseDiff`, `mapFindingToGitHubPosition` not `mapPosition`

### Error Handling
- Result pattern for business logic: `{ success: true, data } | { success: false, error }` — NEVER throw in business logic
- Only throw for truly exceptional cases (programmer errors, invariant violations)
- All external API calls wrapped in try/catch at the boundary — convert to Result pattern
- Typed error codes: `type ReviewError = 'DIFF_FETCH_FAILED' | 'AST_PARSE_FAILED' | 'LLM_TIMEOUT' | ...`
- Log errors with structured context (jobId, repoName, prNumber) — not just the message

### Biome Configuration
- Use Biome for both linting and formatting (NOT ESLint, NOT Prettier)
- Run `pnpm biome check --write` before committing
- Key rules to follow even without Biome running:
  - No unused variables or imports
  - No `console.log` in production code (use a structured logger)
  - Consistent import ordering: external deps → internal absolute → relative
  - Double quotes for strings, semicolons required, 2-space indent
  - No barrel files (`index.ts` re-exports) — import directly from source module

### Dependency Management for External Services
- **GitHub API and LLM Client**: define TypeScript interfaces (`GitHubService`, `LLMService`) in separate type files. Implementation modules satisfy the interface. Tests provide mock implementations against the same interface.
- **Valkey connection, Prisma client, BullMQ**: no interfaces needed — use `vitest.mock()` in tests. Keep it simple.
- Why: GitHub API and LLM are the two most complex, most-mocked, and most-likely-to-change boundaries. Interfaces pay for themselves there. Everywhere else, it's over-engineering.

## Architecture Patterns

### Project Structure
```
src/
├── app/                    # Next.js App Router (routes, pages, layouts)
│   ├── api/                # API route handlers (webhooks, auth)
│   └── dashboard/          # Dashboard pages
├── lib/                    # Core business logic (NO framework dependencies)
│   ├── github/             # GitHub API integration
│   ├── review/             # Review engine (diff parsing, AST, context building)
│   ├── llm/                # LLM client, prompts, response parsing
│   ├── queue/              # BullMQ job definitions and worker
│   └── db/                 # Prisma query helpers
├── components/             # React components (dashboard UI)
└── types/                  # Shared type definitions
```

### Key Principle: `src/lib/` has ZERO Next.js imports
The `lib/` directory is pure TypeScript business logic. It does not import from `next/*`, does not use React, and does not reference request/response objects. This makes it fully testable without a Next.js runtime.

### Data Flow
```
GitHub Webhook → Route Handler → Validate Signature → Enqueue Job (BullMQ)
                                                            ↓
Worker picks up job → Fetch Diff → Parse AST → Build Context → Call LLM → Map Comments → Post Review
                                                                                              ↓
                                                                                    Save to Database
```

## Database

- Prisma ORM exclusively — never raw SQL
- All queries go through `src/lib/db/queries.ts` — no inline Prisma calls in route handlers or components
- Use transactions for multi-table writes (e.g., creating Review + ReviewComments)
- Migration naming: descriptive (`add_review_confidence_field` not `migration_003`)

## Security & Environment Variables

### Environment Variable Management
- All secrets and configuration MUST go through `src/lib/env.ts` — never use raw `process.env` in `src/`
- `env.ts` uses Zod to validate all env vars at startup — missing or invalid vars crash immediately with a clear error
- Import the typed `env` object: `import { env } from "@/lib/env"`
- Never hardcode secrets, API keys, tokens, passwords, or database URLs in source code

### Adding a New Environment Variable
1. Add the Zod field to the schema in `src/lib/env.ts` (use `.optional()` if the consuming feature isn't built yet; remove `.optional()` when it is)
2. Add the variable with a placeholder to `.env.example`
3. Add the real value to `.env.local` (never committed)

### What Must Never Be Committed
- `.env*` files (only `.env.example` is allowed — enforced by `.gitignore`)
- API keys, tokens, passwords, private keys, webhook secrets
- `*.pem` certificate files
- Any file containing real credentials

## Testing Strategy

### Approach: Test After Implementation
Write implementation first, then write tests in a **separate dedicated session**. This keeps implementation sessions focused and prevents test-writing from diluting code quality.

### What to Test
- **Unit tests (Vitest)**: All modules in `src/lib/` — diff parser, AST parser, context builder, prompt builder, comment mapper, LLM response parser
- **Integration tests (Vitest)**: Webhook handler → job enqueue, review engine end-to-end with mocked GitHub API + LLM
- **E2E tests (Playwright)**: Dashboard flows — install, settings, review history

### Coverage Target
- 80%+ on `src/lib/review/` and `src/lib/llm/` (core business logic) — advisory, not blocking
- Components and route handlers: test the critical paths, don't chase coverage numbers

### Test Quality Rules
- Test behavior, not implementation — if you refactor internals, tests should still pass
- Each test tests ONE thing — one assertion per test (or closely related assertions)
- Test names describe the scenario: `it('returns empty findings when diff has only deleted files')`
- Use real-ish fixture data (actual GitHub diff format, actual LLM response shape) — not `{ foo: 'bar' }`
- For GitHub API and LLM mocks: use the interface-based mocks, not `vitest.mock()` path hacking

## Git Workflow

- GitHub profile: `github-builder`
- Branch naming: `feat/`, `fix/`, `chore/` prefix
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- One commit per logical change
- Run `pnpm biome check` before every commit
- Run `pnpm type-check` before every commit
- Never commit `.env*` files (only `.env.example`), `node_modules/`, or generated Prisma client — see "Security & Environment Variables" section

## Commands

```bash
pnpm dev              # Start Next.js dev server
pnpm build            # Production build
pnpm type-check       # tsc --noEmit
pnpm biome check      # Lint + format check
pnpm biome check --write  # Lint + format fix
pnpm test             # Run Vitest
pnpm test:coverage    # Run Vitest with coverage
pnpm test:e2e         # Run Playwright
pnpm db:migrate       # Run Prisma migrations
pnpm db:generate      # Generate Prisma client
pnpm db:studio        # Open Prisma Studio
pnpm worker           # Start BullMQ worker process
```

## Session Workflow

When starting a new session:
1. Read this CLAUDE.md
2. Read `plans/checklist.md` to see current progress and next phase
3. Read the relevant phase file from `plans/phases/` for detailed requirements
4. Read `plans/prd.md` if you need broader requirements context
5. Check the current state: `git status`, review recent commits
6. Implement in small chunks, commit after each working piece

## Common Pitfalls to Avoid

1. **Don't write "utility" files preemptively** — create utilities when you have 3+ call sites, not before
2. **Don't add error handling for impossible states** — if a function only receives validated input, don't re-validate
3. **Don't add comments that restate the code** — `// parse the diff` above `parseDiff()` is noise
4. **Don't create abstraction layers for single implementations** — one GitHub provider doesn't need a provider pattern
5. **Don't import something you don't use in the same file** — if a refactor removes usage, remove the import in the same commit
6. **Don't leave `console.log` in production code** — use structured logging or remove it
7. **Don't write types that are never referenced** — if you define `type Foo`, something must use `Foo`

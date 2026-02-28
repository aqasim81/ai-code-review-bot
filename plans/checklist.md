# AI Code Review Bot — Implementation Checklist

> **Workflow per phase:** Plan → Review Plan → Implement → Review Implementation → Test → Fix → Update Checklist → Next Phase
>
> **Reference:** [PRD](./prd.md) | [Full Implementation Plan](./implementation_plan.md) | [Project Overview](./project.md)

---

## Phase 1: Project Scaffolding & GitHub App Setup

**Plan:** [phase-1-scaffolding-and-github-app.md](./phases/phase-1-scaffolding-and-github-app.md)

### Workflow

- [x] **Planning** — Read the phase file, understand requirements, identify dependencies
- [x] **Review the plan** — Verify approach before coding, clarify any unknowns
- [x] **Implement the plan**
  - [x] Initialize Next.js project with TypeScript, App Router, Tailwind CSS
  - [x] Configure `tsconfig.json` with strict mode
  - [x] Install all core dependencies
  - [x] Create Prisma schema (Installation, Repository, Review, ReviewComment, Job)
  - [x] Set up PostgreSQL connection and run initial migration
  - [ ] Register GitHub App and configure `.env`
  - [x] Create webhook endpoint (`src/app/api/webhooks/github/route.ts`)
  - [x] Implement webhook signature verification
  - [x] Implement event routing (pull_request.opened, synchronize, installation.created)
- [x] **Review the implementation** — Code review for quality, security, adherence to CLAUDE.md standards
- [x] **Test the implementation** — Verify webhook receives events, signature verification works, DB schema is correct
- [x] **Fix if required** — Address any issues found during review/testing
- [x] **Update checklist** — Mark completed items above
- [x] **Ask to implement next phase**

---

## Phase 2: Core Review Engine

**Plan:** [phase-2-core-review-engine.md](./phases/phase-2-core-review-engine.md)

### Workflow

- [x] **Planning** — Read the phase file, understand requirements, identify dependencies
- [x] **Review the plan** — Verify approach before coding, clarify any unknowns
- [x] **Implement the plan**
  - [x] Build diff parser — parse unified diffs, extract hunks, handle edge cases
  - [x] Build AST parser — initialize tree-sitter WASM, load language grammars, extract structure
  - [x] Build context builder — enrich diffs with AST context, chunk for LLM limits
  - [x] Build LLM prompts — system prompt, category sections, few-shot examples, output schema
  - [x] Build LLM client — SDK integration, retry logic, response parsing
  - [x] Build LLM response parser — extract structured findings, filter by confidence
- [x] **Review the implementation** — Code review for quality, security, adherence to CLAUDE.md standards
- [x] **Test the implementation** — Verify diff parsing, AST extraction, LLM integration with sample data
- [x] **Fix if required** — Address any issues found during review/testing
- [x] **Update checklist** — Mark completed items above
- [x] **Ask to implement next phase**

---

## Phase 3: GitHub Review Posting

**Plan:** [phase-3-github-review-posting.md](./phases/phase-3-github-review-posting.md)

### Workflow

- [x] **Planning** — Read the phase file, understand requirements, identify dependencies
- [x] **Review the plan** — Verify approach before coding, clarify any unknowns
- [x] **Implement the plan**
  - [x] Build comment mapper — map LLM findings to GitHub diff positions
  - [x] Build review poster — post inline comments and summary via GitHub API
  - [x] Build review orchestrator — wire full pipeline (fetch → parse → AST → LLM → post)
  - [x] Implement error handling with graceful degradation at each pipeline step
  - [x] Implement idempotency — skip if review exists for commit SHA
  - [x] Save review records and comments to database
- [x] **Review the implementation** — Code review for quality, security, adherence to CLAUDE.md standards
- [x] **Test the implementation** — End-to-end test: webhook → review comments appear on PR
- [x] **Fix if required** — Address any issues found during review/testing
- [x] **Update checklist** — Mark completed items above
- [ ] **Ask to implement next phase**

---

## Phase 4: Background Processing

**Plan:** [phase-4-background-processing.md](./phases/phase-4-background-processing.md)

### Workflow

- [ ] **Planning** — Read the phase file, understand requirements, identify dependencies
- [ ] **Review the plan** — Verify approach before coding, clarify any unknowns
- [ ] **Implement the plan**
  - [ ] Set up BullMQ with Valkey connection
  - [ ] Define job types (`review-pr`, `review-pr-delta`) and concurrency limits
  - [ ] Build standalone worker process (`worker/index.ts`)
  - [ ] Implement retry logic — 3 attempts with exponential backoff
  - [ ] Implement dead letter queue for permanently failed jobs
  - [ ] Implement stale job detection (fail if processing > 5 minutes)
  - [ ] Implement delta reviews — review only files changed since last reviewed commit
- [ ] **Review the implementation** — Code review for quality, security, adherence to CLAUDE.md standards
- [ ] **Test the implementation** — Verify queue processing, retry behavior, delta review correctness
- [ ] **Fix if required** — Address any issues found during review/testing
- [ ] **Update checklist** — Mark completed items above
- [ ] **Ask to implement next phase**

---

## Phase 5: Dashboard UI

**Plan:** [phase-5-dashboard-ui.md](./phases/phase-5-dashboard-ui.md)

### Workflow

- [ ] **Planning** — Read the phase file, understand requirements, identify dependencies
- [ ] **Review the plan** — Verify approach before coding, clarify any unknowns
- [ ] **Implement the plan**
  - [ ] Implement GitHub OAuth flow for dashboard authentication
  - [ ] Implement session management
  - [ ] Build installation flow — landing page, install button, OAuth callback, redirect
  - [ ] Build repository settings page — repo list, enable/disable, category config, exclusion patterns
  - [ ] Build review history page — list reviews, filter by repo/date/severity
  - [ ] Build review detail view — summary, comments, link to PR, stats
- [ ] **Review the implementation** — Code review for quality, security, adherence to CLAUDE.md standards
- [ ] **Test the implementation** — Verify OAuth flow, settings persistence, review history display
- [ ] **Fix if required** — Address any issues found during review/testing
- [ ] **Update checklist** — Mark completed items above
- [ ] **Ask to implement next phase**

---

## Phase 6: Testing & Polish

**Plan:** [phase-6-testing-and-polish.md](./phases/phase-6-testing-and-polish.md)

### Workflow

- [ ] **Planning** — Read the phase file, understand requirements, identify dependencies
- [ ] **Review the plan** — Verify approach before coding, clarify any unknowns
- [ ] **Implement the plan**
  - [ ] Write unit tests — diff parser, AST parser, context builder, prompts, comment mapper
  - [ ] Write integration tests — webhook handler, review pipeline end-to-end
  - [ ] Write E2E tests — dashboard login, repo settings, review history
  - [ ] Write README.md — overview, architecture diagram, setup instructions
  - [ ] Create `.env.example` with all required variables documented
  - [ ] Verify 80%+ coverage on `src/lib/review/` and `src/lib/llm/`
- [ ] **Review the implementation** — Code review for test quality, coverage gaps, documentation accuracy
- [ ] **Test the implementation** — Run full test suite, verify all passing
- [ ] **Fix if required** — Address any issues found during review/testing
- [ ] **Update checklist** — Mark completed items above
- [ ] **Project complete** — Final review and showcase preparation

# Changelog

## Phase 6: Testing & Polish
- Added 151 tests across 10 test files (unit + integration)
- Unit tests: diff-parser (27), ast-parser (13), context-builder (16), comment-mapper (18), LLM parser (17), prompts (11), client (11)
- Integration tests: webhook-handler (12), review-pipeline (13), queue-processor (13)
- E2E tests with Playwright for landing page and auth redirects
- Test infrastructure: setup.ts (global env/logger mocks), factories.ts, fixtures
- Coverage: 87.7% statements, 74.3% branches, 95.5% functions, 87.9% lines
- Added README.md with architecture diagram and setup guide
- Added playwright.config.ts

## Phase 5: Dashboard UI
- Auth.js v5 GitHub OAuth with JWT sessions
- Middleware route protection for /dashboard/*
- Dashboard with installation overview and stats cards
- Repository settings (categories, severity, exclusions, custom instructions)
- Review history with filtering by repo/status and pagination
- Review detail view with comments grouped by file

## Phase 4: Background Processing
- BullMQ job queue with Valkey connection
- Standalone worker process (worker/index.ts)
- Job types: review-pr, review-pr-delta
- Retry logic with exponential backoff (3 attempts)
- Dead letter queue for permanently failed jobs
- Delta reviews: only review files changed since last reviewed commit

## Phase 3: GitHub Review Posting
- Comment mapper: map LLM findings to GitHub diff positions
- Review poster: post inline comments and summary via GitHub API
- Review orchestrator: full pipeline (fetch -> parse -> AST -> LLM -> post)
- Idempotency: skip if review exists for commit SHA
- Save review records and comments to database

## Phase 2: Core Review Engine
- Diff parser: parse unified diffs, extract hunks, handle edge cases
- AST parser: tree-sitter WASM, language grammars, structure extraction
- Context builder: enrich diffs with AST context, chunk for LLM limits
- LLM prompts: system prompt, category sections, output schema
- LLM client: SDK integration, retry logic, response parsing

## Phase 1: Project Scaffolding & GitHub App Setup
- Next.js 15 with TypeScript strict, App Router, Tailwind CSS
- Prisma schema: Installation, Repository, Review, ReviewComment, Job
- PostgreSQL connection with Docker Compose
- Webhook endpoint with signature verification
- Event routing for pull_request and installation events
